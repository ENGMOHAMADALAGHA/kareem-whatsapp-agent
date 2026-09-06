import { db } from "./db.mjs";

export async function createOrder({ tenantId, phone, name, items, total, currency = "USD" }) {
  return db().order.create({
    data: {
      id: `ord_${Date.now().toString(36)}`,
      tenantId, phone, name: name || phone,
      items, total, currency,
    },
  }).then(rowToOrder);
}

export async function getOrder(id) {
  return rowToOrder(await db().order.findUnique({ where: { id } }));
}

export async function listOrders(tenantId) {
  const rows = await db().order.findMany({
    where: tenantId ? { tenantId } : undefined,
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  return rows.map(rowToOrder);
}

export async function markOrderPaid(id) {
  const row = await db().order.update({
    where: { id },
    data: { status: "paid", paidAt: new Date() },
  }).catch(() => null);
  return rowToOrder(row);
}

export async function setOrderUrl(id, url) {
  await db().order.update({ where: { id }, data: { paymentUrl: url } }).catch(() => null);
}

// سلة مهجورة: طلبات pending بدون دفع وبدون تذكير ومر عليها N دقيقة
export async function dueCartReminders({ afterMinutes = 60 } = {}) {
  const rows = await db().order.findMany({
    where: {
      status: "pending",
      cartRemindedAt: null,
      createdAt: { lt: new Date(Date.now() - afterMinutes * 60 * 1000) },
    },
  });
  return rows.map(rowToOrder);
}

export async function markCartReminded(id) {
  await db().order.update({
    where: { id }, data: { cartRemindedAt: new Date() },
  }).catch(() => null);
}

function rowToOrder(r) {
  if (!r) return null;
  return {
    id: r.id, tenantId: r.tenantId, phone: r.phone, name: r.name,
    items: r.items, total: Number(r.total), currency: r.currency,
    status: r.status, paymentUrl: r.paymentUrl,
    cartRemindedAt: r.cartRemindedAt, createdAt: r.createdAt, paidAt: r.paidAt,
  };
}

// رابط دفع Stripe — إذا STRIPE_SECRET_KEY موجود يعمل Payment Link حقيقي، وإلا رابط محلي
export async function createPaymentLink(order, baseUrl) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    const url = `${(baseUrl || "").replace(/\/$/, "")}/pay/${order.id}`;
    await setOrderUrl(order.id, url);
    return { url, mock: true };
  }
  const params = new URLSearchParams({
    "payment_method_types[]": "card",
    mode: "payment",
    success_url: `${baseUrl}/pay/${order.id}?paid=1`,
    cancel_url: `${baseUrl}/pay/${order.id}?canceled=1`,
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
  await setOrderUrl(order.id, data.url);
  return { url: data.url, mock: false, sessionId: data.id };
}
