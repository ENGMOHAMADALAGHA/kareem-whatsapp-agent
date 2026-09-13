// فهرس راوترات Webhook — كل مرحلة في ملف مستقل بمسؤولية واحدة
// كان ملفاً واحداً (957 سطر) — الآن: تحقق + استقبال + موزع + 5 معالجات.
import { registerVerifyRoute } from "./verify.mjs";
import { registerReceiveRoute, replayInflightWebhooks } from "./receive.mjs";

export function registerWebhookRoutes(app) {
  registerVerifyRoute(app); // GET /webhook — تحقق الاشتراك لكل بوت
  registerReceiveRoute(app); // POST /webhook — حفظ دائم + 200 فوري + طابور FIFO
}

export { processWebhookBody } from "./process.mjs";
export { replayInflightWebhooks };
