// معالج الذكاء: أزرار المنتجات + مسار AI العادي (تصعيد + طلب + إرسال ذكي)
import { processCustomerMessage } from "../../../../ai/kareem.mjs";
import { sendWhatsAppMessage, sendButtons, sendImage, defaultButtonsFor } from "../../../../whatsapp/sender.mjs";
import { getHistory, pushHistory } from "../../../../memory/conversations.mjs";
import { notifyStaff } from "../../../../compliance/messaging.mjs";
import { tenantCurrency, fmtMoney } from "../../../../../orders.mjs";
import { logEvent } from "../../../../../crm.mjs";
import { createOrderWithPayment } from "../helpers.mjs";

// 1) ضغطة زر منتج لكريم: اعرض الصورة + أنشئ الطلب فوراً + تعليمات الدفع
export async function handleProductButtons(ctx) {
  const { from, tenant, name, buttonId } = ctx;
  if (!(tenant?.id === "kareem-sport" && buttonId && /^(buy_shoes|buy_belt|bundle)$/.test(buttonId))) return false;
  const map = {
    buy_shoes: "أريد شراء حذاء الركض",
    buy_belt: "أريد شراء حزام الظهر",
    bundle: "أريد حزام الظهر والحذاء معاً",
  };
  const result = await processCustomerMessage(map[buttonId], from, tenant);
  ctx.result = result;
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
    console.log(`  🤖 ${tenant?.botName || "كريم"} -> تصعيد مستمر (رد حتمي، بلا AI)`);
  } else {
    result = await processCustomerMessage(text, from, tenant);
  }
  ctx.result = result;

  console.log(`  🤖 ${tenant?.botName || "كريم"} -> intent=${result.intent} transfer=${result.transfer_to_human}`);
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

  // —— إنشاء طلب + تعليمات الدفع عند نية الشراء (متاجر) ——
  const wantsPay =
    result.intent === "شراء" &&
    (tenant?.businessType === "sport-store" || (tenant.products || []).length > 0) &&
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
  return true;
}
