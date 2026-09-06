import { systemDb } from "./src/security/tenantGuard.mjs";

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
  };
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
  return {
    ...t,
    phone_number_id: t.phoneNumberId || process.env.WHATSAPP_PHONE_ID || null,
    verify_token: t.verifyToken || process.env.WEBHOOK_VERIFY_TOKEN || "my_secret_token",
    whatsapp_token: process.env.WHATSAPP_TOKEN || null,
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

export async function updateTenant(id, data) {
  const allowed = ["name", "botName", "enabled", "phoneNumberId", "verifyToken", "businessType", "products", "deliveryFee", "bundleOffer", "tone", "languages", "features"];
  const clean = {};
  for (const k of allowed) if (data[k] !== undefined) clean[k] = data[k];
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
  const created = await systemDb("tenants:create").tenant.create({
    data: {
      id: data.id,
      name: data.name,
      botName: data.botName,
      enabled: data.enabled !== false,
      phoneNumberId: data.phone_number_id || null,
      verifyToken: data.verify_token || null,
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
