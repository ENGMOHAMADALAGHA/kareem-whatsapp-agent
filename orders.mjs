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
  // ادّعاء ذري قبل الإرسال: يمنع تكرار رسالة السلة بين المؤقت والتشغيل اليدوي
  const r = await tenantDb(tenantId).order.updateMany({
    where: { id, cartRemindedAt: null },
    data: { cartRemindedAt: new Date() },
  }).catch(() => ({ count: 0 }));
  return r?.count > 0;
}

export async function unmarkCartReminded(id, tenantId) {
  await tenantDb(tenantId).order.updateMany({
    where: { id },
    data: { cartRemindedAt: null },
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

// إلغاء كل الطلبات المفتوحة للرقم (نسيان/استبدال) — يرجع عدد الملغاة
export async function cancelOpenOrders(tenantId, phone) {
  const T = tenantDb(tenantId);
  const rows = await T.order.findMany({
    where: { phone: normalizePhone(phone), status: { in: OPEN_STATUSES } },
  }).catch(() => []);
  let n = 0;
  for (const r of rows) {
    await T.order.update({ where: { id: r.id }, data: { status: "canceled" } }).catch(() => null);
    n++;
  }
  return n;
}

// مبلغ صريح بكلام العميل نفسه (لا من كلام البوت) — أو null
export function detectUserTotal(userText) {
  const m = String(userText || "").match(/(\d+(?:\.\d+)?)\s*(?:د\.أ|دينار|JD)|\$\s*(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const v = parseFloat(m[1] ?? m[2]);
  return !Number.isNaN(v) && v > 0 ? v : null;
}

// صنف مذكور بكلام العميل نفسه — أو null (لا تخمين من كلام البوت)
export function detectUserItem(tenant, userText) {
  const matched = (tenant?.products || []).filter((p) => p.name && String(userText || "").includes(p.name.split(" ")[0]));
  if (!matched.length) return null;
  if (matched.length >= 2) return matched.map((p) => p.name).join(" + ");
  return matched[0].name;
}

// الإجمالي الحتمي لصنف معروف: مبلغ العميل الصريح أولاً، ثم سعر الكتالوج + توصيل.
// كلام البوت التسويقي (عروض/باندل) لا يحدد المبلغ أبداً — هذا كان يولّد طلب حزام بـ 70.
export function totalForItem(tenant, itemName, userText = "") {
  const explicit = detectUserTotal(userText);
  if (explicit !== null) return explicit;
  const fee = Number(tenant?.deliveryFee || 0);
  const products = tenant?.products || [];
  const item = String(itemName || "");
  if (item.includes("+")) {
    const bundle = tenant?.bundleOffer?.enabled ? Number(tenant.bundleOffer.price) : null;
    if (bundle !== null && !Number.isNaN(bundle)) return bundle;
  } else {
    const first = item.split(" ")[0];
    const p = products.find((x) => x.name && (x.name === item || (first && x.name.split(" ")[0] === first)));
    if (p) return Number(p.price) + fee;
  }
  return Math.max(...products.map((x) => Number(x.price)), 0) + fee;
}

// تعليق الطلب للمراجعة اليدوية (إيصال مشبوه/غير مطابق) + حفظ نتيجة فحص الـ AI
export async function markOrderReview(id, tenantId, review) {
  const row = await tenantDb(tenantId).order.update({
    where: { id },
    data: { proof: review || null, status: "pending_review" },
  }).catch(() => null);
  return rowToOrder(row);
}

// رفض الإيصال يدوياً بسبب مكتوب: يُسجَّل السبب بالطلب ويُخطر العميل (تغلق الحلقة)
export async function rejectOrder(id, tenantId, { reason, by }) {
  if (!reason || !String(reason).trim()) throw new Error("سبب الرفض مطلوب");
  const T = tenantDb(tenantId);
  const current = await T.order.findFirst({ where: { id } }).catch(() => null);
  if (!current) return null;
  const proof = { ...(current.proof || {}), review: { by: by || "acp", reason: String(reason).trim(), at: new Date().toISOString() } };
  const row = await T.order.update({ where: { id }, data: { proof, status: "rejected" } }).catch(() => null);
  return rowToOrder(row);
}

// طلب مرفوض مؤخراً (نافذة سماح لإعادة المحاولة بعد رفض الإيصال) — لا تهمل تجربة عميل دفع فعلياً
export async function latestRejectedOrder(tenantId, phone, withinHours = 48) {
  const rows = await tenantDb(tenantId).order.findMany({
    where: { phone, status: "rejected", createdAt: { gte: new Date(Date.now() - withinHours * 60 * 60 * 1000) } },
    orderBy: { createdAt: "desc" },
    take: 1,
  });
  return rowToOrder(rows[0]);
}

// إعادة فتح طلب مرفوض بعد وصول لقطة جديدة (ذري: updateMany بشرط rejected يمنع إعادة فتح مزدوجة)
export async function reopenRejectedOrder(id, tenantId) {
  const updated = await tenantDb(tenantId).order.updateMany({
    where: { id, status: "rejected" },
    data: { status: "pending" },
  }).catch(() => ({ count: 0 }));
  if (!updated || updated.count === 0) return null;
  const row = await tenantDb(tenantId).order.findUnique({
    where: { id },
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

// تقدير الإجمالي والصنف من نص المحادثة.
// الحقيقة التجارية هي كتالوج الأسعار لا نص العميل غير الموثوق:
// المبلغ الصريح يُقبل فقط إذا طابق قيمة كتالوج صحيحة (سلعة + توصيل / باندل) —
// أي مبلغ صريح لا يطابق الكتالوج (مثل "الإجمالي 55" من سياق عرض جانبي لسلعة أخرى)
// يُرفض ويُعتمد إجمالي السلعة المختارة بدلاً منه.
export function detectTotal(tenant, userText, replyText) {
  const all = `${userText} ${replyText}`;
  const fee = Number(tenant?.deliveryFee || 0);
  const products = tenant?.products || [];
  const prices = products.map((p) => Number(p.price));
  const knownTotals = prices.map((p) => p + fee); // إجمالي سلعة + توصيل
  const bundle = tenant?.bundleOffer?.enabled ? Number(tenant.bundleOffer.price) : null;
  const maxKnown = Math.max(...prices, 0) + fee;

  // السلعة المختارة من الكتالوج (تحديد دقيق بالاسم الكامل أولاً ثم الكلمة الأولى)
  const item = detectItem(tenant, userText, replyText);
  const picked = products.find((p) => p.name && item.includes(p.name));
  const pickedTotal = picked ? Number(picked.price) + fee : null;

  // المبالغ المرشّحة في النص (بصيغة عملة)
  const nums = (all.match(/(?:(?:\$|د\.أ|دينار|JD)\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?\s*(?:د\.أ|دينار|JD))/g) || [])
    .map((s) => parseFloat(s.replace(/[^\d.]/g, "")))
    .filter((n) => !Number.isNaN(n) && n > 0);

  // مبلغ صريح في جملة "الإجمالي" — يُقبل فقط ضمن قيم الكتالوج
  const mTotal = all.match(/(?:الإجمالي|المجموع|الاجمالي|الإجمالى|المجموع الكلي|total)[^0-9$]*(?:(?:\$|د\.أ|دينار|JD)\s*)?(\d+(?:\.\d+)?)/i);
  const explicit = mTotal ? parseFloat(mTotal[1]) : null;
  const inTotals = (v) => knownTotals.some((t) => Math.abs(v - t) < 0.001);
  const inPrices = (v) => prices.some((p) => Math.abs(v - p) < 0.001);
  const inAny = (v) => nums.some((n) => Math.abs(v - n) < 0.001);

  if (explicit !== null && !Number.isNaN(explicit)) {
    if (pickedTotal !== null && Math.abs(explicit - pickedTotal) < 0.001) return pickedTotal;
    if (bundle !== null && Math.abs(explicit - bundle) < 0.001) return bundle;
    if (inTotals(explicit)) {
      if (pickedTotal !== null) return pickedTotal; // إجمالي سلعة أجنبية في سياق عرض جانبي → نصوّب للسلعة المختارة
      return explicit;
    }
    if (inPrices(explicit)) return pickedTotal ?? explicit + fee;
    // مبلغ صريح غير معروف للكتالوج: لا نتبنّاه — نعتمد حقيقة السلعة المختارة
    console.warn(`  ⚠️ مبلغ صريح ${explicit} لا يطابق كتالوج الأسعار — اعتماد ${pickedTotal ?? maxKnown} (سلعة المختارة)`);
    return pickedTotal ?? maxKnown;
  }

  // لا مبلغ صريح: مطابقة أرقام النص مع قيم الكتالوج — أولوية السلعة المختارة
  if (pickedTotal !== null && inAny(pickedTotal)) return pickedTotal;
  for (const t of knownTotals) if (inAny(t)) return t;
  if (bundle !== null && inAny(bundle)) return bundle;
  for (const p of prices) if (inAny(p)) return p + fee;
  return maxKnown;
}
export function detectItem(tenant, userText, replyText) {
  const all = `${userText} ${replyText}`;
  const products = tenant?.products || [];
  // تطابق الاسم الكامل أولاً (يمنع دمج "حذاء ركض" و"حذاء شتوي" لكلمة أولى مشتركة)
  const full = products.filter((p) => p.name && all.includes(p.name));
  const tokens = products.filter((p) => p.name && all.includes(p.name.split(" ")[0]));
  const matched = full.length ? full : tokens;
  if (matched.length >= 2) return matched.map((p) => p.name).join(" + ");
  return matched[0]?.name || products.map((p) => p.name).join(" + ") || "طلب";
}
