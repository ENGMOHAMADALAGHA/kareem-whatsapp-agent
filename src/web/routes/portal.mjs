import { getTenantFull } from "../../../tenants.mjs";
import { verifyClientUser, signClientToken, startPasswordReset, finishPasswordReset } from "../../../portal.mjs";
import { sendWhatsAppMessage } from "../../whatsapp/sender.mjs";

export function registerPortalRoutes(app) {
  app.post("/portal/login", async (req, res) => {
    try {
      const { verifyClientUser, signClientToken } = await import("../../../portal.mjs");
      const { tenantId, phone, password } = req.body || {};
      const u = await verifyClientUser(tenantId, phone, password);
      if (!u) return res.status(401).json({ ok: false, error: "بيانات الدخول غير صحيحة" });
      if (u.disabled) return res.status(403).json({ ok: false, error: "هذا البوت موقوف — تواصل مع الإدارة" });
      res.json({ ok: true, token: signClientToken(u), botName: u.tenant?.botName, tenantId: u.tenantId });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
  app.post("/portal/forgot", async (req, res) => {
    try {
      const { startPasswordReset } = await import("../../../portal.mjs");
      const { tenantId, phone } = req.body || {};
      const tenant = await getTenantFull(tenantId);
      if (!tenant) return res.json({ ok: true }); // لا نكشف
      await startPasswordReset(tenantId, phone, (codeMsg) => sendWhatsAppMessage(phone, codeMsg, tenant));
      res.json({ ok: true });
    } catch (e) {
      res.json({ ok: true }); // دائماً نجاح ظاهري (حماية)
    }
  });
  app.post("/portal/reset", async (req, res) => {
    try {
      const { finishPasswordReset } = await import("../../../portal.mjs");
      const { tenantId, phone, code, newPassword } = req.body || {};
      await finishPasswordReset(tenantId, phone, code, newPassword);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });
}
