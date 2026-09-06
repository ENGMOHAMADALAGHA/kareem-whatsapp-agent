import { resolveTenant, getTenantFull, listTenants, addTenant } from "../../../tenants.mjs";
import { WHATSAPP_TOKEN } from "../../config/env.mjs";
import {
  bookAppointment,
  listAppointments,
  listAppointmentsAll,
  getBookingState,
  setBookingState,
  dueReminders,
  markReminded,
  cancelAppointment,
  joinWaitingList,
  listWaiting,
  popWaiting,
  removeFromWaiting,
  isSlotTaken,
  freeSlots,
} from "../../../bookings.mjs";
import { downloadWhatsAppMedia, transcribeAudio } from "../../../voice.mjs";
import {
  createOrder,
  getOrder,
  listOrders,
  listOrdersAll,
  markOrderPaid,
  createPaymentLink,
  detectTotal,
  detectItem,
  dueCartReminders,
  dueCartRemindersAll,
  markCartReminded,
} from "../../../orders.mjs";
import { logEvent, listEvents, toCSV } from "../../../crm.mjs";
import {
  saveBroadcast,
  listBroadcasts,
  requestCsat,
  hasPendingCsat,
  saveRating,
  csatStats,
} from "../../../engage.mjs";
import {
  sendWhatsAppMessage,
  sendButtons,
  sendImage,
  defaultButtonsFor,
} from "../../whatsapp/sender.mjs";
import { getHistory, pushHistory, isDuplicateMessageAsync, updateLastAssistant } from "../../memory/conversations.mjs";
import { setTakeover, isTakeover, listInbox, getConversation } from "../../inbox/service.mjs";
import { getKareemReply, processCustomerMessage } from "../../ai/kareem.mjs";
import { updateTenant } from "../../../tenants.mjs";
import { webhookQueue, voiceQueue } from "../../jobs/queue.mjs";
import { checkLimit, senderKey } from "../../security/rateLimit.mjs";
import { createClientUser, listClientUsers } from "../../../portal.mjs";

import { verifyMetaSignature } from "../middleware.mjs";

export function registerWebhookRoutes(app) {
  app.get("/webhook", async (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    console.log(`  🔍 GET /webhook - mode=${mode} token=${token} challenge=${challenge}`);

    // أولاً: جرّب مطابقة tenant حسب verify_token
    const tenant = token ? await resolveTenant({ verifyToken: token }) : null;
    const expected = tenant?.verify_token || WEBHOOK_VERIFY_TOKEN;

    if (mode === "subscribe" && token === expected) {
      console.log(`  ✅ تم التحقق من الـ Webhook بنجاح (tenant=${tenant?.id || "default"})`);
      return res.status(200).send(challenge);
    }

    console.warn(`  ❌ فشل التحقق: token المتوقع="${expected}" المستلم="${token}"`);
    return res.sendStatus(403);
  });
  app.post("/webhook", verifyMetaSignature, (req, res) => {
    const body = req.body;

    // التحقق المبدئي من نوع الحدث
    if (!body || body.object !== "whatsapp_business_account") {
      console.log(`  📥 POST /webhook - object غير متوقع: ${body?.object}`);
      return res.sendStatus(404);
    }

    // رد فوري لواتساب (يمنع إعادة الإرسال = يمنع الرد المكرر)
    res.status(200).send("EVENT_RECEIVED");

    // المعالجة عبر الطابور (تزامن محدود + إعادة + توثيق الميت)
    webhookQueue.enqueue(`webhook:${body.entry?.[0]?.id || "event"}`, () => processWebhookBody(body));
  });
}

async function processWebhookBody(body) {
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

        for (const msg of messages) {
          // منع التكرار: نفس الـ wamid لا يُعالج مرتين أبداً (دائم عبر restart)
          if (msg.id && (await isDuplicateMessageAsync(msg.id))) {
            console.log(`  🔁 رسالة مكررة (id=${msg.id}) - تم تجاهلها`);
            continue;
          }
          hasMessage = true;

          // استخراج رقم العميل ونص الرسالة (يدعم الأزرار + الفويس)
          const from = msg.from; // رقم العميل
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

          // —— فويس نوت: عبر طابور مخصص منخفض التزامن (2) + مهلات + بديل نصي ——
          if ((msg.type === "audio" || msg.audio?.id) && !text) {
            try {
              const mediaId = msg.audio?.id;
              console.log(`  🎤 فويس من ${from} (media=${mediaId}) - جاري التفريغ...`);
              const { text: transcript, reason } = await voiceQueue.run(`voice:${msg.id || `${from}:${Date.now()}`}`, async () => {
                const { buffer, mimeType } = await downloadWhatsAppMedia(mediaId, tenant?.whatsapp_token || WHATSAPP_TOKEN);
                return transcribeAudio(buffer, mimeType, (tenant?.languages || ["ar", "en"]).join(","));
              });
              if (transcript) {
                text = transcript;
                console.log(`  🎤 تفريغ: "${text}"`);
              } else {
                console.log(`  ⚠️ تعذر التفريغ (${reason})`);
                await sendWhatsAppMessage(from, "وصلني الفويس يا غالي 🎤 بس ما قدرت أفرغه، ابعتلي كتابة لو سمحت.", tenant).catch(() => {});
                console.log(`${"─".repeat(60)}\n`);
                continue;
              }
            } catch (e) {
              console.error(`  ❌ خطأ الفويس: ${e.message}`);
              await sendWhatsAppMessage(from, "ما قدرت أسمع الفويس، ابعتلي كتابة يا غالي.", tenant).catch(() => {});
              console.log(`${"─".repeat(60)}\n`);
              continue;
            }
          }

          // —— صورة/مستند (إيصال CliQ/محفظة): تحقق AI تلقائي → مدفوع | مراجعة | يدوي ——
          if ((msg.type === "image" || msg.image?.id || msg.type === "document" || msg.document?.id) && !text) {
            const mediaId = msg.image?.id || msg.document?.id;
            const mimeType = msg.document?.mime_type || "image/jpeg";
            const { handleReceiptImage } = await import("../../media/paymentProof.mjs");
            const res = await handleReceiptImage({ tenant, phone: from, mediaId, mimeType });
            if (res.outcome === "no-order") {
              const reply = `وصلتني الصورة يا غالي 📸 بس ما لقيت طلب معلق برقمك. إذا بدك تطلب ابعت "بدي اطلب"، وإذا هاي لقطة تحويل ابعت رقم الطلب معها.`;
              try {
                await sendWhatsAppMessage(from, reply, tenant);
              } catch (e) {
                console.error(`  ❌ فشل الإرسال: ${e.message}`);
              }
              console.log(`${"─".repeat(60)}\n`);
            } else if (res.outcome === "download-failed") {
              const reply = `وصلتني الصورة بس ما قدرت أحملها 😅 ابعتها مرة تانية لو سمحت.`;
              try {
                await sendWhatsAppMessage(from, reply, tenant);
              } catch (e) {
                console.error(`  ❌ فشل الإرسال: ${e.message}`);
              }
              console.log(`  ⚠️ فشل تحميل إيصال ${res.orderId}: ${res.error}`);
              console.log(`${"─".repeat(60)}\n`);
            } else if (res.outcome === "manual") {
              // بدون مفتاح AI: المسار اليدوي — إرفاق + انتظار الموظف
              const reply = `وصلتني اللقطة يا بطل 📸 ربطتها بطلبك ${res.orderId} ($${res.total}). الموظف رح يتأكد من التحويل ويبعتلك التأكيد هنا. شكراً لثقتك!`;
              await pushHistory(from, "user", "[صورة: لقطة تحويل]", tenant);
              await pushHistory(from, "assistant", reply, tenant);
              try {
                await sendWhatsAppMessage(from, reply, tenant);
              } catch (e) {
                console.error(`  ❌ فشل الإرسال: ${e.message}`);
              }
              console.log(`  📸 إثبات ${res.orderId} من ${from} (media=${mediaId})`);
              console.log(`${"─".repeat(60)}\n`);
            } else {
              // paid/review: الردود أُرسلت داخل handleReceiptImage
              console.log(`  🧾 إيصال ${res.orderId} من ${from} → ${res.outcome}`);
              console.log(`${"─".repeat(60)}\n`);
            }
            continue;
          }

          if (!text) {
            console.log(`  📥 رسالة بدون نص من ${from} (type=${msg.type}) - تم تجاهلها`);
            continue;
          }

          // —— امتثال واتساب: إلغاء/إعادة الاشتراك ——
          const { isOptOut, isOptIn, markOptedOut, clearOptOut, notifyStaff } = await import("../../compliance/messaging.mjs");
          if (isOptOut(text)) {
            await markOptedOut(tenant?.id, from);
            const reply = `تم يا غالي ✅ ألغينا اشتراكك وما رح نراسلك بأي عروض. إذا غيّرت رأيك ابعت "اشتراك".`;
            await pushHistory(from, "user", text, tenant);
            await pushHistory(from, "assistant", reply, tenant);
            logEvent("opt_out", { tenantId: tenant?.id, phone: from }).catch(() => {});
            try {
              await sendWhatsAppMessage(from, reply, tenant);
            } catch (e) {
              console.error(`  ❌ فشل إرسال تأكيد الإلغاء: ${e.message}`);
            }
            console.log(`  🚫 إلغاء اشتراك ${from} (${tenant?.id})`);
            console.log(`${"─".repeat(60)}\n`);
            continue;
          }
          if (isOptIn(text)) {
            await clearOptOut(tenant?.id, from);
            const reply = `أهلاً بعودتك يا بطل! 🎉 رجّعنا اشتراكك ورح توصلك عروضنا. كيف بقدر أساعدك اليوم؟`;
            await pushHistory(from, "user", text, tenant);
            await pushHistory(from, "assistant", reply, tenant);
            logEvent("opt_in", { tenantId: tenant?.id, phone: from }).catch(() => {});
            try {
              await sendWhatsAppMessage(from, reply, tenant);
            } catch (e) {
              console.error(`  ❌ فشل الإرسال: ${e.message}`);
            }
            console.log(`${"─".repeat(60)}\n`);
            continue;
          }

          console.log(`\n${"─".repeat(60)}`);
          console.log(`  🏢 tenant=${tenant?.id} | بوت=${tenant?.botName}`);
          console.log(`  📥 رسالة واتساب من ${name} (${from}): "${text}"${buttonId ? ` [btn=${buttonId}]` : ""}`);
          console.log(`  🧠 الذاكرة: ${(await getHistory(from, tenant)).length} رسائل سابقة`);
          if (await isTakeover(tenant?.id, from)) {
            await pushHistory(from, "user", text, tenant);
            console.log(`  ⏸️ takeover نشط (${from}) - حُفظت الرسالة بدون رد آلي`);
            console.log(`${"─".repeat(60)}\n`);
            continue;
          }

          // —— استعلام عن طلب: "وين طلبي ord_..." (مقيد بنطاق البوت + رقم السائل) ——
          const orderMatch = text.match(/\b(ord_[a-z0-9]+)\b/i);
          if (orderMatch) {
            const qOrder = await getOrder(orderMatch[1].toLowerCase(), tenant?.id).catch(() => null);
            let reply;
            if (qOrder && qOrder.phone === from) {
              const statusAr = { pending: "بانتظار الدفع ⏳", paid: "مدفوع ✅", canceled: "ملغي", proof_received: "إيصال مستلم 📸", pending_review: "قيد المراجعة اليدوية 🔍" }[qOrder.status] || qOrder.status;
              reply = `طلبك ${qOrder.id} — ${(qOrder.items || []).map((i) => i.name).join(" + ")} — الإجمالي $${qOrder.total} — الحالة: ${statusAr}`;
              if (qOrder.status === "pending" && qOrder.paymentUrl) reply += `\nرابط الدفع: ${qOrder.paymentUrl}`;
            } else {
              reply = `ما لقيت طلب بهذا الرقم يا غالي 🤔 تأكد من الرقم (مثال: ord_abc123) أو ابعت "أريد موظف" للمساعدة.`;
            }
            await pushHistory(from, "user", text, tenant);
            await pushHistory(from, "assistant", reply, tenant);
            logEvent("message", { tenantId: tenant?.id, phone: from, intent: "استفسار", text: text.slice(0, 200) }).catch(() => {});
            try {
              await sendWhatsAppMessage(from, reply, tenant);
            } catch (e) {
              console.error(`  ❌ فشل إرسال حالة الطلب: ${e.message}`);
            }
            console.log(`  📦 استعلام طلب ${orderMatch[1]} للعميل ${from}`);
            console.log(`${"─".repeat(60)}\n`);
            continue;
          }

          // —— CSAT: إذا الرد رقم 1-5 وكان في طلب تقييم معلق ——
          if (/^[1-5]$/.test(text.trim())) {
            const pending = await hasPendingCsat(tenant?.id, from);
            if (pending) {
              const score = Number(text.trim());
              const rating = await saveRating({ tenantId: tenant.id, phone: from, score, refId: pending.refId });
              const reply = score >= 4
                ? `شكراً يا بطل! ⭐ تقييمك ${score}/5 أسعدنا. كريم معك خطوة بخطوة 👟`
                : `شكراً لصراحتك يا غالي 🙏 تقييمك ${score}/5 وصلنا ورح نشتغل نحسّن. تحب يحكي معك موظف؟`;
              await pushHistory(from, "user", text, tenant);
              await pushHistory(from, "assistant", reply, tenant);
              logEvent("csat", { tenantId: tenant.id, phone: from, score, refId: pending.refId }).catch(() => {});
              try {
                await sendWhatsAppMessage(from, reply, tenant);
              } catch (e) {
                console.error(`  ❌ فشل إرسال رد التقييم: ${e.message}`);
              }
              console.log(`  ⭐ تقييم ${rating.id} ${tenant.id} ${from} = ${score}`);
              console.log(`${"─".repeat(60)}\n`);
              continue;
            }
          }

          // —— تدفق الحجز (للعيادات) قبل الـ AI ——
          const wantsBooking = tenant?.features?.booking && /(حجز|موعد|احجز|book|appointment)/i.test(text + " " + (buttonId || ""));
          const bookingState = await getBookingState(tenant?.id, from);
          // —— فرز أولي Triage (أعراض الأسنان) ——
          const triageOn = tenant?.features?.booking && tenant?.businessType === "dental";
          const symptomHit = triageOn && !bookingState && /(وجع|ألم|يوجع|يؤلم|ورم|منتفخ|انتفاخ|كسر|مكسور|انكسر|نزيف|دم|حرارة|سخونة|سخن|خراج|حساسية|حساس|بارد|ساخن|ضرس العقل|pain|ache|swell|swollen|broken|bleed|fever|abscess|sensitive)/i.test(text);
          let result = null;
          let handled = false;

          // 1) ضغطة زر منتج لكريم: اعرض الصورة + أكمل شراء
          if (tenant?.id === "kareem-sport" && buttonId && /^(buy_shoes|buy_belt|bundle)$/.test(buttonId)) {
            const map = {
              buy_shoes: "أريد شراء حذاء الركض",
              buy_belt: "أريد شراء حزام الظهر",
              bundle: "أريد حزام الظهر والحذاء معاً",
            };
            result = await processCustomerMessage(map[buttonId], from, tenant);
            const prod = buttonId === "buy_shoes" ? tenant.products[0] : buttonId === "buy_belt" ? tenant.products[1] : null;
            try {
              if (prod?.image) await sendImage(from, prod.image, `${prod.name} - $${prod.price}`, tenant);
              await sendWhatsAppMessage(from, result.reply, tenant);
            } catch (sendErr) {
              console.error(`  ❌ فشل الإرسال: ${sendErr.message}`);
            }
            console.log(`  🤖 ${tenant?.botName} -> intent=${result.intent} (زر ${buttonId})`);
            console.log(`${"─".repeat(60)}\n`);
            continue;
          }

          // 1ب) بدء الفرز: سؤال المكان
          if (symptomHit) {
            await setBookingState(tenant.id, from, { step: "triage_q1", answers: { symptom: text.slice(0, 200) } });
            const reply = `سلامتك يا غالي 🙏 عشان نوجهك صح، وين الألم بالضبط؟ (ضرس / لثة / فك)`;
            await pushHistory(from, "user", text, tenant);
            await pushHistory(from, "assistant", reply, tenant);
            try {
              await sendButtons(from, reply, [
                { id: "pain_tooth", title: "🦷 ضرس" },
                { id: "pain_gum", title: "لثة" },
                { id: "pain_jaw", title: "فك" },
              ], tenant);
            } catch (e) {
              await sendWhatsAppMessage(from, reply, tenant).catch(() => {});
            }
            console.log(`  🩺 بدء فرز ${tenant.id} للعميل ${from}`);
            console.log(`${"─".repeat(60)}\n`);
            continue;
          }

          // 1ج) الفرز س2: المدة
          if (bookingState?.step === "triage_q1") {
            const answers = { ...(bookingState.answers || {}), place: text.slice(0, 100) };
            await setBookingState(tenant.id, from, { step: "triage_q2", answers });
            const reply = `تمام، ومن متى بلش الألم؟ (اليوم / من أيام / من أسابيع)`;
            await pushHistory(from, "user", text, tenant);
            await pushHistory(from, "assistant", reply, tenant);
            try {
              await sendWhatsAppMessage(from, reply, tenant);
            } catch (e) {
              console.error(`  ❌ فشل الإرسال: ${e.message}`);
            }
            console.log(`${"─".repeat(60)}\n`);
            continue;
          }

          // 1د) الفرز س3: علامات الخطر + التصنيف
          if (bookingState?.step === "triage_q2") {
            const answers = { ...(bookingState.answers || {}), since: text.slice(0, 100) };
            await setBookingState(tenant.id, from, { step: "triage_q3", answers });
            const reply = `آخر سؤال يا غالي: هل عندك أي من هاي؟ (ورم / حرارة / نزيف / ألم لا يُحتمل) — ابعت "لا" إذا ما في شي منها.`;
            await pushHistory(from, "user", text, tenant);
            await pushHistory(from, "assistant", reply, tenant);
            try {
              await sendButtons(from, reply, [
                { id: "red_swelling", title: "ورم" },
                { id: "red_none", title: "لا، ما في" },
              ], tenant);
            } catch (e) {
              await sendWhatsAppMessage(from, reply, tenant).catch(() => {});
            }
            console.log(`${"─".repeat(60)}\n`);
            continue;
          }

          // 1هـ) التصنيف: طارئ أم عادي
          if (bookingState?.step === "triage_q3") {
            const red = /(ورم|منتفخ|انتفاخ|حرارة|سخونة|سخن|نزيف|دم|كسر|مكسور|انكسر|خراج|لا يحتمل|لا يحتمل|شديد جدا|swell|fever|bleed|broken|abscess|red_swelling)/i.test(text + " " + (buttonId || ""));
            const answers = { ...(bookingState.answers || {}), redFlags: red ? text.slice(0, 100) : "لا" };
            const summary = `العرض: ${answers.symptom || ""} | المكان: ${answers.place || ""} | المدة: ${answers.since || ""} | علامات: ${answers.redFlags}`;
            logEvent("triage", { tenantId: tenant.id, phone: from, emergency: red, summary: summary.slice(0, 300) }).catch(() => {});
            if (red) {
              await setBookingState(tenant.id, from, null);
              const booking = await bookAppointment({ tenantId: tenant.id, phone: from, name, service: "حالة طارئة 🆘", day: "اليوم", slot: "أقرب وقت" });
              const reply = `سلامتك أولاً يا غالي 🆘 الأعراض اللي ذكرتها تحتاج تدخل سريع — حجزتلك موعد طارئ اليوم (${booking.id}). تعال مباشرة على العيادة، والدكتور بانتظارك. إذا الوضع خطير اتصل فينا فوراً.`;
              await pushHistory(from, "user", text, tenant);
              await pushHistory(from, "assistant", reply, tenant);
              try {
                await sendWhatsAppMessage(from, reply, tenant);
              } catch (e) {
                console.error(`  ❌ فشل الإرسال: ${e.message}`);
              }
              console.log(`  🆘 حالة طارئة ${tenant.id} ${from} (${booking.id})`);
              console.log(`${"─".repeat(60)}\n`);
              continue;
            }
            // عادي → كمّل للحجز مع تلخيص الإجابات في الذاكرة
            await setBookingState(tenant.id, from, { step: "slot", triage: summary.slice(0, 300) });
            const slots = (tenant.features.bookingSlots || []).join("، ");
            const reply = `تمام يا غالي، حالتك تبدو عادية 😊 سجلت ملاحظاتك للدكتور. اختر الوقت المناسب: ${slots}. ابعت الوقت (مثال: 14:00).`;
            await pushHistory(from, "user", text, tenant);
            await pushHistory(from, "assistant", reply, tenant);
            try {
              await sendButtons(from, reply, (tenant.features.bookingSlots || []).slice(0, 3).map((s) => ({ id: `slot_${s}`, title: `🕐 ${s}` })), tenant);
            } catch (e) {
              await sendWhatsAppMessage(from, reply, tenant).catch(() => {});
            }
            console.log(`  🩺 فرز عادي → حجز ${tenant.id} ${from}`);
            console.log(`${"─".repeat(60)}\n`);
            continue;
          }

          // 1و) الانضمام لقائمة الانتظار
          if (tenant?.features?.booking && /(انتظار|ضيفني|قائمة الانتظار|waitlist|waiting)/i.test(text)) {
            const service = (tenant.products || [])[0]?.name || "موعد";
            const w = await joinWaitingList({ tenantId: tenant.id, phone: from, name, service });
            const reply = `تم يا غالي ✅ انضميت لقائمة الانتظار (${w.id}) لخدمة ${service}. أول ما يفضى موعد بنخبرك فوراً هنا.`;
            await pushHistory(from, "user", text, tenant);
            await pushHistory(from, "assistant", reply, tenant);
            logEvent("waiting_join", { tenantId: tenant.id, phone: from, service }).catch(() => {});
            try {
              await sendWhatsAppMessage(from, reply, tenant);
            } catch (e) {
              console.error(`  ❌ فشل الإرسال: ${e.message}`);
            }
            console.log(`  📋 انضمام انتظار ${tenant.id} ${from}`);
            console.log(`${"─".repeat(60)}\n`);
            continue;
          }

          // 1ز) قبول عرض موعد من الانتظار
          if (bookingState?.step === "offer" && /^(تم|موافق|نعم|ok|yes)$/i.test(text.trim())) {
            const booking = await bookAppointment({ tenantId: tenant.id, phone: from, name, service: bookingState.service || "موعد", day: bookingState.day || "أقرب يوم", slot: bookingState.slot || "" });
            await setBookingState(tenant.id, from, null);
            const reply = `ممتاز! 🎉 تم تأكيد موعدك ${booking.service} (${booking.id}). بنتشرف فيك!`;
            await pushHistory(from, "user", text, tenant);
            await pushHistory(from, "assistant", reply, tenant);
            logEvent("booking", { tenantId: tenant.id, phone: from, bookingId: booking.id, fromWaiting: true }).catch(() => {});
            try {
              await sendWhatsAppMessage(from, reply, tenant);
            } catch (e) {
              console.error(`  ❌ فشل الإرسال: ${e.message}`);
            }
            console.log(`  📋 تأكيد من الانتظار ${booking.id} ${from}`);
            console.log(`${"─".repeat(60)}\n`);
            continue;
          }

          // 2) بدء الحجز
          if (wantsBooking && !bookingState) {
            const slots = (tenant.features.bookingSlots || []).join("، ");
            await setBookingState(tenant.id, from, { step: "slot" });
            const reply = `تمام يا غالي 😊 احجز موعدك في ${tenant.name}. أوقاتنا: ${tenant.features.workingHours || ""}. اختر الوقت المناسب: ${slots}. ابعت الوقت (مثال: 14:00) واسم الخدمة.`;
            result = { reply, transfer_to_human: false, intent: "حجز_موعد" };
            await pushHistory(from, "user", text, tenant);
            await pushHistory(from, "assistant", reply, tenant);
            try {
              await sendButtons(from, reply, (tenant.features.bookingSlots || []).slice(0, 3).map((s) => ({ id: `slot_${s}`, title: `🕐 ${s}` })), tenant);
            } catch (e) {
              await sendWhatsAppMessage(from, reply, tenant).catch(() => {});
            }
            console.log(`  📅 بدء حجز ${tenant.id} للعميل ${from}`);
            console.log(`${"─".repeat(60)}\n`);
            continue;
          }

          // 3) استكمال الحجز (اختار وقت)
          if (bookingState?.step === "slot") {
            const slotMatch = text.match(/(\d{1,2}:\d{2})/) || (buttonId?.startsWith("slot_") ? [null, buttonId.replace("slot_", "")] : null);
            if (slotMatch) {
              const slot = slotMatch[1];
              const service = (tenant.products || [])[0]?.name || "موعد";
              const day = bookingState.day || "أقرب يوم متاح";
              const capacity = tenant.features?.slotCapacity || 1;
              // منع التعارض: إذا محجوز اعرض البدائل
              if (await isSlotTaken(tenant.id, day, slot, capacity)) {
                const free = await freeSlots(tenant.id, day, tenant.features?.bookingSlots, capacity);
                const reply = free.length
                  ? `للأسف الساعة ${slot} محجوزة يا غالي 😅 بس الفارغ عندنا: ${free.join("، ")}. اختر واحد منهم؟ أو ابعت "انتظار" لأضيفك لقائمة الانتظار.`
                  : `للأسف كل الأوقات محجوزة اليوم 😅 أضفتك تلقائياً لقائمة الانتظار، وأول ما يفضى موعد بخبرك فوراً.`;
                if (!free.length) {
                  await joinWaitingList({ tenantId: tenant.id, phone: from, name, service });
                }
                await pushHistory(from, "user", text, tenant);
                await pushHistory(from, "assistant", reply, tenant);
                try {
                  if (free.length) {
                    await sendButtons(from, reply, free.slice(0, 3).map((s) => ({ id: `slot_${s}`, title: `🕐 ${s}` })), tenant);
                  } else {
                    await sendWhatsAppMessage(from, reply, tenant);
                  }
                } catch (e) {
                  console.error(`  ❌ فشل الإرسال: ${e.message}`);
                }
                console.log(`  ⚠️ تعارض ${tenant.id} ${day} ${slot} — عُرضت البدائل`);
                console.log(`${"─".repeat(60)}\n`);
                continue;
              }
              let booking;
              try {
                booking = await bookAppointment({ tenantId: tenant.id, phone: from, name, service, day, slot });
              } catch (e) {
                if (e?.code === "SLOT_TAKEN" || e?.code === "P2002") {
                  const free = await freeSlots(tenant.id, day, tenant.features?.bookingSlots, capacity);
                  const reply = free.length
                    ? `للأسف الساعة ${slot} انحجزت قبل لحظات 😅 الفارغ عندنا: ${free.join("، ")}. اختر واحد منهم؟`
                    : `للأسف كل الأوقات انحجزت 😅 أضفتك لقائمة الانتظار.`;
                  if (!free.length) await joinWaitingList({ tenantId: tenant.id, phone: from, name, service });
                  await pushHistory(from, "user", text, tenant);
                  await pushHistory(from, "assistant", reply, tenant);
                  try { await sendWhatsAppMessage(from, reply, tenant); } catch (se) { console.error(`  ❌ فشل الإرسال: ${se.message}`); }
                  console.log(`${"─".repeat(60)}\n`);
                  continue;
                }
                throw e;
              }
              await setBookingState(tenant.id, from, null);
              const reply = `تم تأكيد حجزك يا غالي ✅ ${service} - الساعة ${slot} (${booking.id}). بنتشرف فيك في ${tenant.name}! لإلغاء/تعديل ابعت "أريد موظف".`;
              result = { reply, transfer_to_human: false, intent: "حجز_موعد" };
              await pushHistory(from, "user", text, tenant);
              await pushHistory(from, "assistant", reply, tenant);
              logEvent("booking", { tenantId: tenant.id, phone: from, bookingId: booking.id, service, slot }).catch(() => {});
              try {
                await sendWhatsAppMessage(from, reply, tenant);
              } catch (e) {
                console.error(`  ❌ فشل الإرسال: ${e.message}`);
              }
              console.log(`  📅 تأكيد حجز ${booking.id} ${tenant.id} ${from} ${slot}`);
              console.log(`${"─".repeat(60)}\n`);
              continue;
            }
          }

          // —— المسار العادي: AI ——
          result = await processCustomerMessage(text, from, tenant);

          console.log(`  🤖 ${tenant?.botName || "كريم"} -> intent=${result.intent} transfer=${result.transfer_to_human}`);
          console.log(`  💬 الرد: "${result.reply}"`);
          logEvent("message", { tenantId: tenant?.id, phone: from, intent: result.intent, transfer: result.transfer_to_human, text: text.slice(0, 200) }).catch(() => {});

          if (result.transfer_to_human) {
            console.log(`  🚨 تنبيه: العميل ${from} طلب التصعيد للبشر!`);
            // تنبيه الموظف على واتساب (أفضل-جهد، لا يؤخر الرد)
            notifyStaff(tenant, `عميل يطلب موظفاً: ${from} (${name}) — "${text.slice(0, 120)}"`).catch(() => {});
          }

          // —— إنشاء طلب + تعليمات الدفع عند نية الشراء (متاجر) ——
          const wantsPay =
            result.intent === "شراء" &&
            (tenant?.businessType === "sport-store" || (tenant.products || []).length > 0) &&
            !tenant?.features?.booking;
          if (wantsPay) {
            try {
              let total = detectTotal(tenant, text, result.reply);
              // منع التكرار: طلب معلق لنفس الرقم خلال 30 دقيقة يُعاد استخدامه
              const { findRecentPending } = await import("../../../orders.mjs");
              let order = await findRecentPending(tenant.id, from, 30);
              let isNew = false;
              if (!order) {
                order = await createOrder({
                  tenantId: tenant.id, phone: from, name,
                  items: [{ name: detectItem(tenant, text, result.reply), qty: 1 }],
                  total, currency: "USD",
                });
                isNew = true;
              } else {
                total = order.total; // التزم بإجمالي الطلب الأصلي
                console.log(`  ♻️ طلب موجود ${order.id} — إعادة استخدامه بدل الجديد`);
              }
              const wallets = tenant.features?.paymentWallets || [];
              if (wallets.length) {
                // دفع بالمحافظ/CliQ: تحويل + لقطة شاشة + تحقق AI تلقائي
                const lines = wallets.map((w) => `• ${w.type}: ${w.number}${w.name ? ` (${w.name})` : ""}`).join("\n");
                result.reply += `\n\n🧾 طلبك ${order.id} — الإجمالي $${total}.\nحوّل المبلغ على إحدى المحافظ:\n${lines}\nثم ابعت لقطة الشاشة هون 📸 والتحقق تلقائي ✨`;
                console.log(`  💳 طلب ${order.id} $${total} -> محافظ`);
              } else {
                const baseUrl = process.env.PUBLIC_BASE_URL || `https://kareem-whatsapp-agent.onrender.com`;
                const { url: payUrl } = await createPaymentLink(order, baseUrl);
                if (payUrl) {
                  result.reply += `\n\n🧾 طلبك ${order.id} — الإجمالي $${total}. ادفع هنا: ${payUrl}`;
                  console.log(`  💳 طلب ${order.id} $${total} -> ${payUrl}`);
                } else {
                  // المسار الأساسي بدون Stripe: تحويل يدوي (CliQ/محفظة) + إيصال
                  const cliq = tenant.features?.cliq;
                  const instructions = cliq?.number
                    ? `حوّل $${total} عبر CliQ على ${cliq.number}${cliq.name ? ` (${cliq.name})` : ""}`
                    : `ابعت "أريد موظف" ليعطيك رقم التحويل (CliQ/محفظة)`;
                  result.reply += `\n\n🧾 طلبك ${order.id} — الإجمالي $${total}.\n${instructions}، ثم ابعت لقطة الشاشة هون 📸 والتحقق تلقائي ✨`;
                  console.log(`  💳 طلب ${order.id} $${total} -> تحويل يدوي`);
                }
              }
              if (isNew) {
                logEvent("order", { tenantId: tenant.id, phone: from, orderId: order.id, total, intent: result.intent }).catch(() => {});
              }
              await updateLastAssistant(from, result.reply, tenant);
            } catch (e) {
              console.error(`  ❌ خطأ إنشاء الطلب: ${e.message}`);
            }
          }

          // إرسال ذكي: صورة + نص + أزرار (حسب ما رجّع الـ AI)
          try {
            if (result.image && tenant?.features?.images) {
              await sendImage(from, result.image, result.reply.slice(0, 200), tenant).catch(() => {});
              // مع الصورة نرسل الأزرار لو وجدت
              const btns = result.buttons?.length ? result.buttons : await defaultButtonsFor(tenant);
              if (tenant?.features?.buttons && btns?.length) {
                await sendButtons(from, "شو بتحب تعمل هلا؟", btns, tenant).catch(() => {});
              }
            } else if (result.buttons?.length && tenant?.features?.buttons) {
              await sendButtons(from, result.reply, result.buttons, tenant);
            } else {
              // أول عرض للمنتجات: أرفق أزرار تلقائياً (كريم فقط، أول رسالتين)
              const histLen = (await getHistory(from, tenant)).length;
              await sendWhatsAppMessage(from, result.reply, tenant);
              if (tenant?.id === "kareem-sport" && histLen <= 2 && /حذاء|حزام|Bundle|لدينا/i.test(result.reply)) {
                await sendButtons(from, "اختار بسرعة 👇", await defaultButtonsFor(tenant), tenant).catch(() => {});
              }
            }
          } catch (sendErr) {
            console.error(`  ❌ فشل إرسال الرد للعميل ${from}: ${sendErr.message}`);
          }

          console.log(`${"─".repeat(60)}\n`);
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
