// موزع رسائل ماسنجر/انستغرام — نفس خط أنابيب واتساب عبر طبقة القنوات.
// يبني ctx من UniversalMessage ويعيد استخدام نفس المعالجات (امتثال/طاقم/
// طلبات/حجز/ذكاء) — الإرسال يتوجه تلقائياً للقناة عبر sendCh*.
// ملاحظات v1 الصادقة:
//  - الطلبات/الحجوزات تُنشأ وتُدار (تذكيرها يصل نفس القناة).
//  - إيصال الصور: إقرار + حفظ بالسجل فقط (التحقق AI الآلي واتساب حالياً).
//  - سجل الطلبات منفصل لكل قناة (لا ربط هوية بعد — خارطة المرحلة 2).
import { resolveTenant } from "../../../../tenants.mjs";
import { getChannel } from "../../../channels/registry.mjs";
import { checkLimit, senderKey } from "../../../security/rateLimit.mjs";
import { getHistory, pushHistory, isDuplicateMessageAsync } from "../../../memory/conversations.mjs";
import { getBookingState } from "../../../../bookings.mjs";
import { logEvent } from "../../../../crm.mjs";
import { voiceQueue } from "../../../jobs/queue.mjs";
import { transcribeAudio } from "../../../../voice.mjs";
import { sendChText } from "../../../channels/send.mjs";
import { handleCompliance, handleStaff } from "./handlers/compliance.mjs";
import { handleCancelIntent, handleOrderQuery, handleCsat } from "./handlers/orders.mjs";
import { handleProductButtons, handleAi } from "./handlers/ai.mjs";
import { handleBooking } from "./handlers/booking.mjs";

async function fetchBuffer(url, maxBytes = 8 * 1024 * 1024) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > maxBytes) throw new Error("الملف أكبر من المسموح");
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

export async function processMessagingBody(body, channelId) {
  const ch = getChannel(channelId);
  try {
    const entries = body.entry || [];
    let hasMessage = false;
    for (const entry of entries) {
      for (const ev of entry.messaging || []) {
        // تسليم/قراءة — ليست رسائل
        if (ev.delivery || ev.read || ev.reaction) continue;
        const senderId = ev.sender?.id;
        const pageId = ev.recipient?.id;
        if (!senderId || !pageId) continue;
        // صدى صفحتنا نفسها (رسائلنا الصادرة ترجع كـ echo) — تجاهل
        if (ev.message?.is_echo) continue;

        const tenant = await resolveTenant({ pageId, channel: channelId });
        if (!tenant) {
          console.log(`  ⛔ [${channelId}] هوية غير مسجلة (${pageId}) — تجاهل`);
          continue;
        }
        if (tenant.enabled === false || tenant.trialExpired) {
          console.log(`  ⏸️ tenant موقوف/منتهي: ${tenant.id} - تم تجاهل الرسالة`);
          continue;
        }

        const mid = ev.message?.mid || ev.postback?.mid || null;
        if (mid && (await isDuplicateMessageAsync(`${channelId}:${mid}`))) {
          console.log(`  🔁 رسالة مكررة [${channelId}] (id=${mid}) - تم تجاهلها`);
          continue;
        }
        hasMessage = true;

        try {
          const from = ch.normalizeSender(senderId);
          const rl = checkLimit(senderKey(from), 30, 60 * 1000);
          if (!rl.allowed) {
            console.warn(`  ⏱️ تجاوز الحد من ${from} — تم التجاهل (${rl.retryAfter}ث)`);
            continue;
          }
          const extracted = ch.extractText(ev);
          let text = extracted.text;
          const buttonId = extracted.buttonId;
          const name = extracted.name;
          const media = ch.extractMedia(ev);

          const ctx = { msg: ev, contacts: [], tenant, from, name, text, buttonId, media, channel: ch, result: null, wantsBooking: false, bookingState: null };

          // فويس: تفريغ عبر نفس المحرك (الرابط مباشر من الحدث)
          if (media?.kind === "audio" && !text) {
            try {
              console.log(`  🎤 فويس [${channelId}] من ${from} - جاري التفريغ...`);
              const { text: transcript, reason } = await voiceQueue.run(`voice:${channelId}:${mid || `${from}:${Date.now()}`}`, async () => {
                const buffer = await fetchBuffer(media.id);
                return transcribeAudio(buffer, "audio/ogg", (tenant?.languages || ["ar", "en"]).join(","));
              });
              if (transcript) {
                ctx.text = transcript;
                text = transcript;
                console.log(`  🎤 تفريغ: "${text}"`);
              } else {
                console.log(`  ⚠️ تعذر التفريغ (${reason})`);
                await sendChText(ctx, "وصلني الفويس يا غالي 🎤 بس ما قدرت أفرغه، ابعتلي كتابة لو سمحت.").catch(() => {});
                console.log(`${"─".repeat(60)}\n`);
                continue;
              }
            } catch (e) {
              console.error(`  ❌ خطأ الفويس: ${e.message}`);
              await sendChText(ctx, "ما قدرت أسمع الفويس، ابعتلي كتابة يا غالي.").catch(() => {});
              console.log(`${"─".repeat(60)}\n`);
              continue;
            }
          }

          // صور/ملفات: إقرار صريح + سجل (التحقق الآلي للإيصالات واتساب حالياً)
          if (media && (media.kind === "image" || media.kind === "document") && !ctx.text) {
            const reply = `وصلتني الصورة يا غالي 📸 حفظتها بملفك. لو هاي لقطة تحويل لطلب، ابعتها مع رقم الطلب على واتساب للتحقق التلقائي ✨`;
            await pushHistory(from, "user", "[صورة]", tenant);
            await pushHistory(from, "assistant", reply, tenant);
            logEvent("media_received", { tenantId: tenant.id, phone: from, channel: channelId }).catch(() => {});
            await sendChText(ctx, reply).catch((e) => console.error(`  ❌ فشل الإرسال: ${e.message}`));
            console.log(`  📸 وسائط [${channelId}] من ${from} (إقرار فقط)`);
            console.log(`${"─".repeat(60)}\n`);
            continue;
          }

          if (!ctx.text) {
            console.log(`  📥 حدث بلا نص [${channelId}] من ${from} - تم تجاهله`);
            continue;
          }

          if (await handleCompliance(ctx)) continue;

          console.log(`\n${"─".repeat(60)}`);
          console.log(`  🏢 tenant=${tenant?.id} | بوت=${tenant?.botName} | قناة=${channelId}`);
          console.log(`  📥 رسالة [${channelId}] من ${name} (${from}): "${ctx.text}"${buttonId ? ` [btn=${buttonId}]` : ""}`);
          console.log(`  🧠 الذاكرة: ${(await getHistory(from, tenant)).length} رسائل سابقة`);

          if (await handleStaff(ctx)) continue;
          if (await handleCancelIntent(ctx)) continue;
          if (await handleOrderQuery(ctx)) continue;
          if (await handleCsat(ctx)) continue;

          ctx.wantsBooking = tenant?.features?.booking && /(حجز|موعد|احجز|book|appointment)/i.test(ctx.text + " " + (buttonId || ""));
          ctx.bookingState = await getBookingState(tenant?.id, from);
          if (await handleProductButtons(ctx)) continue;
          if (await handleBooking(ctx)) continue;

          await handleAi(ctx);
          console.log(`${"─".repeat(60)}\n`);
        } catch (msgErr) {
          console.error(`  ❌ خطأ معالجة رسالة [${channelId}] ${mid || "؟"}: ${msgErr?.message || msgErr}`);
        }
      }
    }
    if (!hasMessage) {
      console.log(`  📥 POST /webhook [${channelId}] - لا رسائل جديدة`);
    }
  } catch (err) {
    console.error(`  ❌ خطأ معالجة [${channelId}]: ${err.message}`, err.stack);
  }
}
