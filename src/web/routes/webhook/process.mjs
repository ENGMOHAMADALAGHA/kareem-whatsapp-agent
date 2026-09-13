// الموزع الرئيسي: حلقة entries/changes/messages + درع لكل رسالة + ترتيب المعالجات
// الترتيب محفوظ كما كان في webhook.mjs الأصلي — أي تغيير بالترتيب يغير السلوك.
import { resolveTenant } from "../../../../tenants.mjs";
import { normalizePhone } from "../../../utils/phone.mjs";
import { checkLimit, senderKey } from "../../../security/rateLimit.mjs";
import { getHistory, isDuplicateMessageAsync } from "../../../memory/conversations.mjs";
import { getBookingState } from "../../../../bookings.mjs";
import { logEvent } from "../../../../crm.mjs";
import { handleVoice, handleReceiptImage } from "./handlers/media.mjs";
import { handleCompliance, handleStaff } from "./handlers/compliance.mjs";
import { handleCancelIntent, handleOrderQuery, handleCsat } from "./handlers/orders.mjs";
import { handleProductButtons, handleAi } from "./handlers/ai.mjs";
import { handleBooking } from "./handlers/booking.mjs";

export async function processWebhookBody(body) {
  try {
    const entries = body.entry || [];

    let hasMessage = false;

    for (const entry of entries) {
      const changes = entry.changes || [];
      for (const change of changes) {
        const value = change.value || {};
        const messages = value.messages || [];
        const contacts = value.contacts || [];

        // حل الـ tenant من رقم البوت المستقبل (عزل تام)
        const phoneNumberId = value.metadata?.phone_number_id || value.phone_number_id || null;
        const tenant = await resolveTenant({ phoneNumberId });
        if (tenant && (tenant.enabled === false || tenant.trialExpired)) {
          console.log(`  ⏸️ tenant موقوف/منتهي: ${tenant.id} - تم تجاهل الرسالة`);
          continue;
        }
        // عزل تام (الدفاع الأعمق): أي دفعة بلا رقم بوت مسجل نتجاهلها كاملةً —
        // (أ) رقم غير مسجل → null من resolveTenant (ب) رقم غائب → لا يشترط كريم الافتراضي.
        // بدون هذا، رسائل غريبة بلا phone_number_id كانت تسلك لكريم (تسريب مستأجرين).
        if (!tenant || !phoneNumberId) {
          const why = !phoneNumberId ? "phone_number_id غائب في الدفعة" : `رقم بوت غير مسجل (${phoneNumberId})`;
          console.log(`  ⛔ دفعة بلا tenant مسجل — ${why} — تجاهل كامل`);
          continue;
        }

        for (const msg of messages) {
          // منع التكرار: نفس الـ wamid لا يُعالج مرتين أبداً (دائم عبر restart)
          if (msg.id && (await isDuplicateMessageAsync(msg.id))) {
            console.log(`  🔁 رسالة مكررة (id=${msg.id}) - تم تجاهلها`);
            continue;
          }
          hasMessage = true;

          // درع لكل رسالة على حدة: تعثّر رسالة ما يجب ألا يُسقط باقي دفعة Meta
          try {
          // استخراج رقم العميل ونص الرسالة (يدعم الأزرار + الفويس)
          const from = normalizePhone(msg.from); // رقم العميل — موحد E.164 دائماً
          // حد المعدل: 30 رسالة/دقيقة لكل رقم (حماية من الحلقات وتكلفة AI)
          const rl = checkLimit(senderKey(from), 30, 60 * 1000);
          if (!rl.allowed) {
            console.warn(`  ⏱️ تجاوز الحد من ${from} — تم التجاهل (${rl.retryAfter}ث)`);
            continue;
          }
          let text =
            msg.text?.body ||
            msg.button?.text ||
            msg.interactive?.button_reply?.title ||
            msg.interactive?.button_reply?.id ||
            msg.interactive?.list_reply?.title ||
            "";
          const buttonId = msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id || null;
          const name = contacts.find((c) => c.wa_id === from)?.profile?.name || from;

          const ctx = { msg, contacts, tenant, from, name, text, buttonId, result: null, wantsBooking: false, bookingState: null };

          // وسائط: فويس (يحوّل لنص ويكمل) + صور إيصالات (تعالج وتغلق)
          if (await handleVoice(ctx)) continue;
          text = ctx.text;
          if (await handleReceiptImage(ctx)) continue;

          if (!ctx.text) {
            console.log(`  📥 رسالة بدون نص من ${from} (type=${msg.type}) - تم تجاهلها`);
            continue;
          }

          // امتثال واتساب قبل أي منطق
          if (await handleCompliance(ctx)) continue;

          console.log(`\n${"─".repeat(60)}`);
          console.log(`  🏢 tenant=${tenant?.id} | بوت=${tenant?.botName}`);
          console.log(`  📥 رسالة واتساب من ${name} (${from}): "${ctx.text}"${buttonId ? ` [btn=${buttonId}]` : ""}`);
          console.log(`  🧠 الذاكرة: ${(await getHistory(from, tenant)).length} رسائل سابقة`);

          // أزرار منتجات كريم قبل الفرز (كما كانت)
          if (await handleProductButtons(ctx)) continue;

          // طاقم + takeover قبل أي منطق تجاري
          if (await handleStaff(ctx)) continue;

          // طلبات: نسيان + استعلام + تقييم
          if (await handleCancelIntent(ctx)) continue;
          if (await handleOrderQuery(ctx)) continue;
          if (await handleCsat(ctx)) continue;

          // —— تدفق الحجز (للعيادات) قبل الـ AI ——
          ctx.wantsBooking = tenant?.features?.booking && /(حجز|موعد|احجز|book|appointment)/i.test(ctx.text + " " + (buttonId || ""));
          ctx.bookingState = await getBookingState(tenant?.id, from);
          if (await handleBooking(ctx)) continue;

          // —— المسار العادي: AI ——
          await handleAi(ctx);

          console.log(`${"─".repeat(60)}\n`);
          } catch (msgErr) {
            console.error(`  ❌ خطأ معالجة رسالة ${msg?.id || "؟"}: ${msgErr?.message || msgErr}`);
          }
        }

        // تجاهل حالات statuses (delivered/read) بدون رسائل
        if (messages.length === 0 && value.statuses) {
          console.log(`  📊 حالة رسالة: ${value.statuses[0]?.status || "unknown"}`);
        }
      }
    }

    if (!hasMessage) {
      console.log("  📥 POST /webhook - لا توجد رسائل جديدة (ربما statuses)");
    }
  } catch (err) {
    console.error(`  ❌ خطأ في معالجة Webhook: ${err.message}`, err.stack);
  }
}
