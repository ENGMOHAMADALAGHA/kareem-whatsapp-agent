import { tenantDb, systemDb } from "./src/security/tenantGuard.mjs";
import { db } from "./db.mjs";

// كل الدوال هنا تمر عبر tenantDb — لا وصول مباشر لـ Prisma.

export async function createOrder({ tenantId, phone, name, items, total, currency = "USD" }) {
  const row = await tenantDb(tenantId).order.create({
    data: {
      id: `ord_${Date.now().toString(36)}`,
      phone, name: name || phone,
      items, total, currency,
    },
  });
  return rowToOrder(row);
}

// قراءة مقيدة بالنطاق (للاستخدام الداخلي: webhook/admin)
export async function getOrder(id, tenantId) {
  if (!tenantId) throw new Error("getOrder يتطلب tenantId");
  return rowToOrder(await tenantDb(tenantId).order.findUnique({ where: { id } }));
}

// صفحة الدفع العامة: تعرض الإجمالي فقط، لكن تُرجع tenantId/phone للمنطق الداخلي (لا تُعرض)
// رابط الدفع capabilitiy-URL: الوصول بالرابط نفسه هو التفويض (مثل Stripe links)
export async function getPublicOrder(id) {
  const { systemDb } = await import("./src/security/tenantGuard.mjs");
  const row = await systemDb("orders:public-pay-page").order.findUnique({
    where: { id },
    select: { id: true, tenantId: true, phone: true, items: true, total: true, currency: true, status: true, stripeSessionId: true },
  });
  if (!row) return null;
  return { id: row.id, tenantId: row.tenantId, phone: row.phone, items: row.items, total: Number(row.total), currency: row.currency, status: row.status, stripeSessionId: row.stripeSessionId || null };
}

export async function listOrders(tenantId) {
  if (!tenantId) throw new Error("listOrders يتطلب tenantId — استخدم listOrdersAll للسوبر");
  const rows = await tenantDb(tenantId).order.findMany({
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  return rows.map(rowToOrder);
}

// للسوبر أدمن فقط (قائمة عامة) — مسار معلن ومراقب
export async function listOrdersAll() {
  const { systemDb } = await import("./src/security/tenantGuard.mjs");
  const rows = await systemDb("orders:listAll").order.findMany({
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  return rows.map(rowToOrder);
}

export async function markOrderPaid(id, tenantId) {
  // الدفع يُؤكَّد فقط عبر Stripe webhook (ليس عبر ?paid=1) — انظر workflows الدفع
  const row = await tenantDb(tenantId).order.update({
    where: { id },
    data: { status: "paid", paidAt: new Date() },
  }).catch(() => null);
  return rowToOrder(row);
}

export async function setOrderUrl(id, tenantId, url) {
  await tenantDb(tenantId).order.update({
    where: { id }, data: { paymentUrl: url },
  }).catch(() => null);
}

// سلة مهجورة: طلبات pending بدون دفع وبدون تذكير ومر عليها N دقيقة
export async function dueCartReminders(tenantId, { afterMinutes = 60 } = {}) {
  const rows = await tenantDb(tenantId).order.findMany({
    where: {
      status: "pending",
      cartRemindedAt: null,
      createdAt: { lt: new Date(Date.now() - afterMinutes * 60 * 1000) },
    },
  });
  return rows.map(rowToOrder);
}

// نسخة عامة للمجدول (يجمع كل البوتات ثم يعالج كل نطاق على حدة)
export async function dueCartRemindersAll({ afterMinutes = 60 } = {}) {
  const rows = await systemDb("orders:cart-sweep").order.findMany({
    where: {
      status: "pending",
      cartRemindedAt: null,
      createdAt: { lt: new Date(Date.now() - afterMinutes * 60 * 1000) },
    },
  });
  return rows.map(rowToOrder);
}

export async function markCartReminded(id, tenantId) {
  await tenantDb(tenantId).order.update({
    where: { id }, data: { cartRemindedAt: new Date() },
  }).catch(() => null);
}

function rowToOrder(r) {
  if (!r) return null;
  return {
    id: r.id, tenantId: r.tenantId, phone: r.phone, name: r.name,
    items: r.items, total: Number(r.total), currency: r.currency,
    status: r.status, paymentUrl: r.paymentUrl, proof: r.proof || null,
    cartRemindedAt: r.cartRemindedAt, createdAt: r.createdAt, paidAt: r.paidAt,
    stripeSessionId: r.stripeSessionId || null,
  };
}

// إرفاق إثبات التحويل (لقطة شاشة محفظة) بالطلب
export async function attachProof(id, tenantId, proof) {
  const row = await tenantDb(tenantId).order.update({
    where: { id },
    data: { proof, status: "proof_received" },
  }).catch(() => null);
  return rowToOrder(row);
}

// أحدث طلب معلق للرقم (لربط لقطة الشاشة به)
export async function latestPendingOrder(tenantId, phone) {
  const rows = await tenantDb(tenantId).order.findMany({
    where: { phone, status: { in: ["pending", "proof_received"] } },
    orderBy: { createdAt: "desc" },
    take: 1,
  });
  return rowToOrder(rows[0]);
}

// رابط دفع Stripe — إذا STRIPE_SECRET_KEY موجود يعمل Payment Link حقيقي، وإلا رابط محلي
export async function createPaymentLink(order, baseUrl) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    const url = `${(baseUrl || "").replace(/\/$/, "")}/pay/${order.id}`;
    await setOrderUrl(order.id, order.tenantId, url);
    return { url, mock: true };
  }
  const params = new URLSearchParams({
    "payment_method_types[]": "card",
    mode: "payment",
    success_url: `${baseUrl}/pay/${order.id}?paid=1`,
    cancel_url: `${baseUrl}/pay/${order.id}?canceled=1`,
    client_reference_id: order.id,
    "metadata[orderId]": order.id,
    "metadata[tenantId]": order.tenantId,
    "line_items[0][price_data][currency]": order.currency.toLowerCase(),
    "line_items[0][price_data][product_data][name]": `Order ${order.id}`,
    "line_items[0][price_data][unit_amount]": String(Math.round(order.total * 100)),
    "line_items[0][quantity]": "1",
  });
  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || "Stripe failed");
  await setOrderUrl(order.id, order.tenantId, data.url);
  const { tenantDb: T } = await import("./src/security/tenantGuard.mjs");
  await T(order.tenantId).order.update({
    where: { id: order.id }, data: { stripeSessionId: data.id },
  }).catch(() => null);
  return { url: data.url, mock: false, sessionId: data.id };
}

// تقدير الإجمالي والصنف من نص المحادثة (بسيط وقابل للتطوير)
// تقدير الإجمالي والصنف من نص المحادثة (بسيط وقابل للتطوير)
export function detectTotal(tenant, userText, replyText) {
  const all = `${userText} ${replyText}`;
  const m = all.match(/\$(\d+(?:\.\d+)?)/g);
  if (m && m.length) {
    const nums = m.map((s) => parseFloat(s.replace("$", "")));
    return Math.max(...nums);
  }
  const prices = (tenant.products || []).map((p) => p.price);
  const max = Math.max(...prices, 0);
  return max + (tenant.deliveryFee || 0);
}
export function detectItem(tenant, userText, replyText) {
  const all = `${userText} ${replyText}`;
  for (const p of tenant.products || []) {
    if (p.name && all.includes(p.name.split(" ")[0])) return p.name;
  }
  return (tenant.products || []).map((p) => p.name).join(" + ") || "طلب";
}
