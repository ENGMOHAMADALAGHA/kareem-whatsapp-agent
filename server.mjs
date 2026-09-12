import { startServer } from "./agent.mjs";
import { db } from "./db.mjs";

// إغلاق نظيف: أغلق اتصالات القاعدة قبل الخروج حتى لا تُترك اتصالات عالقة
function gracefulShutdown(signal) {
  console.error(`  🛑 ${signal} — إغلاق نظيف...`);
  Promise.resolve(db()?.$disconnect?.())
    .catch((e) => console.error(`  ⚠️ فشل إغلاق القاعدة: ${e?.message}`))
    .finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref?.();
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// سيرفر مستقل - يستورد منطق كريم من agent.mjs
// للتشغيل: node server.mjs أو npm start

// شبكة أمان أخيرة: سجّل بدل الانهيار الصامت
process.on("unhandledRejection", (reason) => {
  console.error("  ☠️ unhandledRejection:", reason?.message || reason);
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

startServer();
