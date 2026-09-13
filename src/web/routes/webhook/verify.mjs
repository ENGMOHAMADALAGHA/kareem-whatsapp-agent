// التحقق من اشتراك Webhook (GET /webhook) — مطابقة verify_token لكل بوت
import { resolveTenant } from "../../../../tenants.mjs";
import { WEBHOOK_VERIFY_TOKEN } from "../../../config/env.mjs";

export function registerVerifyRoute(app) {
  app.get("/webhook", async (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    console.log(`  🔍 GET /webhook - mode=${JSON.stringify(mode)} challenge=${JSON.stringify(challenge)}`); // لا نطبع التوكن أبداً

    // أولاً: جرّب مطابقة tenant حسب verify_token
    const tenant = token ? await resolveTenant({ verifyToken: token }) : null;
    const expected = tenant?.verify_token || WEBHOOK_VERIFY_TOKEN;

    if (mode === "subscribe" && token === expected) {
      console.log(`  ✅ تم التحقق من الـ Webhook بنجاح (tenant=${tenant?.id || "default"})`);
      return res.status(200).send(challenge);
    }

    console.warn(`  ❌ فشل التحقق: token المتوقع="${String(expected).slice(0, 2)}…" المستلم="${token ? String(token).slice(0, 2) + "…" : "(فارغ)"}"`);
    return res.sendStatus(403);
  });
}
