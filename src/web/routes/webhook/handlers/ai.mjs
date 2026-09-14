// معالج الذكاء: أزرار المنتجات + مسار AI العادي (تصعيد + طلب + إرسال ذكي)
import { processCustomerMessage } from "../../../../ai/engine.mjs";
import { sendWhatsAppMessage, sendButtons, sendImage, defaultButtonsFor } from "../../../../whatsapp/sender.mjs";
import { getHistory, pushHistory } from "../../../../memory/conversations.mjs";
import { notifyStaff } from "../../../../compliance/messaging.mjs";
import { tenantCurrency, fmtMoney } from "../../../../../orders.mjs";
import { logEvent } from "../../../../../crm.mjs";
import { createOrderWithPayment } from "../helpers.mjs";

// 1) ضغطة زر منتج بخرائط البوت نفسه: features.buttonActions = { buttonId: "رسالة تُرسل للذكاء" }
// أي بوت يعرّف أزراره وأفعالها ببياناته — لا ids مكتوبة بالكود لأي بوت.
export async function handleProductButtons(ctx) {
  const { from, tenant, name, buttonId } = ctx;
  const actions = tenant?.features?.buttonActions || {};
  if (!buttonId || !actions[buttonId]) return false;
  const message = actions[buttonId];
  const result = await processCustomerMessage(message, from, tenant);
  ctx.result = result;
  try {
    if (result.intent === "شراء") {
      // إنشاء طلب + إرفاق تعليمات الدفع بنفس الرسالة (لا حلقة تأكيد ميتة)
      await createOrderWithPayment(tenant, from, name, message, result);
    }
    const prod = (tenant.products || []).find((p) => p.buttonId === buttonId) || null;
    if (prod?.image && tenant?.features?.images) await sendImage(from, prod.image, `${prod.name} - ${fmtMoney(prod.price, tenantCurrency(tenant))}`, tenant);
    await sendWhatsAppMessage(from, result.reply, tenant);
  } catch (sendErr) {
    console.error(`  ❌ فشل الإرسال: ${sendErr.message}`);
  }
  console.log(`  🤖 ${tenant?.botName} -> intent=${result.intent} (زر ${buttonId})`);
  console.log(`${"─".repeat(60)}\n`);
  return true;
}

// —— المسار العادي: AI ——
export async function handleAi(ctx) {
  const { from, tenant, text } = ctx;
  // بعد التصعيد: رد حتمي قصير بدل يانصيب الذكاء (لا تحية عشوائية لـ "؟" بعد طلب موظف)
  const { storeGet: sg2 } = await import("../../../../../store.mjs");
  const escActive = await sg2(`esc:${tenant?.id}::${from}`).catch(() => null);
  let result;
  if (escActive) {
    result = {
      reply: "طلبك عند الفريق يا غالي 🙏 بيرد عليك بأقرب وقت.",
      transfer_to_human: true,
      intent: "تصعيد",
    };
    console.log(`  🤖 ${tenant?.botName || "وصل"} -> تصعيد مستمر (رد حتمي، بلا AI)`);
  } else {
    result = await processCustomerMessage(text, from, tenant);
  }
  ctx.result = result;

  console.log(`  🤖 ${tenant?.botName || "وصل"} -> intent=${result.intent} transfer=${result.transfer_to_human}`);
  console.log(`  💬 الرد: "${result.reply}"`);
  logEvent("message", { tenantId: tenant?.id, phone: from, intent: result.intent, transfer: result.transfer_to_human, text: text.slice(0, 200) }).catch(() => {});

  if (result.transfer_to_human) {
    console.log(`  🚨 تنبيه: العميل ${from} طلب التصعيد للبشر!`);
    // سياسة المالك: بلا تنحٍ إطلاقاً — البوت يبقى يرد دائماً، والموظف يُنبَّه فقط.
    // تنبيه واحد لكل محادثة كل 10 دقائق (بلا سبام). الإسكات يدوي فقط بزر ⏸
    const { storeGet, storeSet } = await import("../../../../../store.mjs");
    const escKey = `esc:${tenant?.id}::${from}`;
    const alreadyEscalated = await storeGet(escKey).catch(() => null);
    if (!alreadyEscalated) {
      await storeSet(escKey, { at: Date.now() }, 10 * 60 * 1000).catch(() => {});
      notifyStaff(tenant, `عميل يطلب موظفاً: ${from} (${ctx.name}) — "${text.slice(0, 120)}"`, { except: from }).catch(() => {});
    } else {
      console.log(`  🚨 تصعيد مكرر من ${from} — بلا تنبيه جديد`);
    }
  }

  // —— إنشاء طلب + تعليمات الدفع عند نية الشراء (أي متجر بمنتجات، بلا حجز) ——
  const wantsPay =
    result.intent === "شراء" &&
    (tenant?.products || []).length > 0 &&
    !tenant?.features?.booking;
  if (wantsPay) {
    try {
      await createOrderWithPayment(tenant, from, ctx.name, text, result);
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
      // أول عرض للمنتجات: أرفق أزرار تلقائياً حسب إعداد البوت —
      // features.autoButtonsFirstN (عدد الرسائل الأولى) + autoButtonsKeywords (كلمات تستحق الأزرار)
      const autoN = Number(tenant?.features?.autoButtonsFirstN || 0);
      const autoKw = tenant?.features?.autoButtonsKeywords || [];
      const histLen = (await getHistory(from, tenant)).length;
      await sendWhatsAppMessage(from, result.reply, tenant);
      if (autoN > 0 && histLen <= autoN && (!autoKw.length || autoKw.some((k) => result.reply.includes(k)))) {
        await sendButtons(from, "اختار بسرعة 👇", await defaultButtonsFor(tenant), tenant).catch(() => {});
      }
    }
  } catch (sendErr) {
    console.error(`  ❌ فشل إرسال الرد للعميل ${from}: ${sendErr.message}`);
  }

  console.log(`${"─".repeat(60)}\n`);
  return true;
}
