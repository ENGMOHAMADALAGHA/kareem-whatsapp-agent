import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, "orders.json");

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

export function createOrder({ tenantId, phone, name, items, total, currency = "USD" }) {
  const all = load();
  const order = {
    id: `ord_${Date.now().toString(36)}`,
    tenantId, phone, name: name || phone,
    items, total, currency,
    status: "pending",
    paymentUrl: null,
    createdAt: new Date().toISOString(),
  };
  all.push(order);
  save(all);
  return order;
}

export function getOrder(id) {
  return load().find((o) => o.id === id) || null;
}

export function listOrders(tenantId) {
  return load().filter((o) => !tenantId || o.tenantId === tenantId);
}

export function markOrderPaid(id) {
  const all = load();
  const o = all.find((x) => x.id === id);
  if (!o) return null;
  o.status = "paid";
  o.paidAt = new Date().toISOString();
  save(all);
  return o;
}

function setOrderUrl(id, url) {
  const all = load();
  const o = all.find((x) => x.id === id);
  if (!o) return null;
  o.paymentUrl = url;
  save(all);
  return o;
}

// رابط دفع Stripe — إذا STRIPE_SECRET_KEY موجود يعمل Payment Link حقيقي، وإلا رابط محلي
export async function createPaymentLink(order, baseUrl) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    const url = `${(baseUrl || "").replace(/\/$/, "")}/pay/${order.id}`;
    setOrderUrl(order.id, url);
    return { url, mock: true };
  }
  // Stripe Payment Links عبر Checkout Sessions
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
  setOrderUrl(order.id, data.url);
  return { url: data.url, mock: false, sessionId: data.id };
}
