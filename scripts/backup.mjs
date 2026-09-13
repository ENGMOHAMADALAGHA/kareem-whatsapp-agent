// نسخ احتياطي يومي لـ PostgreSQL عبر pg_dump — يعمل Windows + Linux
// الاستخدام اليدوي: npm run backup
// الجدولة على RDP (Task Scheduler يومياً 03:00):
//   node C:\bots\kareem\scripts\backup.mjs
// يحتفظ بآخر 7 نسخ فقط تلقائياً (BACKUP_KEEP=7).
// يتطلب pg_dump في PATH + DATABASE_URL في .env
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, unlinkSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = process.env.BACKUP_DIR || join(root, "backups");
const keep = Number(process.env.BACKUP_KEEP || 7);
const url = process.env.DATABASE_URL;

if (!url) {
  console.error("DATABASE_URL غير موجود — أضفه إلى .env أولاً.");
  process.exit(1);
}

mkdirSync(dir, { recursive: true });

const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
const file = join(dir, `wasl_${stamp}.dump`);

console.log(`بدء النسخ → ${file}`);
const r = spawnSync("pg_dump", [url, "--format=custom", "-f", file], {
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (r.status !== 0) {
  console.error("فشل pg_dump — تأكد أنه مثبت في PATH (PostgreSQL bin).");
  process.exit(1);
}

// تنظيف: احتفظ بآخر N نسخ فقط
try {
  const dumps = readdirSync(dir)
    .filter((f) => f.startsWith("wasl_") && f.endsWith(".dump"))
    .sort();
  while (dumps.length > keep) {
    const old = dumps.shift();
    const p = join(dir, old);
    if (existsSync(p)) unlinkSync(p);
    console.log(`حُذفت نسخة قديمة: ${old}`);
  }
} catch (e) {
  console.warn(`تحذير التنظيف: ${e?.message}`);
}

console.log("تم النسخ الاحتياطي ✅");
