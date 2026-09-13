// واجهة توافق: المنطق انتقل إلى ./webhook/ (تحقق + استقبال + موزع + 5 معالجات)
// تُبقي كل الاستيرادات القديمة `from "./routes/webhook.mjs"` شغالة بلا تغيير.
export { registerWebhookRoutes, processWebhookBody, replayInflightWebhooks } from "./webhook/index.mjs";
