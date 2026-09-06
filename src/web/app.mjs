import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import { PORT, WEBHOOK_VERIFY_TOKEN, WHATSAPP_PHONE_ID, AI_PROVIDER, AI_MODEL } from "../config/env.mjs";
import { listTenants } from "../../tenants.mjs";
import { isDemoMode } from "../ai/kareem.mjs";
import { adminAuth, scopeClient } from "./middleware.mjs";
import { registerAdminRoutes } from "./routes/admin.mjs";
import { registerPortalRoutes } from "./routes/portal.mjs";
import { registerWebhookRoutes } from "./routes/webhook.mjs";
import { registerBillingRoutes } from "./routes/billing.mjs";
import { startSchedulers } from "../jobs/schedulers.mjs";

export function createApp() {
  const app = express();

  // ضروري لقراءة JSON من واتساب + حفظ الخام للتحقق من التوقيع
  app.use(express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  }));
  app.use(express.urlencoded({ extended: true }));
  app.use("/admin", adminAuth);
  app.use("/admin", scopeClient);

  app.get("/", async (req, res) => {
    res.json({
      name: "كريم - AI Sales Agent (Multi-Tenant)",
      status: "running",
      webhook: "/webhook",
      admin: "/admin/tenants",
      tenants: (await listTenants()).length,
      mode: isDemoMode ? "DEMO" : AI_PROVIDER,
    });
  });

  app.get("/admin/", (req, res) => {
    res.sendFile(path.join(__dirname, "..", "..", "admin.html"));
  });

  // ── بوابة العميل (صفحة دخول + لوحة مقفلة على بوته) ──
  app.get("/portal/", (req, res) => {
    res.sendFile(path.join(__dirname, "..", "..", "admin.html"));
  });

  registerAdminRoutes(app);
  registerPortalRoutes(app);
  registerWebhookRoutes(app);
  registerBillingRoutes(app);

  return app;
}

export function startServer(port = PORT) {
  const app = createApp();
  startSchedulers();
  const server = app.listen(port, () => {
    console.log("\n" + "═".repeat(60));
    console.log("  🤖  كريم - AI Sales Agent | سيرفر واتساب Webhook");
    console.log("═".repeat(60));
    console.log(`  🌐 السيرفر يعمل: http://localhost:${port}`);
    console.log(`  🔗 Webhook URL: http://localhost:${port}/webhook`);
    console.log(`  🔑 Verify Token: ${WEBHOOK_VERIFY_TOKEN}`);
    console.log(`  📱 Phone ID: ${WHATSAPP_PHONE_ID || "(غير مضبوط - وضع محاكاة)"}`);
    console.log(`  🧠 المزود: ${AI_PROVIDER} | النموذج: ${AI_MODEL} | الوضع: ${isDemoMode ? "DEMO" : "API حقيقي"}`);
    console.log("═".repeat(60));
    console.log(`  💡 للاختبار المحلي: استخدم ngrok أو similar`);
    console.log(`     ngrok http ${port}`);
    console.log("═".repeat(60) + "\n");
  });
  return server;
}
