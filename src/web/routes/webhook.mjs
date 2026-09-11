import { resolveTenant, getTenantFull, listTenants, addTenant } from "../../../tenants.mjs";
import { WHATSAPP_TOKEN, WEBHOOK_VERIFY_TOKEN, STAFF_PHONE } from "../../config/env.mjs";
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
  detectTotal,
  detectItem,
  dueCartReminders,
  dueCartRemindersAll,
  markCartReminded,
  fmtMoney,
  tenantCurrency,
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
import { normalizePhone } from "../../utils/phone.mjs";
import { ammanDateStr } from "../../utils/time.mjs";
import { updateTenant } from "../../../tenants.mjs";
import { webhookQueue, voiceQueue } from "../../jobs/queue.mjs";
import { storeGet, storeSet, storeDel, storeKeys } from "../../../store.mjs";
import { checkLimit, senderKey } from "../../security/rateLimit.mjs";
import { createClientUser, listClientUsers } from "../../../portal.mjs";

import { verifyMetaSignature } from "../middleware.mjs";

// ── أدوات مساعدة: تاريخ الحجز + إنشاء طلب مع تعليمات الدفع ──
// تاريخ فعلي للموعد بدل السلسلة الثابتة "أقرب يوم متاح" التي كانت تجعل
// القيد (tenantId, day, slot) يحجز الساعة نفسها مرّة واحدة إلى الأبد.
function bookingDay(day) {
  if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
  if (day && /^(اليوم|اليوم)/.test(day)) return ammanDateStr(0);
  if (day && /^(غداً|غدا)/.test(day)) return ammanDateStr(1);
  return ammanDateStr(1);
}

// إنشاء طلب + تعليمات الدفع (يُستخدم للشراء النصي وضغط أزرار المنتجات)
// القاعدة: إعادة الاستخدام فقط عند تطابق السلعة والمبلغ معاً —
// أي محور لسلعة/مبلغ مختلف (أو طلب قديم بمبلغ ملوث من كلام تسويقي) يُلغى ويُستبدل.
async function createOrderWithPayment(tenant, from, name, text, result) {
  if (!tenant) return; // تحصين: لا ننشئ طلباً بلا مستأجر
  const { findRecentPending, cancelOpenOrders } = await import("../../../orders.mjs");
  const item = detectItem(tenant, text, result.reply);
  const freshTotal = totalForItem(tenant, item, text);
  let order = await findRecentPending(tenant.id, from, 30);
  let isNew = false;
  const userItem = detectUserItem(tenant, text);
  const userTotal = detectUserTotal(text);
  if (order) {
    const orderItem = order.items?.[0]?.name || "";
    const sameItem = !userItem || orderItem === userItem ||
      (userItem.includes(" + ") && orderItem && userItem.includes(orderItem.split(" ")[0]));
    const sameTotal = userTotal === null || Math.abs(Number(order.total) - userTotal) < 0.001;
    if (!sameItem || !sameTotal) {
      // محور الزبون (أو طلب قديم بمبلغ ملوث) → إلغاء الكل وبدء نظيف
      const killed = await cancelOpenOrders(tenant.id, from).catch(() => 0);
      logEvent("order_superseded", { tenantId: tenant.id, phone: from, oldOrderId: order.id, killed }).catch(() => {});
      console.log(`  🔄 محور لسلعة/مبلغ مختلف — أُلغي ${killed} قديم، طلب جديد`);
      order = null;
    }
  }
  if (!order) {
    order = await createOrder({
      tenantId: tenant.id, phone: from, name,
      items: [{ name: item, qty: 1 }],
      total: freshTotal, currency: tenantCurrency(tenant),
    });
    isNew = true;
  } else {
    console.log(`  ♻️ طلب موجود ${order.id} — إعادة استخدامه (نفس السلعة والمبلغ)`);
  }
  const total = order.total;
  const cur = fmtMoney(total, order.currency);
  // دفع بالمحافظ/CliQ حصراً — لا روابط دفع أبداً: تحويل + لقطة شاشة + تحقق
  const wallets = tenant.features?.paymentWallets || [];
  if (wallets.length) {
    const lines = wallets.map((w) => `• ${w.type}: ${w.number}${w.name ? ` (${w.name})` : ""}`).join("\n");
    result.reply += `\n\n🧾 طلبك ${order.id} — الإجمالي ${cur}.\nحوّل المبلغ على إحدى المحافظ:\n${lines}\nثم ابعت لقطة الشاشة هون 📸 والتحقق تلقائي ✨`;
    console.log(`  💳 طلب ${order.id} ${cur} -> محافظ`);
  } else {
    const cliq = tenant.features?.cliq;
    const instructions = cliq?.number
      ? `حوّل ${cur} عبر CliQ على ${cliq.number}${cliq.name ? ` (${cliq.name})` : ""}`
      : `ابعت "أريد موظف" ليعطيك رقم التحويل (CliQ/محفظة)`;
    result.reply += `\n\n🧾 طلبك ${order.id} — الإجمالي ${cur}.\n${instructions}، ثم ابعت لقطة الشاشة هون 📸 والتحقق تلقائي ✨`;
    console.log(`  💳 طلب ${order.id} ${cur} -> تحويل يدوي`);
  }
  if (isNew) {
    logEvent("order", { tenantId: tenant.id, phone: from, orderId: order.id, total, intent: result.intent }).catch(() => {});
  }
  await updateLastAssistant(from, result.reply, tenant);
  return order;
}

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

    // P0-3 — سد نافذة فقدان الرسائل في الطيران:
    // نُخزّن الحمولة في kv_store (دائم) قبل رد 200، ويمسحها المعالج بعد اكتماله.
    // لو انقطع السيرفر/أعيد النشر بعد 200 وقبل نهاية المعالجة، تعيد إعادة المعالجة
    // عند الإقلاع (replayInflightWebhooks) التعامل معها — بلا فقد ولا تكرار (dedup بالـ wamid).
    const firstMsg = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const hasMessages = !!firstMsg?.id;
    const inflightKey = `wbh:inflight:${firstMsg?.id || `${body.entry?.[0]?.id || "event"}:${Date.now()}`}`;

    // رد فوري لواتساب (يمنع إعادة الإرسال = يمنع الرد المكرر)
    res.status(200).send("EVENT_RECEIVED");

    if (hasMessages) {
      storeSet(inflightKey, { at: Date.now(), body })
        .catch(() => {});
    }

    // المعالجة عبر الطابور — مرتبة FIFO لكل مرسل (رسائل نفس الزبون لا تتسابق)
    let senderKey = "unknown";
    try {
      if (firstMsg?.from) senderKey = `sender:${firstMsg.from}`;
    } catch { /* مفتاح افتراضي */ }
    webhookQueue.enqueueOrdered(senderKey, `webhook:${body.entry?.[0]?.id || "event"}`, async () => {
      try {
        await processWebhookBody(body);
      } finally {
        if (hasMessages) await storeDel(inflightKey).catch(() => {});
      }
    });
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
            if (res.outcome === "no-tenant") {
              // دفاع بالعمق: البوابة العليا تمنع الوصول أصلاً — هذا الفرع للوضوح فقط
              console.log(`  ⛔ إيصال بلا مستأجر (media=${mediaId}) — تجاهل صريح`);
              console.log(`${"─".repeat(60)}\n`);
              continue;
            } else if (res.outcome === "no-order") {
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
              const reply = `وصلتني اللقطة يا بطل 📸 ربطتها بطلبك ${res.orderId} (${fmtMoney(res.total, res.currency)}). الموظف رح يتأكد من التحويل ويبعتلك التأكيد هنا. شكراً لثقتك!`;
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

          // —— أوامر الطاقم: "قف" يُسكت البوت على هذه المحادثة (takeover)، "شغّل" يرجعّه — رقم الموظف المسجل فقط ——
          // السلوك قبل هذه الكتلة: لو كان takeover نشطاً نتجاهل الرسالة — لذلك تُعترض هنا قبل فحصه
          // حتى يتمكن الموظف المُسكَت نفسه من إعادة تفعيل البوت بكلمة "شغّل".
          const staffNum = tenant?.features?.staffPhone || STAFF_PHONE;
          const cmdText = text.trim().replace(/^(البوت\s*|يا\s*بوت\s*)/, "");
          if ((cmdText === "قف" || cmdText === "شغّل") && staffNum && normalizePhone(staffNum) === from) {
            const on = cmdText === "قف";
            await setTakeover(tenant?.id, from, on, `staff:${from}`);
            const reply = on
              ? "تم ✅ سكّت البوت على هالمحادثة — بيرد الموظف من الموقع مباشرة. لإرجاعه ابعت \"شغّل\"."
              : "تمام ✅ البوت رجع يرد على هالمحادثة.";
            await pushHistory(from, "user", text, tenant);
            await pushHistory(from, "assistant", reply, tenant);
            logEvent(on ? "staff_pause" : "staff_resume", { tenantId: tenant?.id, phone: from }).catch(() => {});
            try {
              await sendWhatsAppMessage(from, reply, tenant);
            } catch (e) {
              console.error(`  ❌ فشل إرسال تأكيد أمر الطاقم: ${e.message}`);
            }
            console.log(`  🎛️  أمر طاقم ${cmdText} من ${from} (${tenant?.id})`);
            console.log(`${"─".repeat(60)}\n`);
            continue;
          }

          if (await isTakeover(tenant?.id, from)) {
            await pushHistory(from, "user", text, tenant);
            console.log(`  ⏸️ takeover نشط (${from}) - حُفظت الرسالة بدون رد آلي`);
            console.log(`${"─".repeat(60)}\n`);
            continue;
          }

          // —— نية إلغاء/نسيان الطلب: "انسى الطلب القديم / الغيه / كنسل / بلا / لا بدي طلب جديد" ——
          // تُلغى كل الطلبات المفتوحة فوراً ولا يُنشأ طلب بهذه الدورة (الذكاء يرد محادثة نظيفة)
          if (/(انسى|انس|أنسى|الغي|ألغي|الغاء|إلغاء|الغى|كنسل|كنسله|بلا.*طلب|ما بدي.*طلب|لا.*طلب جديد|امسح.*طلب|من غير طلب)/.test(text)) {
            const { cancelOpenOrders } = await import("../../../orders.mjs");
            const killed = await cancelOpenOrders(tenant?.id, from).catch(() => 0);
            const reply = killed > 0
              ? `تمام يا غالي ✅ نسيت الطلبات المعلقة (${killed}). ابعت طلبك الجديد وأنا جاهز 👟`
              : `ما عندك طلبات معلقة يا غالي 😊 ابعت طلبك الجديد وأنا جاهز 👟`;
            await pushHistory(from, "user", text, tenant);
            await pushHistory(from, "assistant", reply, tenant);
            logEvent("orders_forgotten", { tenantId: tenant?.id, phone: from, killed }).catch(() => {});
            try {
              await sendWhatsAppMessage(from, reply, tenant);
            } catch (e) {
              console.error(`  ❌ فشل الإرسال: ${e.message}`);
            }
            console.log(`  🧹 نسيان طلبات ${from} (أُلغي ${killed})`);
            console.log(`${"─".repeat(60)}\n`);
            continue;
          }

          // —— استعلام عن طلب: "وين طلبي ord_..." (مقيد بنطاق البوت + رقم السائل) ——
          const orderMatch = text.match(/\b(ord_[a-z0-9]+)\b/i);
          if (orderMatch) {
            const qOrder = await getOrder(orderMatch[1].toLowerCase(), tenant?.id).catch(() => null);
            let reply;
            if (qOrder && qOrder.phone === from) {
              const statusAr = { pending: "بانتظار الدفع ⏳", paid: "مدفوع ✅", canceled: "ملغي", proof_received: "إيصال مستلم 📸", pending_review: "قيد المراجعة اليدوية 🔍", rejected: "مرفوض — راجع الإيصال ❌" }[qOrder.status] || qOrder.status;
              reply = `طلبك ${qOrder.id} — ${(qOrder.items || []).map((i) => i.name).join(" + ")} — الإجمالي ${fmtMoney(qOrder.total, qOrder.currency)} — الحالة: ${statusAr}`;
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
                ? `شكراً يا بطل! ⭐ تقييمك ${score}/5 أسعدنا ونوره يتقدم.`
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

          // 1) ضغطة زر منتج لكريم: اعرض الصورة + أنشئ الطلب فوراً + تعليمات الدفع
          if (tenant?.id === "kareem-sport" && buttonId && /^(buy_shoes|buy_belt|bundle)$/.test(buttonId)) {
            const map = {
              buy_shoes: "أريد شراء حذاء الركض",
              buy_belt: "أريد شراء حزام الظهر",
              bundle: "أريد حزام الظهر والحذاء معاً",
            };
            result = await processCustomerMessage(map[buttonId], from, tenant);
            try {
              if (result.intent === "شراء") {
                // إنشاء طلب + إرفاق تعليمات الدفع بنفس الرسالة (لا حلقة تأكيد ميتة)
                await createOrderWithPayment(tenant, from, name, map[buttonId], result);
              }
              const prod = buttonId === "buy_shoes" ? tenant.products[0] : buttonId === "buy_belt" ? tenant.products[1] : null;
              if (prod?.image && tenant?.features?.images) await sendImage(from, prod.image, `${prod.name} - ${fmtMoney(prod.price, tenantCurrency(tenant))}`, tenant);
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
            const reply = `تمام، ومن متى بلش الألم؟ (اليوم / من كم يوم / من أسابيع)`;
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
            const red = /(ورم|منتفخ|انتفاخ|حرارة|سخونة|سخن|نزيف|دم|كسر|مكسور|انكسر|خراج|لا يُحتمل|لا يحتمل|شديد جدا|swell|fever|bleed|broken|abscess|red_swelling)/i.test(text + " " + (buttonId || ""));
            const answers = { ...(bookingState.answers || {}), redFlags: red ? text.slice(0, 100) : "لا" };
            const summary = `العرض: ${answers.symptom || ""} | المكان: ${answers.place || ""} | المدة: ${answers.since || ""} | علامات: ${answers.redFlags}`;
            logEvent("triage", { tenantId: tenant.id, phone: from, emergency: red, summary: summary.slice(0, 300) }).catch(() => {});
            if (red) {
              await setBookingState(tenant.id, from, null);
              // موعد طوارئ فريد: تاريخ اليوم بمنطقة الأردن + وقت فوري (يسمح بحالات طوارئ متعددة باليوم نفسه)
              const now = new Date();
              const day = ammanDateStr(0);
              const slot = `طوارئ فوري ${now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
              try {
                const booking = await bookAppointment({ tenantId: tenant.id, phone: from, name, service: "حالة طارئة 🆘", day, slot });
                const reply = `سلامتك أولاً يا غالي 🆘 الأعراض اللي ذكرتها تحتاج تدخل سريع — حجزتلك موعد طارئ اليوم (${booking.id}). تعال مباشرة على العيادة، والدكتور بانتظارك. إذا الوضع خطير اتصل فينا فوراً.`;
                await pushHistory(from, "user", text, tenant);
                await pushHistory(from, "assistant", reply, tenant);
                try {
                  await sendWhatsAppMessage(from, reply, tenant);
                } catch (e) {
                  console.error(`  ❌ فشل الإرسال: ${e.message}`);
                }
                console.log(`  🆘 حالة طارئة ${tenant.id} ${from} (${booking.id})`);
              } catch (e) {
                // لا صمت أبداً: حتى لو تعارض، نخبر المريض بالاتصال المباشر
                console.error(`  ❌ تعارض حجز طارئ: ${e.message}`);
                const staffReply = `سلامتك يا غالي 🆘 الملف الطارئ مفتوح عندنا هلا — اتصل بالعيادة مباشرة 📞 أو ابعت "أريد موظف" للتنسيق الفوري. هذا تنبيه آلي وليس استشارة طبية.`;
                await pushHistory(from, "user", text, tenant);
                await pushHistory(from, "assistant", staffReply, tenant);
                try {
                  await sendWhatsAppMessage(from, staffReply, tenant);
                } catch (se) {
                  console.error(`  ❌ فشل إرسال تنبيه الطوارئ: ${se.message}`);
                }
              }
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
            const service = bookingState?.service || (tenant.products || [])[0]?.name || "موعد";
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
            // مهلة العرض الفعلية: ساعة (كما وعدنا العميل) لا 24 ساعة
            const offerAge = bookingState.offeredAt ? Date.now() - bookingState.offeredAt : 0;
            if (offerAge > 60 * 60 * 1000) {
              await setBookingState(tenant.id, from, null);
              const expired = `انتهت مهلة العرض يا غالي 😊 الموعد بيعطي بالعادة خلال ساعة من عرضه. ابعت "حجز" لموعد جديد أو "انتظار" لعودتك للقائمة.`;
              await pushHistory(from, "user", text, tenant);
              await pushHistory(from, "assistant", expired, tenant);
              try { await sendWhatsAppMessage(from, expired, tenant); } catch (e) { console.error(`  ❌ فشل الإرسال: ${e.message}`); }
              console.log(`  ⏳ عرض منتهي ${tenant.id} ${from}`);
              console.log(`${"─".repeat(60)}\n`);
              continue;
            }
            try {
              const accepted = await bookAppointment({ tenantId: tenant.id, phone: from, name, service: bookingState.service || "موعد", day: bookingDay(bookingState.day), slot: bookingState.slot || "" });
              await setBookingState(tenant.id, from, null);
              const reply = `ممتاز! 🎉 تم تأكيد موعدك ${accepted.service} (${accepted.id}). بنتشرف فيك!`;
              await pushHistory(from, "user", text, tenant);
              await pushHistory(from, "assistant", reply, tenant);
              logEvent("booking", { tenantId: tenant.id, phone: from, bookingId: accepted.id, fromWaiting: true }).catch(() => {});
              try {
                await sendWhatsAppMessage(from, reply, tenant);
              } catch (e) {
                console.error(`  ❌ فشل الإرسال: ${e.message}`);
              }
              const { notifyOwner } = await import("../../compliance/messaging.mjs");
              notifyOwner(tenant, "booking", `📅 حجز من الانتظار: ${accepted.service} — ${from} (${accepted.id})`).catch(() => {});
              console.log(`  📋 تأكيد من الانتظار ${accepted.id} ${from}`);
            } catch (e) {
              const taken = e?.code === "SLOT_TAKEN" || e?.code === "P2002";
              await setBookingState(tenant.id, from, null);
              const free = taken ? await freeSlots(tenant.id, bookingDay(bookingState.day), tenant.features?.bookingSlots) : [];
              const reply = taken
                ? (free.length
                    ? `للأسف الموعد انحجز قبل لحظات 😅 الفارغ مثل: ${free.join("، ")} — اختر واحد؟ أو "انتظار"`
                    : `للأسف كل الأوقات انحجزت 😅 ابعت "حجز" لبدء حجز جديد أو "انتظار" للقائمة.`)
                : `للأسف تعذر تأكيد العرض 🤔 ابعت "حجز" لموعد جديد.`;
              await pushHistory(from, "user", text, tenant);
              await pushHistory(from, "assistant", reply, tenant);
              try {
                if (taken && free.length) await sendButtons(from, reply, free.slice(0, 3).map((s) => ({ id: `slot_${s}`, title: `🕐 ${s}` })), tenant);
                else await sendWhatsAppMessage(from, reply, tenant);
              } catch (se) { console.error(`  ❌ فشل الإرسال: ${se.message}`); }
              console.log(`  ⚠️ فشل تأكيد العرض ${tenant.id} ${from}: ${e.message}`);
            }
            console.log(`${"─".repeat(60)}\n`);
            continue;
          }

          // 2) بدء الحجز
          if (wantsBooking && !bookingState) {
            const services = tenant.products || [];
            // أكثر من خدمة → خطوة اختيار الخدمة أولاً
            if (services.length > 1) {
              await setBookingState(tenant.id, from, { step: "service" });
              const reply = `تمام يا غالي 😊 بتبسط في ${tenant.name} هالخدمات:\n${services.map((s) => `• ${s.name} (${s.price} د.أ)`).join("\n")}\nأي خدمة بدك تحجز؟`;
              result = { reply, transfer_to_human: false, intent: "حجز_موعد" };
              await pushHistory(from, "user", text, tenant);
              await pushHistory(from, "assistant", reply, tenant);
              try {
                await sendButtons(from, reply, services.slice(0, 3).map((s, i) => ({ id: `svc_${i}`, title: `${s.name} (${s.price} د.أ)` })), tenant);
              } catch (e) {
                await sendWhatsAppMessage(from, reply, tenant).catch(() => {});
              }
              console.log(`  📅 بدء حجز (اختيار خدمة) ${tenant.id} للعميل ${from}`);
              console.log(`${"─".repeat(60)}\n`);
              continue;
            }
            const slots = (tenant.features.bookingSlots || []).join("، ");
            await setBookingState(tenant.id, from, { step: "slot", day: "أقرب يوم متاح" });
            const reply = `تمام يا غالي 😊 احجز موعدك في ${tenant.name}. أوقاتنا: ${tenant.features.workingHours || ""}. اختر الوقت المناسب: ${slots}. ابعت الوقت (مثال: 14:00).`;
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

          // 2ب) اختيار الخدمة (عيادات/خدمات متعددة)
          if (bookingState?.step === "service") {
            const services = tenant.products || [];
            const chosen = services.find((s, i) => {
              if (buttonId && buttonId.startsWith("svc_")) return Number(buttonId.replace("svc_", "")) === i;
              const kw = (s.name || "").split(" ")[0].toLowerCase();
              return kw && text.toLowerCase().includes(kw);
            });
            if (chosen) {
              await setBookingState(tenant.id, from, { step: "slot", day: "أقرب يوم متاح", service: chosen.name });
              const slots = (tenant.features.bookingSlots || []).join("، ");
              const reply = `ممتاز ${chosen.name} 👍 اختر الوقت المناسب: ${slots}. ابعت الوقت (مثال: 14:00).`;
              await pushHistory(from, "user", text, tenant);
              await pushHistory(from, "assistant", reply, tenant);
              try {
                await sendButtons(from, reply, (tenant.features.bookingSlots || []).slice(0, 3).map((s) => ({ id: `slot_${s}`, title: `🕐 ${s}` })), tenant);
              } catch (e) {
                await sendWhatsAppMessage(from, reply, tenant).catch(() => {});
              }
              console.log(`  🩺 اختيرت الخدمة ${chosen.name} ${tenant.id} ${from}`);
              console.log(`${"─".repeat(60)}\n`);
              continue;
            }
            const reask = `ما فهمت أي خدمة قصدك يا غالي 😅 اختر من القائمة:`;
            await pushHistory(from, "user", text, tenant);
            await pushHistory(from, "assistant", reask, tenant);
            try {
              await sendButtons(from, reask, services.slice(0, 3).map((s, i) => ({ id: `svc_${i}`, title: `${s.name} (${s.price} د.أ)` })), tenant);
            } catch (e) {
              await sendWhatsAppMessage(from, reask, tenant).catch(() => {});
            }
            console.log(`${"─".repeat(60)}\n`);
            continue;
          }

          // 3) استكمال الحجز (اختار وقت)
          if (bookingState?.step === "slot") {
            // دعم الأرقام العربية-الهندية (١٤:٠٠) بتوحيدها قبل المطابقة
            const norm = text.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
              .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)));
            const slotMatch = norm.match(/(\d{1,2}:\d{2})/) || (buttonId?.startsWith("slot_") ? [null, buttonId.replace("slot_", "")] : null);
            if (slotMatch) {
              const slot = slotMatch[1];
              const service = bookingState.service || (tenant.products || [])[0]?.name || "موعد";
              const day = bookingDay(bookingState.day || "أقرب يوم متاح");
              // سياسة ثابتة: موعد واحد لكل وقت (طبيب/مزرعة/تجميل — لا حجوزات مزدوجة أبداً)
              if (await isSlotTaken(tenant.id, day, slot)) {
                const free = await freeSlots(tenant.id, day, tenant.features?.bookingSlots);
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
                  const free = await freeSlots(tenant.id, day, tenant.features?.bookingSlots);
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
              const reply = `تم تأكيد حجزك يا غالي ✅ ${service} - يوم ${day} - الساعة ${slot} (${booking.id}). بنتشرف فيك في ${tenant.name}! لإلغاء/تعديل ابعت "أريد موظف".`;
              result = { reply, transfer_to_human: false, intent: "حجز_موعد" };
              await pushHistory(from, "user", text, tenant);
              await pushHistory(from, "assistant", reply, tenant);
              logEvent("booking", { tenantId: tenant.id, phone: from, bookingId: booking.id, service, slot }).catch(() => {});
              try {
                await sendWhatsAppMessage(from, reply, tenant);
              } catch (e) {
                console.error(`  ❌ فشل الإرسال: ${e.message}`);
              }
              // المالك يتفرج من واتسابه: إشعار فوري بالحجز الجديد
              const { notifyOwner } = await import("../../compliance/messaging.mjs");
              notifyOwner(tenant, "booking", `📅 حجز جديد: ${service} — ${from} (${name}) — الساعة ${slot} (${booking.id})`).catch(() => {});
              console.log(`  📅 تأكيد حجز ${booking.id} ${tenant.id} ${from} ${slot}`);
              console.log(`${"─".repeat(60)}\n`);
              continue;
            } else if (!/موظف|انسان|بشري|انتظار|قائمة|إلغ|الغى|الغاء|الغائ/.test(text)) {
              // في خطوة الوقت لكن الرسالة بلا ساعة — أعد عرض الأزرار (لا نتركه بلا مسار)
              const hint = `تمام يا غالي 😊 اختر الساعة من القائمة أو ابعت الوقت بصيغة رقمية (مثال: 14:00):`;
              await pushHistory(from, "user", text, tenant);
              await pushHistory(from, "assistant", hint, tenant);
              try {
                await sendButtons(from, hint, (tenant.features.bookingSlots || []).slice(0, 3).map((s) => ({ id: `slot_${s}`, title: `🕐 ${s}` })), tenant);
              } catch (e) {
                await sendWhatsAppMessage(from, hint, tenant).catch(() => {});
              }
              console.log(`${"─".repeat(60)}\n`);
              continue;
            }
          }

          // —— المسار العادي: AI ——
          // بعد التصعيد: رد حتمي قصير بدل يانصيب الذكاء (لا تحية عشوائية لـ "؟" بعد طلب موظف)
          const { storeGet: sg2 } = await import("../../../store.mjs");
          const escActive = await sg2(`esc:${tenant?.id}::${from}`).catch(() => null);
          if (escActive) {
            result = {
              reply: "طلبك عند الفريق يا غالي 🙏 بيرد عليك بأقرب وقت.",
              transfer_to_human: true,
              intent: "تصعيد",
            };
            console.log(`  🤖 ${tenant?.botName || "كريم"} -> تصعيد مستمر (رد حتمي، بلا AI)`);
          } else {
            result = await processCustomerMessage(text, from, tenant);
          }

          console.log(`  🤖 ${tenant?.botName || "كريم"} -> intent=${result.intent} transfer=${result.transfer_to_human}`);
          console.log(`  💬 الرد: "${result.reply}"`);
          logEvent("message", { tenantId: tenant?.id, phone: from, intent: result.intent, transfer: result.transfer_to_human, text: text.slice(0, 200) }).catch(() => {});

          if (result.transfer_to_human) {
            console.log(`  🚨 تنبيه: العميل ${from} طلب التصعيد للبشر!`);
            // سياسة المالك: بلا تنحٍ إطلاقاً — البوت يبقى يرد دائماً، والموظف يُنبَّه فقط.
            // تنبيه واحد لكل محادثة كل 10 دقائق (بلا سبام). الإسكات يدوي فقط بزر ⏸
            const { storeGet, storeSet } = await import("../../../store.mjs");
            const escKey = `esc:${tenant?.id}::${from}`;
            const alreadyEscalated = await storeGet(escKey).catch(() => null);
            if (!alreadyEscalated) {
              await storeSet(escKey, { at: Date.now() }, 10 * 60 * 1000).catch(() => {});
              notifyStaff(tenant, `عميل يطلب موظفاً: ${from} (${name}) — "${text.slice(0, 120)}"`, { except: from }).catch(() => {});
            } else {
              console.log(`  🚨 تصعيد مكرر من ${from} — بلا تنبيه جديد`);
            }
          }

          // —— إنشاء طلب + تعليمات الدفع عند نية الشراء (متاجر) ——
          const wantsPay =
            result.intent === "شراء" &&
            (tenant?.businessType === "sport-store" || (tenant.products || []).length > 0) &&
            !tenant?.features?.booking;
          if (wantsPay) {
            try {
              await createOrderWithPayment(tenant, from, name, text, result);
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

// ──────────────────────────────────────────────
// P0-3 — إعادة المعالجة عند الإقلاع: أي حمولة سُجّلت قبل 200 ولم تُمسح
// (انقطاع/إعادة نشر أثناء الطيران) تُعاد معالجتها.
// الـ dedup بالـ wamid يجعل هذا آمناً تماماً: المعالجة المكتملة تُتخطى، والناقصة تُستكمل.
// ──────────────────────────────────────────────
export async function replayInflightWebhooks() {
  let keys = [];
  try {
    keys = await storeKeys("wbh:inflight:");
  } catch {
    return;
  }
  if (!keys.length) return;
  console.log(`  ♻️ إعادة معالجة ${keys.length} حمولة علّقت أثناء الطيران...`);
  for (const key of keys) {
    let rec = null;
    try {
      rec = await storeGet(key);
    } catch { /*  تجاهل */ }
    if (!rec?.body) {
      await storeDel(key).catch(() => {});
      continue;
    }
    const firstMsg = rec.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const sender = firstMsg?.from ? `sender:${firstMsg.from}` : "unknown";
    const label = `replay:${key.split(":").slice(-1)[0]}`;
    webhookQueue.enqueueOrdered(sender, label, async () => {
      try {
        await processWebhookBody(rec.body);
      } finally {
        await storeDel(key).catch(() => {});
      }
    });
  }
}
