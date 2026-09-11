import { startServer } from "./agent.mjs";

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

startServer();
