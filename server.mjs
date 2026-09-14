import { startServer } from "./agent.mjs";
import { db } from "./db.mjs";

let httpServer = null;

// إغلاق نظيف: صرّف اتصالات HTTP الطائرة أولاً ثم القاعدة — بلا قطع لطلبات حية
function gracefulShutdown(signal) {
  console.error(`  🛑 ${signal} — إغلاق نظيف...`);
  const killer = setTimeout(() => process.exit(0), 8000).unref?.();
  const closeHttp = httpServer
    ? new Promise((res) => httpServer.close(() => res()))
    : Promise.resolve();
  closeHttp
    .catch((e) => console.error(`  ⚠️ فشل تصريف HTTP: ${e?.message}`))
    .then(() => Promise.resolve(db()?.$disconnect?.()).catch((e) => console.error(`  ⚠️ فشل إغلاق القاعدة: ${e?.message}`)))
    .finally(() => {
      clearTimeout(killer);
      process.exit(0);
    });
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// سيرفر مستقل - يستورد منطق وصل من agent.mjs
// للتشغيل: node server.mjs أو npm start

// رفض غير معالَج = حالة مجهولة: سجّل واخرج ليعيد المشرف التشغيل بحالة نظيفة
// (فشل-سريع بدل بوت متدهور صامت — consistent مع uncaughtException)
process.on("unhandledRejection", (reason) => {
  console.error("  ☠️ unhandledRejection (will exit 1):", reason?.message || reason);
  setImmediate(() => process.exit(1));
});
// الأخطاء غير المعالجة قاتلة: سجّل واخرج بكود فشل صريح
// حتى يعيد Render/PM2 التشغيل (فشل-سريع) بدل بوت أصم يخدم صامتاً
process.on("uncaughtException", (err) => {
  console.error("  ☠️ uncaughtException (will exit 1):", err?.message || err);
  if (err?.stack) console.error(err.stack);
  setImmediate(() => process.exit(1));
});

// الإنتاج بلا قاعدة = بوت أصم — ارفض الإقلاع بدل "صحة وهمية"
if (process.env.NODE_ENV === "production" && !process.env.DATABASE_URL) {
  console.error("  ☠️ الإنتاج يتطلب DATABASE_URL — أرفض الإقلاع (فشل-سريع) بدل بوت أصم.");
  process.exit(1);
}

setHttpServer(startServer());

export { httpServer };
export function setHttpServer(s) {
  httpServer = s;
}
