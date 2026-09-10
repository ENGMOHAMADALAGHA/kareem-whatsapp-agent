import { tenantDb, systemDb } from "./src/security/tenantGuard.mjs";
import crypto from "node:crypto";
import { db } from "./db.mjs";
import { normalizePhone } from "./src/utils/phone.mjs";

const nid = (prefix) => `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

// كل الدوال هنا تمر عبر tenantDb — لا وصول مباشر لـ Prisma.

export async function createOrder({ tenantId, phone, name, items, total, currency = "USD" }) {
  phone = normalizePhone(phone);
  const row = await tenantDb(tenantId).order.create({
    data: {
      id: nid("ord"),
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

// قراءة داخلية لطلب واحد مع نطاقه (تُستخدم عند تأكيد الدفع — ليست صفحة عامة)
export async function getPublicOrder(id) {
  const { systemDb } = await import("./src/security/tenantGuard.mjs");
  const row = await systemDb("orders:internal").order.findUnique({
    where: { id },
    select: { id: true, tenantId: true, phone: true, items: true, total: true, currency: true, status: true },
  });
  if (!row) return null;
  return { id: row.id, tenantId: row.tenantId, phone: row.phone, items: row.items, total: Number(row.total), currency: row.currency, status: row.status };
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
  // التأكيد فقط عبر تحقق الإيصال أو الموظف — تحديث ذري يمنع التأكيد المزدوج
  const row = await tenantDb(tenantId).order.update({
    where: { id },
    data: { status: "paid", paidAt: new Date() },
  }).catch(() => null);
  return rowToOrder(row);
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

// حالات الطلبات المعلقة (تشمل قيد المراجعة اليدوية للإيصالات)
const OPEN_STATUSES = ["pending", "proof_received", "pending_review"];

// أحدث طلب معلق للرقم (لربط لقطة الشاشة به)
export async function latestPendingOrder(tenantId, phone) {
  const rows = await tenantDb(tenantId).order.findMany({
    where: { phone, status: { in: OPEN_STATUSES } },
    orderBy: { createdAt: "desc" },
    take: 1,
  });
  return rowToOrder(rows[0]);
}

// منع الطلب المكرر: طلب معلق لنفس الرقم خلال N دقيقة يُعاد استخدامه بدل الجديد
export async function findRecentPending(tenantId, phone, minutes = 30) {
  const rows = await tenantDb(tenantId).order.findMany({
    where: {
      phone,
      status: { in: OPEN_STATUSES },
      createdAt: { gte: new Date(Date.now() - minutes * 60 * 1000) },
    },
    orderBy: { createdAt: "desc" },
    take: 1,
  });
  return rowToOrder(rows[0]);
}

// تعليق الطلب للمراجعة اليدوية (إيصال مشبوه/غير مطابق) + حفظ نتيجة فحص الـ AI
export async function markOrderReview(id, tenantId, review) {
  const row = await tenantDb(tenantId).order.update({
    where: { id },
    data: { proof: review || null, status: "pending_review" },
  }).catch(() => null);
  return rowToOrder(row);
}

// ── العملة: دينار أردني افتراضياً (السوق الأردني) ──
// الدولار يُفعّل لكل عميل عبر features.currency فقط عند الطلب.
export const DEFAULT_CURRENCY = "JOD";
export function tenantCurrency(tenant) {
  const c = tenant?.features?.currency || DEFAULT_CURRENCY;
  return String(c).toUpperCase();
}
export function fmtMoney(amount, currency = DEFAULT_CURRENCY) {
  const cur = String(currency || DEFAULT_CURRENCY).toUpperCase();
  if (cur === "USD" || cur === "$") return `$${amount}`;
  return `${amount} د.أ`;
}

// سياسة الدفع: محافظ/CliQ + إيصال حصراً — لا بوابات إلكترونية ولا روابط دفع.
// التأكيد يتم فقط عبر تحقق الإيصال الآلي أو تأكيد الموظف اليدوي.

// تقدير الإجمالي والصنف من نص المحادثة (بسيط وقابل للتطوير)
// تقدير الإجمالي والصنف من نص المحادثة (بسيط وقابل للتطوير)
export function detectTotal(tenant, userText, replyText) {
  const all = `${userText} ${replyText}`;
  // العملة قبل الرقم ($55) أو بعده (39 دينار / 50 د.أ) — المهم وجود علامة عملة
  const m = all.match(/(?:(?:\$|د\.أ|دينار|JD)\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?\s*(?:د\.أ|دينار|JD))/g);
  if (m && m.length) {
    const nums = m.map((s) => parseFloat(s.replace(/[^\d.]/g, ""))).filter((n) => !Number.isNaN(n));
    if (nums.length) return Math.max(...nums);
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
