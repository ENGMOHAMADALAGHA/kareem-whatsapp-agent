import { ADMIN_USER, ADMIN_PASS } from "../config/env.mjs";
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
