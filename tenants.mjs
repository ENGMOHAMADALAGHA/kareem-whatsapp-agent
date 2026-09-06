import { systemDb } from "./src/security/tenantGuard.mjs";
import { decryptSecret, encryptSecret } from "./src/security/secrets.mjs";

// كاش قصير للبوتات (تتغير نادراً)
let cache = { data: null, at: 0 };
const CACHE_TTL_MS = 60 * 1000;

function invalidate() {
  cache = { data: null, at: 0 };
}

async function loadTenants() {
  if (cache.data && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;
  if (!process.env.DATABASE_URL) throw new Error("لا توجد DATABASE_URL — اضبط قاعدة البيانات أولاً");
  const rows = await systemDb("tenants:list").tenant.findMany({ orderBy: { id: "asc" } });
  cache = { data: rows, at: Date.now() };
  return rows;
}

function toPublic(t) {
  return {
    id: t.id,
    name: t.name,
    botName: t.botName,
    enabled: t.enabled !== false,
    businessType: t.businessType,
    phone_number_id: t.phoneNumberId || process.env.WHATSAPP_PHONE_ID || null,
    isDefault: t.id === "kareem-sport",
    productsCount: (t.products || []).length,
    plan: t.plan || "trial",
    trialEndsAt: t.trialEndsAt || null,
    trialExpired: isTrialExpired(t),
    hasOwnToken: !!t.whatsappToken,
  };
}

// انتهاء التجربة: plan=trial مع trialEndsAt ماضٍ (null = مفتوح/مدفوع)
// البوت نشط = مفعّل وغير منتهي التجربة
export function isTrialExpired(t) {
  if (!t || (t.plan || "trial") !== "trial" || !t.trialEndsAt) return false;
  return new Date(t.trialEndsAt) < new Date();
}
export function isTenantActive(t) {
  return !!t && t.enabled !== false && !isTrialExpired(t);
}

export async function listTenants() {
  return (await loadTenants()).map(toPublic);
}

export async function getTenant(id) {
  return systemDb("tenants:get").tenant.findUnique({ where: { id } });
}

export async function getDefaultTenant() {
  const tenants = await loadTenants();
  return tenants.find((t) => t.id === "kareem-sport") || tenants[0] || null;
}

// أهم دالة للعزل: نحل أي رسالة واتساب لأي tenant حسب phone_number_id
export async function resolveTenant({ phoneNumberId, verifyToken } = {}) {
  const tenants = await loadTenants();
  const envPhoneId = process.env.WHATSAPP_PHONE_ID;
  const envVerify = process.env.WEBHOOK_VERIFY_TOKEN || "my_secret_token";

  if (phoneNumberId) {
    // أولاً: مطابقة صريحة (بوت عنده رقمه الخاص)
    const exact = tenants.find((t) => t.phoneNumberId && t.phoneNumberId === phoneNumberId);
    if (exact) return withEnvDefaults(exact);
    // ثانياً: الافتراضي (كريم) عند تطابق رقم البيئة المشترك
    const def = tenants.find((t) => t.id === "kareem-sport" && (t.phoneNumberId || envPhoneId) === phoneNumberId)
      || tenants.find((t) => (t.phoneNumberId || envPhoneId) === phoneNumberId);
    if (def) return withEnvDefaults(def);
  }
  if (verifyToken) {
    const hit = tenants.find((t) => (t.verifyToken || envVerify) === verifyToken);
    if (hit) return withEnvDefaults(hit);
  }
  const def = tenants.find((t) => t.id === "kareem-sport") || tenants[0];
  return def ? withEnvDefaults(def) : null;
}

function withEnvDefaults(t) {
  let perTenantToken = null;
  try {
    // فك متزامن وخفيف (AES-GCM) — التوكن الخاص أولاً، ثم المشترك
    if (t?.whatsappToken) perTenantToken = decryptSecret(t.whatsappToken);
  } catch { /* رجوع للمشترك */ }
  return {
    ...t,
    phone_number_id: t.phoneNumberId || process.env.WHATSAPP_PHONE_ID || null,
    verify_token: t.verifyToken || process.env.WEBHOOK_VERIFY_TOKEN || "my_secret_token",
    whatsapp_token: perTenantToken || process.env.WHATSAPP_TOKEN || null,
    hasOwnToken: !!perTenantToken,
    trialExpired: isTrialExpired(t),
  };
}

export async function getTenantFull(id) {
  const t = await getTenant(id);
  return t ? withEnvDefaults(t) : null;
}

// مفتاح الذاكرة المعزول: tenant + phone (مستحيل يختلطوا)
export function memoryKey(tenantId, phone) {
  return `${tenantId}::${phone}`;
}

// حل مرن: id نصي أو كائن tenant جاهز (يستخدمه المرسل والذاكرة)
export async function resolveTenantInput(input) {
  if (!input) return resolveTenant({});
  if (typeof input === "string") return (await getTenantFull(input)) || resolveTenant({});
  return input;
}

const PLANS = ["trial", "basic", "clinic", "pro"];
function cleanPlan(p) {
  const v = String(p || "trial").toLowerCase();
  if (!PLANS.includes(v)) throw new Error(`plan غير صالح — المسموح: ${PLANS.join(", ")}`);
  return v;
}
function cleanTrialDate(v) {
  if (v === null || v === undefined || v === "") return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error("trialEndsAt تاريخ غير صالح");
  return d;
}

export async function updateTenant(id, data) {
  const allowed = ["name", "botName", "enabled", "phoneNumberId", "verifyToken", "businessType", "products", "deliveryFee", "bundleOffer", "tone", "languages", "features", "plan", "trialEndsAt"];
  const clean = {};
  for (const k of allowed) if (data[k] !== undefined) clean[k] = data[k];
  // whatsappToken يُقبل باسم whatsappToken أو whatsapp_token ويُشفر قبل التخزين
  const rawToken = data.whatsappToken ?? data.whatsapp_token;
  if (rawToken !== undefined) {
    if (!rawToken) clean.whatsappToken = null; // مسح التوكن → رجوع للمشترك
    else clean.whatsappToken = encryptSecret(String(rawToken));
  }
  if (clean.plan !== undefined) clean.plan = cleanPlan(clean.plan);
  if (clean.trialEndsAt !== undefined) clean.trialEndsAt = cleanTrialDate(clean.trialEndsAt);
  const updated = await systemDb("tenants:update").tenant.update({ where: { id }, data: clean });
  invalidate();
  return updated;
}

export async function addTenant(data) {
  if (!data || !data.id || !data.name || !data.botName) {
    throw new Error("id و name و botName مطلوبة");
  }
  if (!/^[a-z0-9-]+$/.test(data.id)) {
    throw new Error("id يجب أن يكون حروف إنجليزية صغيرة وأرقام و - فقط");
  }
  const rawToken = data.whatsappToken ?? data.whatsapp_token;
  const created = await systemDb("tenants:create").tenant.create({
    data: {
      id: data.id,
      name: data.name,
      botName: data.botName,
      enabled: data.enabled !== false,
      phoneNumberId: data.phone_number_id || data.phoneNumberId || null,
      verifyToken: data.verify_token || data.verifyToken || null,
      whatsappToken: rawToken ? encryptSecret(String(rawToken)) : null,
      plan: cleanPlan(data.plan),
      trialEndsAt: cleanTrialDate(data.trialEndsAt ?? defaultTrialEnd()),
      businessType: data.businessType || "general",
      products: Array.isArray(data.products) ? data.products : [],
      deliveryFee: data.deliveryFee ?? 5,
      bundleOffer: data.bundleOffer || {},
      tone: data.tone || "ودود ومهني",
      languages: Array.isArray(data.languages) ? data.languages : ["ar", "en"],
      features: data.features || {},
    },
  });
  invalidate();
  return created;
}

// تجربة افتراضية 14 يوماً للبوتات الجديدة (ما لم يُحدد plan مدفوع)
function defaultTrialEnd() {
  return new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
}

export async function deleteTenant(id) {
  const all = await loadTenants();
  if (all.length <= 1) throw new Error("ممنوع حذف البوت الأخير");
  const row = await systemDb("tenants:delete").tenant.delete({ where: { id } }).catch(() => null);
  if (!row) throw new Error("tenant غير موجود");
  invalidate();
  return { id: row.id };
}

// بناء System Prompt لكل tenant من إعداداته
export function buildSystemPrompt(tenant) {
  const products = (tenant.products || []).map((p, i) => `${i + 1}. ${p.name} — $${p.price}`).join("\n");
  const bundle = tenant.bundleOffer?.enabled
    ? `\n🎁 عرض Bundle: ${tenant.bundleOffer.description}`
    : "";

  return `
أنت "${tenant.botName}"، وكيل مبيعات ذكي لـ ${tenant.name} على واتساب — أسلوبك: ${tenant.tone}.

# المنتجات المتاحة فقط (ممنوع اقتراح أي شيء خارجها):
${products}
${tenant.deliveryFee ? `رسوم التوصيل ثابتة — $${tenant.deliveryFee} (تُضاف على أي طلب)` : ""}${bundle}

# قواعد البيع:
- ممنوع اقتراح منتجات أو أسعار غير مذكورة أعلاه.
- إذا اعترض العميل على السعر: وضّح القيمة أو اقترح منتجاً مكملاً.
- اذكر السعر الإجمالي مع التوصيل عند تأكيد الشراء.

# التصعيد للبشر (transfer_to_human):
- إذا طلب العميل التحدث مع موظف / إنسان / مدير / خدمة عملاء → transfer_to_human = true ورد يؤكد إبلاغ الفريق.

# اللغات: ${(tenant.languages || ["ar"]).join("، ")} - رد بنفس لغة العميل.

# هيكل الرد (JSON فقط بدون markdown):
{
  "reply": "نص الرد بنفس لغة العميل",
  "transfer_to_human": false,
  "intent": "استفسار | شراء | اعتراض_على_السعر | تصعيد | حجز_موعد",
  "buttons": [{"id": "x", "title": "زر"}],
  "image": "رابط صورة (اختياري)"
}
- buttons: اختياري حتى 3 أزرار من أزرار منتجاتك.
- حجز_موعد: فقط إذا كان الحجز مفعّلاً وطلب العميل موعداً.
`;
}
