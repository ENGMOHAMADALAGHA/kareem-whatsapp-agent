import crypto from "node:crypto";
import { getPublicOrder, markOrderPaid } from "../../../orders.mjs";
import { getTenantFull } from "../../../tenants.mjs";
import { sendWhatsAppMessage } from "../../whatsapp/sender.mjs";
import { pushHistory } from "../../memory/conversations.mjs";
import { requestCsat } from "../../../engage.mjs";
import { logEvent } from "../../../crm.mjs";

// منطق واحد لتأكيد الدفع (يُستخدم من /pay ومن Stripe webhook)
export async function finalizePaidOrder(orderId, source = "manual") {
  const order = await getPublicOrder(orderId);
  if (!order) throw new Error("الطلب غير موجود");
  if (order.status === "paid") return { already: true, order };
  await markOrderPaid(order.id, order.tenantId);
  logEvent("order_paid", {
    tenantId: order.tenantId, phone: order.phone,
    orderId: order.id, total: order.total, source,
  }).catch(() => {});
  const tenant = await getTenantFull(order.tenantId);
  if (tenant) {
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

// تحقق توقيع Stripe (بدون مكتبة خارجية)
export function verifyStripeSignature(rawBody, header, secret) {
  if (!secret || !header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.trim().split("=")));
  if (!parts.t || !parts.v1) return false;
  // حماية من هجمات إعادة التشغيل: فارق 5 دقائق كحد أقصى
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${parts.t}.${rawBody}`).digest("hex");
  const a = Buffer.from(parts.v1);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function registerBillingRoutes(app) {
  // Webhook Stripe الرسمي — المصدر الوحيد الموثوق لتأكيد الدفع
  app.post("/webhooks/stripe", async (req, res) => {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) return res.status(500).json({ ok: false, error: "STRIPE_WEBHOOK_SECRET غير مضبوط" });
    const raw = req.rawBody ? req.rawBody.toString("utf8") : JSON.stringify(req.body);
    if (!verifyStripeSignature(raw, req.headers["stripe-signature"] || "", secret)) {
      console.warn("  ❌ توقيع Stripe غير صالح");
      return res.sendStatus(403);
    }
    const event = req.body;
    if (event.type === "checkout.session.completed") {
      const orderId = event.data?.object?.metadata?.orderId || event.data?.object?.client_reference_id;
      if (orderId) {
        try {
          await finalizePaidOrder(orderId, "stripe");
          console.log(`  💳 تأكيد Stripe للطلب ${orderId}`);
        } catch (e) {
          console.error(`  ❌ خطأ تأكيد Stripe: ${e.message}`);
        }
      }
    }
    res.json({ received: true });
  });
}
