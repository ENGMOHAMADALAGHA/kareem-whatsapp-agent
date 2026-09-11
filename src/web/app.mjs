import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// قناع سر قبل الطباعة — لا يُطبع أي توكن كاملاً في السجلات
function maskSecret(s) {
  if (!s) return "(غير مضبوط)";
  const str = String(s);
  return str.length <= 6 ? "••••" : `${str.slice(0, 2)}…${str.slice(-2)}`;
}

import { PORT, WEBHOOK_VERIFY_TOKEN, WHATSAPP_PHONE_ID, AI_PROVIDER, AI_MODEL, ADMIN_USER, ADMIN_PASS, META_APP_SECRET } from "../config/env.mjs";
import { listTenants } from "../../tenants.mjs";
import { isDemoMode } from "../ai/kareem.mjs";
import { adminAuth, scopeClient, csrfGuard } from "./middleware.mjs";
import { replayInflightWebhooks } from "./routes/webhook.mjs";
import { registerAdminRoutes } from "./routes/admin.mjs";
import { registerPortalRoutes } from "./routes/portal.mjs";
import { registerWebhookRoutes } from "./routes/webhook.mjs";
import { startSchedulers } from "../jobs/schedulers.mjs";

export function createApp() {
  const app = express();

  // ترويسات أمنية عامة بدل الاعتماد على خوادم خارجية
  // (CSP متعمد: بلا ترويض لأن الكونسول يعتمد Tailwind/Script مضمّن — التعقيد وقابلية الكسر أكبر من منفعته)
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    // لوحات الإدارة لا تُؤطَّر أبداً؛ معاينات البوابة (iframe same-origin) تبقى مسموحة بـ SAMEORIGIN
    res.setHeader("X-Frame-Options", req.path.startsWith("/admin") ? "DENY" : "SAMEORIGIN");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (process.env.NODE_ENV === "production") {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  });

  // ضروري لقراءة JSON من واتساب + حفظ الخام للتحقق من التوقيع
  // حد 1MB: الحمولات نصية صغيرة، والصوت/الصور تُسحب كروابط لا base64
  app.use(express.json({
    limit: "1mb",
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  }));
  app.use(express.urlencoded({ extended: true }));
  // حماية تغيير الحالة من أصول أجنبية (يُطبق قبل كل المسارات)
  app.use(csrfGuard);
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

  // فحص البقاء/الجاهزية لمزوّد الاستضافة (خفيف: بلا DB حتى لا يفشل الفحص معها)
  // يُثري أخطاء الإقلاع بدل بوت أصم صامت — 200 فقط إذا كان السيرفر حياً فعلاً
  app.get("/healthz", (req, res) => {
    res.status(200).json({
      ok: true,
      service: "wasl-agent",
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      now: new Date().toISOString(),
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
    // payload أكبر من حد 1MB → 413 واضح بدل 500 عمياء
    const status = err.type === "entity.too.large" ? 413 : (err.status || err.statusCode || 500);
    const body = status === 413 ? "الطلب أكبر من المسموح" : status === 404 ? "غير موجود" : "خطأ داخلي";
    res.status(status).json({ ok: false, error: body });
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
    console.log(`  🔑 Verify Token: ${maskSecret(WEBHOOK_VERIFY_TOKEN)}`);
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
    // P0-3 — بعد جاهزية الاستماع: استعادة أي حمولات علّقت أثناء الطيران
    // (انقطاع/إعادة نشر أثناء المعالجة) — بلا فقد ولا تكرار عبر dedup الـ wamid
    setTimeout(() => {
      replayInflightWebhooks().catch((e) => console.error(`  ⚠️ فشل replay: ${e.message}`));
    }, 2500);
  });
  return server;
}
