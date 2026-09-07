import { startServer } from "./agent.mjs";

// سيرفر مستقل - يستورد منطق كريم من agent.mjs
// للتشغيل: node server.mjs أو npm start

// شبكة أمان أخيرة: سجّل بدل الانهيار الصامت
process.on("unhandledRejection", (reason) => {
  console.error("  ☠️ unhandledRejection:", reason?.message || reason);
});
process.on("uncaughtException", (err) => {
  console.error("  ☠️ uncaughtException:", err?.message || err);
});

startServer();
