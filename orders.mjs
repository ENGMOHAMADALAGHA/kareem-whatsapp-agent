import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, isDbEnabled } from "./db.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, "orders.json");

// —— JSON fallback (يعمل فقط بدون DATABASE_URL) ——
function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf-8")).orders || [];
  } catch {
    return [];
  }
}
function save(all) {
  fs.writeFileSync(FILE, JSON.stringify({ orders: all }, null, 2) + "\n");
}

export async function createOrder({ tenantId, phone, name, items, total, currency = "USD" }) {
  const id = `ord_${Date.now().toString(36)}`;
  if (isDbEnabled()) {
    await db().query(
      `INSERT INTO orders (id, tenant_id, phone, name, items, total, currency) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, tenantId, phone, name || phone, JSON.stringify(items), total, currency]
    );
    return { id, tenantId, phone, name: name || phone, items, total, currency, status: "pending", paymentUrl: null };
  }
  const all = load();
  const order = {
    id, tenantId, phone, name: name || phone,
    items, total, currency,
    status: "pending",
    paymentUrl: null,
    createdAt: new Date().toISOString(),
  };
  all.push(order);
  save(all);
  return order;
}

export async function getOrder(id) {
  if (isDbEnabled()) {
    const r = await db().query(`SELECT * FROM orders WHERE id=$1`, [id]);
    return rowToOrder(r.rows[0]);
  }
  return load().find((o) => o.id === id) || null;
}

export async function listOrders(tenantId) {
  if (isDbEnabled()) {
    const r = tenantId
      ? await db().query(`SELECT * FROM orders WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 500`, [tenantId])
      : await db().query(`SELECT * FROM orders ORDER BY created_at DESC LIMIT 500`);
    return r.rows.map(rowToOrder);
  }
  const all = load();
  return all.filter((o) => !tenantId || o.tenantId === tenantId);
}

export async function markOrderPaid(id) {
  if (isDbEnabled()) {
    const r = await db().query(
      `UPDATE orders SET status='paid', paid_at=NOW() WHERE id=$1 RETURNING *`, [id]
    );
    return rowToOrder(r.rows[0]);
  }
  const all = load();
  const o = all.find((x) => x.id === id);
  if (!o) return null;
  o.status = "paid";
  o.paidAt = new Date().toISOString();
  save(all);
  return o;
}

async function setOrderUrl(id, url) {
  if (isDbEnabled()) {
    await db().query(`UPDATE orders SET payment_url=$2 WHERE id=$1`, [id, url]);
    return;
  }
  const all = load();
  const o = all.find((x) => x.id === id);
  if (!o) return null;
  o.paymentUrl = url;
  save(all);
  return o;
}

// سلة مهجورة: طلبات pending بدون دفع وبدون تذكير ومر عليها N دقيقة
export async function dueCartReminders({ afterMinutes = 60 } = {}) {
  if (isDbEnabled()) {
    const r = await db().query(
      `SELECT * FROM orders WHERE status='pending' AND cart_reminded_at IS NULL AND created_at < NOW() - ($1 || ' minutes')::interval`,
      [afterMinutes]
    );
    return r.rows.map(rowToOrder);
  }
  const now = Date.now();
  return load().filter((o) => {
    if (o.status !== "pending" || o.cartRemindedAt) return false;
    const created = new Date(o.createdAt).getTime();
    return now - created >= afterMinutes * 60 * 1000;
  });
}

export async function markCartReminded(id) {
  if (isDbEnabled()) {
    await db().query(`UPDATE orders SET cart_reminded_at=NOW() WHERE id=$1`, [id]);
    return;
  }
  const all = load();
  const o = all.find((x) => x.id === id);
  if (!o) return null;
  o.cartRemindedAt = new Date().toISOString();
  save(all);
  return o;
}

function rowToOrder(r) {
  if (!r) return null;
  return {
    id: r.id,
    tenantId: r.tenant_id,
    phone: r.phone,
    name: r.name,
    items: typeof r.items === "string" ? JSON.parse(r.items) : r.items,
    total: Number(r.total),
    currency: r.currency,
    status: r.status,
    paymentUrl: r.payment_url,
    cartRemindedAt: r.cart_reminded_at,
    createdAt: r.created_at,
    paidAt: r.paid_at,
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
  // Stripe Checkout Sessions
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
