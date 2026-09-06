import crypto from "node:crypto";
import { ADMIN_USER, ADMIN_PASS, META_APP_SECRET } from "../config/env.mjs";
import { getTenantFull } from "../../tenants.mjs";

// ── حماية /admin: سوبر أدمن (Basic) أو عميل (JWT) ──
// مسارات ممنوعة على العملاء (إدارة البوتات والمستخدمين فقط للسوبر)
// ملاحظة: req.path هنا بدون بادئة /admin لأن الـ middleware مركّب عليها
const SUPER_ONLY = ["/tenants", "/users"];
export const adminAuth = async (req, res, next) => {
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  // 1) عميل بـ JWT؟
  if (scheme === "Bearer" && encoded) {
    const { verifyClientToken } = await import("../../portal.mjs");
    const p = verifyClientToken(encoded);
    if (p) {
      // kill switch: الموقوف لا يدخل
      const t = await getTenantFull(p.tenantId);
      if (!t || t.enabled === false) {
        return res.status(403).json({ ok: false, error: "هذا البوت موقوف — تواصل مع الإدارة" });
      }
      if (SUPER_ONLY.some((s) => req.path === s || req.path.startsWith(s + "/"))) {
        return res.status(403).json({ ok: false, error: "غير مصرح" });
      }
      req.clientTenant = p.tenantId; // إجبار النطاق على بوته فقط
      return next();
    }
  }
  // 2) سوبر أدمن؟
  if (ADMIN_USER && ADMIN_PASS && scheme === "Basic" && encoded) {
    const [u, pass] = Buffer.from(encoded, "base64").toString().split(":");
    if (u === ADMIN_USER && pass === ADMIN_PASS) return next();
  }
  if (!ADMIN_USER || !ADMIN_PASS) return next(); // بدون إعداد = مفتوح (للتطوير المحلي فقط)
  res.setHeader("WWW-Authenticate", 'Basic realm="admin"');
  return res.status(401).json({ ok: false, error: "مطلوب تسجيل دخول المدير" });
};
// ── تحقق توقيع Meta (X-Hub-Signature-256) لمنع حقن Webhooks مزيفة ──
// يتطلب META_APP_SECRET + rawBody (يُحفظ عبر express.json verify في app.mjs)
export function verifyMetaSignature(req, res, next) {
  if (!META_APP_SECRET) {
    console.warn("  ⚠️ META_APP_SECRET غير مضبوط — التحقق من التوقيع معطّل (للتطوير فقط)");
    return next();
  }
  const sig = req.headers["x-hub-signature-256"] || "";
  if (!sig.startsWith("sha256=") || !req.rawBody) {
    console.warn("  ❌ webhook بدون توقيع صالح — مرفوض");
    return res.sendStatus(403);
  }
  const expected = "sha256=" + crypto.createHmac("sha256", META_APP_SECRET).update(req.rawBody).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    console.warn("  ❌ توقيع webhook غير صالح — مرفوض");
    return res.sendStatus(403);
  }
  next();
}

// إجبار نطاق العميل على بوته في كل الطلبات
export function scopeClient(req, res, next) {
  if (req.clientTenant) {
    req.query.tenant = req.clientTenant;
    if (req.body && typeof req.body === "object") {
      req.body.tenantId = req.clientTenant;
      req.body.tenant = req.clientTenant;
    }
    if (req.params.tenantId) req.params.tenantId = req.clientTenant;
  }
  next();
}
