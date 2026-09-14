// أدوات مساعدة مشتركة لمعالجة رسائل واتساب
import { detectItem, detectTotal, detectUserItem, detectUserTotal, tenantCurrency, fmtMoney } from "../../../../orders.mjs";
import { updateLastAssistant } from "../../../memory/conversations.mjs";
import { logEvent } from "../../../../crm.mjs";
import { ammanDateStr } from "../../../utils/time.mjs";

// تاريخ فعلي للموعد بدل السلسلة الثابتة "أقرب يوم متاح" التي كانت تجعل
// القيد (tenantId, day, slot) يحجز الساعة نفسها مرّة واحدة إلى الأبد.
export function bookingDay(day) {
  if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
  if (day && /^(اليوم|اليوم)/.test(day)) return ammanDateStr(0);
  if (day && /^(غداً|غدا)/.test(day)) return ammanDateStr(1);
  return ammanDateStr(1);
}

// إنشاء طلب + تعليمات الدفع (يُستخدم للشراء النصي وضغط أزرار المنتجات)
// القاعدة: إعادة الاستخدام فقط عند تطابق السلعة والمبلغ معاً —
// أي محور لسلعة/مبلغ مختلف (أو طلب قديم بمبلغ ملوث من كلام تسويقي) يُلغى ويُستبدل.
export async function createOrderWithPayment(tenant, from, name, text, result) {
  if (!tenant) return; // تحصين: لا ننشئ طلباً بلا مستأجر
  const { findRecentPending, cancelOpenOrders, createOrder } = await import("../../../../orders.mjs");
  const item = detectItem(tenant, text, result.reply);
  const freshTotal = detectTotal(tenant, text, result.reply || "");
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
      // (يرمي عند عطل DB — المتصل يسجل ويكمل برد أمين بلا طلب وهمي)
      const killed = await cancelOpenOrders(tenant.id, from);
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
