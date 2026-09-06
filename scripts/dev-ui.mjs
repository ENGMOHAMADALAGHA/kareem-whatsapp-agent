// ──────────────────────────────────────────────
// One-click launcher: boot server + auto-open Admin UI.
// Usage: `npm run dev:ui` or double-click start-dev.bat / ./start-dev.sh
// Zero extra dependencies (pure node).
// ──────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, exec } from "node:child_process";
import dotenv from "dotenv";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ENV_PATH = path.join(ROOT, ".env");

// 1) .env check (warn, don't block — server has safe defaults)
if (!fs.existsSync(ENV_PATH)) {
  console.warn("  ⚠️  .env غير موجود — سيعمل السيرفر بالإعدادات الافتراضية.");
  console.warn("     انسخ .env.example إلى .env وعبّئ المفاتيح للإنتاج.");
} else {
  dotenv.config({ path: ENV_PATH });
  // تنبيه مبكر: بدون بيانات المدير سيرفض /admin الدخول (fail-closed)
  const raw = fs.readFileSync(ENV_PATH, "utf8");
  const has = (k) => new RegExp(`^\\s*${k}\\s*=\\s*\\S+\\s*$`, "m").test(raw);
  if (!has("ADMIN_USER") || !has("ADMIN_PASS")) {
    console.warn("  ⚠️  ADMIN_USER/ADMIN_PASS غير مضبوطين في .env —");
    console.warn("     المتصفح سيطلب الدخول ثم يرفض (503). أضفهما إلى .env أولاً، مثال:");
    console.warn('     ADMIN_USER=admin\n     ADMIN_PASS=change_me_strong_password');
  }
}

const PORT = Number(process.env.PORT || 3000);
const HEALTH_URL = `http://localhost:${PORT}/`;
const ADMIN_URL = `http://localhost:${PORT}/admin/`;

function openBrowser(url) {
  const cmd =
    process.platform === "win32" ? `start "" "${url}"`
    : process.platform === "darwin" ? `open "${url}"`
    : `xdg-open "${url}" || sensible-browser "${url}" || echo "افتح المتصفح يدوياً: ${url}"`;
  exec(cmd, (err) => {
    if (err) console.log(`  💡 افتح المتصفح يدوياً: ${url}`);
    else console.log(`  🌐 فُتح المتصفح: ${url}`);
  });
}

async function waitForPort(url, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status < 500) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// 2) start server (entry: server.mjs)
console.log("  🚀 تشغيل السيرفر...");
const child = spawn(process.execPath, ["server.mjs"], {
  cwd: ROOT,
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code) => {
  console.log(`\n  🛑 توقف السيرفر (code=${code})`);
  process.exit(code ?? 0);
});

// 3) wait + open Admin UI
const up = await waitForPort(HEALTH_URL);
if (up) {
  console.log(`  ✅ السيرفر يستجيب على المنفذ ${PORT}`);
  openBrowser(ADMIN_URL);
} else {
  console.error(`  ❌ السيرفر لم يستجب خلال 30 ثانية على ${HEALTH_URL}`);
  console.error("     تحقق من السجلات أعلاه (منفذ مشغول؟ DATABASE_URL؟)");
}

const shutdown = () => {
  console.log("\n  🛑 إيقاف...");
  child.kill("SIGINT");
  setTimeout(() => child.kill("SIGKILL"), 5000).unref?.();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
