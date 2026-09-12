// تهيئة قاعدة فراغ (fresh) من prisma/schema.sql — آمنة: لا يلمس قاعدة قائمة أبداً
import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const schemaSql = readFileSync(join(root, "prisma", "schema.sql"), "utf8");
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL غير موجود — أضفه وحاول مجدداً.");
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
try {
  await client.connect();
  const exists = await client
    .query("SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='tenants'")
    .then((r) => r.rowCount > 0);

  if (exists) {
    console.log("قاعدة موجودة فيها tenants — نتخطى (التهيئة للقواعد الفارغة فقط).");
    await client.end();
    process.exit(0);
  }

  await client.query(schemaSql);
  const n = (await client.query("SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema='public'")).rows[0].n;
  console.log(`تم إنشاء المخطط من الأساس: ${n} جدول ✅`);
  await client.end();
  process.exit(0);
} catch (e) {
  console.error("فشل تهيئة القاعدة:", e?.message || e);
  try { await client.end(); } catch {}
  process.exit(1);
}