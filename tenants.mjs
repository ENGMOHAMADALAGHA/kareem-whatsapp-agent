import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TENANTS_FILE = path.join(__dirname, "tenants.json");

function loadFile() {
  try {
    const raw = fs.readFileSync(TENANTS_FILE, "utf-8");
    const data = JSON.parse(raw);
    return Array.isArray(data.tenants) ? data.tenants : [];
  } catch {
    return [];
  }
}

function saveFile(tenants) {
  fs.writeFileSync(TENANTS_FILE, JSON.stringify({ tenants }, null, 2) + "\n", "utf-8");
}

export function listTenants() {
  const tenants = loadFile();
  // لا نرجع التوكنات في اللست
  return tenants.map((t) => ({
    id: t.id,
    name: t.name,
    botName: t.botName,
    enabled: t.enabled !== false,
    businessType: t.businessType,
    phone_number_id: t.phone_number_id || process.env.WHATSAPP_PHONE_ID || null,
    isDefault: !!t.isDefault,
    productsCount: (t.products || []).length,
  }));
}

export function getTenant(id) {
  const tenants = loadFile();
  return tenants.find((t) => t.id === id) || null;
}

export function getDefaultTenant() {
  const tenants = loadFile();
  return tenants.find((t) => t.isDefault) || tenants[0] || null;
}

// أهم دالة للعزل: نحل أي رسالة واتساب لأي tenant حسب phone_number_id
// value.metadata.phone_number_id هو رقم البوت المستقبل (مش رقم الزبون)
export function resolveTenant({ phoneNumberId, verifyToken } = {}) {
  const tenants = loadFile();
  const envPhoneId = process.env.WHATSAPP_PHONE_ID;
  const envVerify = process.env.WEBHOOK_VERIFY_TOKEN || "my_secret_token";

  // 1. مطابقة مباشرة على phone_number_id
  if (phoneNumberId) {
    const hit = tenants.find((t) => (t.phone_number_id || envPhoneId) === phoneNumberId);
    if (hit) return withEnvDefaults(hit);
  }

  // 2. مطابقة على verify_token (لـ GET /webhook)
  if (verifyToken) {
    const hit = tenants.find((t) => (t.verify_token || envVerify) === verifyToken);
    if (hit) return withEnvDefaults(hit);
  }

  // 3. الافتراضي (كريم الحالي) - لا نكسر شيء
  const def = tenants.find((t) => t.isDefault) || tenants[0];
  return def ? withEnvDefaults(def) : null;
}

function withEnvDefaults(t) {
  return {
    ...t,
    phone_number_id: t.phone_number_id || process.env.WHATSAPP_PHONE_ID || null,
    verify_token: t.verify_token || process.env.WEBHOOK_VERIFY_TOKEN || "my_secret_token",
    whatsapp_token: process.env[t.whatsapp_token_env || "WHATSAPP_TOKEN"] || process.env.WHATSAPP_TOKEN || null,
  };
}

export function getTenantFull(id) {
  const t = getTenant(id);
  return t ? withEnvDefaults(t) : null;
}

// مفتاح الذاكرة المعزول: tenant + phone (مستحيل يختلطوا)
export function memoryKey(tenantId, phone) {
  return `${tenantId}::${phone}`;
}

export function addTenant(data) {
  if (!data || !data.id || !data.name || !data.botName) {
    throw new Error("id و name و botName مطلوبة");
  }
  if (!/^[a-z0-9-]+$/.test(data.id)) {
    throw new Error("id يجب أن يكون حروف إنجليزية صغيرة وأرقام و - فقط");
  }
  const tenants = loadFile();
  if (tenants.some((t) => t.id === data.id)) {
    throw new Error("tenant بهذا الـ id موجود مسبقاً");
  }
  const tenant = {
    id: data.id,
    name: data.name,
    botName: data.botName,
    enabled: data.enabled !== false,
    phone_number_id: data.phone_number_id || null,
    verify_token: data.verify_token || null,
    whatsapp_token_env: data.whatsapp_token_env || "WHATSAPP_TOKEN",
    isDefault: false,
    businessType: data.businessType || "general",
    products: Array.isArray(data.products) ? data.products : [],
    deliveryFee: data.deliveryFee ?? 5,
    bundleOffer: data.bundleOffer || { enabled: false },
    tone: data.tone || "ودود ومهني",
    languages: Array.isArray(data.languages) ? data.languages : ["ar", "en"],
    systemPromptOverride: data.systemPromptOverride || null,
  };
  tenants.push(tenant);
  saveFile(tenants);
  return tenant;
}

// بناء System Prompt لكل tenant من إعداداته (بدون ما ننسخ كود كريم)
export function buildSystemPrompt(tenant) {
  if (tenant?.systemPromptOverride) return tenant.systemPromptOverride;

  const products = (tenant.products || []).map((p, i) => `${i + 1}. ${p.name} — $${p.price}`).join("\n");
  const bundle = tenant.bundleOffer?.enabled
    ? `\n4. 🎁 عرض Bundle: ${tenant.bundleOffer.description}`
    : "";

  return `
أنت "${tenant.botName}"، وكيل مبيعات ذكي لـ ${tenant.name} على واتساب — أسلوبك: ${tenant.tone}.

# المنتجات المتاحة فقط (ممنوع اقتراح أي شيء خارجها):
${products}
${(tenant.deliveryFee ?? 5) ? `رسوم التوصيل ثابتة — $${tenant.deliveryFee} (تُضاف على أي طلب)` : ""}${bundle}

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
  "intent": "استفسار | شراء | اعتراض_على_السعر | تصعيد"
}
`;
}
