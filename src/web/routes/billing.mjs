import { getPublicOrder, markOrderPaid, fmtMoney } from "../../../orders.mjs";
import { getTenantFull } from "../../../tenants.mjs";
import { sendWhatsAppMessage } from "../../whatsapp/sender.mjs";
import { pushHistory } from "../../memory/conversations.mjs";
import { requestCsat } from "../../../engage.mjs";
import { logEvent } from "../../../crm.mjs";

// سياسة الدفع: محافظ/CliQ + إيصال حصراً — لا بوابات إلكترونية.
// التأكيد يتم فقط عبر تحقق الإيصال الآلي (receipt-ai) أو تأكيد الموظف اليدوي.

// منطق واحد لتأكيد الدفع (يُستخدم من تحقق الإيصال ومن تأكيد الموظف)
// ذري: updateMany بشرط status!=paid — المتسابق الثاني يرى count=0 فلا يكرر التنفيذ
export async function finalizePaidOrder(orderId, source = "manual", opts = {}) {
  const order = await getPublicOrder(orderId);
  if (!order) throw new Error("الطلب غير موجود");
  if (order.status === "paid") return { already: true, order };
  const { tenantDb } = await import("../../security/tenantGuard.mjs");
  const claimed = await tenantDb(order.tenantId).order.updateMany({
    where: { id: order.id, status: { not: "paid" } },
    data: { status: "paid", paidAt: new Date() },
  }).catch(() => ({ count: 0 }));
  if (!claimed || claimed.count === 0) {
    const fresh = await getPublicOrder(orderId);
    return { already: true, order: fresh || order };
  }
  logEvent("order_paid", {
    tenantId: order.tenantId, phone: order.phone,
    orderId: order.id, total: order.total, source,
  }).catch(() => {});
  // المالك يتفرج من واتسابه: إشعار فوري بالدفع المؤكد
  try {
    const { notifyOwner } = await import("../compliance/messaging.mjs");
    notifyOwner(
      await getTenantFull(order.tenantId),
      "payment",
      `💰 دفع مؤكد: طلب ${order.id} — ${fmtMoney(order.total, order.currency)} من ${order.phone} (${source === "receipt-ai" ? "تحقق تلقائي" : "يدوي"})`
    ).catch(() => {});
  } catch { /* أفضل-جهد */ }
  const tenant = await getTenantFull(order.tenantId);
  // opts.csat=false عندما يرسل المتصل رسالته الخاصة (تأكيد الموظف) — بلا رسالتين
  if (tenant && opts.csat !== false) {
    const msg = `شكراً لثقتك يا بطل! 🙏 قيّم تجربتك معنا من 1 (سيئة) إلى 5 (ممتازة) — ابعت الرقم فقط.`;
    await requestCsat(order.tenantId, order.phone, order.id);
    try {
      await sendWhatsAppMessage(order.phone, msg, tenant);
      await pushHistory(order.phone, "assistant", msg, tenant);
    } catch (e) {
      console.error(`  ❌ فشل إرسال CSAT: ${e.message}`);
    }
  }
  return { already: false, order };
}

export function registerBillingRoutes(app) {
  // لا بوابات دفع إلكترونية — الدفع محافظ/CliQ + إيصال فقط.
  // تُبقى الدالة كنقطة تسجيل مستقبلية إن تغيرت السياسة.
}
