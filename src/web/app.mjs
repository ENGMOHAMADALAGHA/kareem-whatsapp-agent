import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import { PORT, WEBHOOK_VERIFY_TOKEN, WHATSAPP_PHONE_ID, AI_PROVIDER, AI_MODEL, ADMIN_USER, ADMIN_PASS, META_APP_SECRET } from "../config/env.mjs";
import { listTenants } from "../../tenants.mjs";
import { isDemoMode } from "../ai/kareem.mjs";
import { adminAuth, scopeClient } from "./middleware.mjs";
import { registerAdminRoutes } from "./routes/admin.mjs";
import { registerPortalRoutes } from "./routes/portal.mjs";
import { registerWebhookRoutes } from "./routes/webhook.mjs";
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
  // أصول محلية (Tailwind مُضمّن — لا سكربتات خارجية حية داخل الكونسول)
  app.use("/assets", express.static(path.join(__dirname, "..", "..", "assets")));
  app.use("/admin", adminAuth);
  app.use("/admin", scopeClient);

  app.get("/", async (req, res) => {
    res.json({
      name: "Wasl Command Center — وصل (Multi-Tenant)",
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

  // ── بوابة العميل: واجهة GUI مستقلة (client.html) مقفلة على بوته ──
  app.get("/portal/", (req, res) => {
    res.sendFile(path.join(__dirname, "..", "..", "client.html"));
  });

  registerAdminRoutes(app);
  registerPortalRoutes(app);
  registerWebhookRoutes(app);

  // 404 موحد + ملقم أخطاء يمنع تسرب الستاك
  app.use((req, res) => {
    res.status(404).json({ ok: false, error: "غير موجود" });
  });
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(`  ❌ خطأ غير معالج [${req.method} ${req.path}]: ${err.message}`);
    if (res.headersSent) return next(err);
    res.status(500).json({ ok: false, error: "خطأ داخلي" });
  });

  return app;
}

export function startServer(port = PORT) {
  const app = createApp();
  startSchedulers();
  const server = app.listen(port, () => {
    console.log("\n" + "═".repeat(60));
    console.log("  🤖  Wasl Command Center — وصل | سيرفر واتساب Webhook");
    console.log("═".repeat(60));
    console.log(`  🌐 السيرفر يعمل: http://localhost:${port}`);
    console.log(`  🔗 Webhook URL: http://localhost:${port}/webhook`);
    console.log(`  🔑 Verify Token: ${WEBHOOK_VERIFY_TOKEN}`);
    console.log(`  📱 Phone ID: ${WHATSAPP_PHONE_ID || "(غير مضبوط - وضع محاكاة)"}`);
    console.log(`  🧠 المزود: ${AI_PROVIDER} | النموذج: ${AI_MODEL} | الوضع: ${isDemoMode ? "DEMO" : "API حقيقي"}`);
    // فحص الإعدادات الحرجة عند الإقلاع (لا فشل صامت — تحذير واضح)
    if (!ADMIN_USER || !ADMIN_PASS) {
      console.log("  ⚠️  ADMIN_USER/ADMIN_PASS غير مضبوطين — /admin سيرفض الدخول (503 fail-closed). أضفهما إلى .env");
    } else {
      console.log("  👤 دخول المدير: مفعّل (/admin يطلب Basic Auth)");
    }
    if (!META_APP_SECRET) {
      console.log("  ⚠️  META_APP_SECRET غير مضبوط — webhooks الواردة ستُرفض (403 fail-closed)");
    }
    if (!WEBHOOK_VERIFY_TOKEN || WEBHOOK_VERIFY_TOKEN === "my_secret_token") {
      console.log("  ⚠️  WEBHOOK_VERIFY_TOKEN افتراضي (my_secret_token) — غيّره في .env قبل أي نشر عمومي لمنع خطف الاشتراك");
    }
    console.log("═".repeat(60));
    console.log(`  💡 للاختبار المحلي: استخدم ngrok أو similar`);
    console.log(`     ngrok http ${port}`);
    console.log("═".repeat(60) + "\n");
  });
  return server;
}
