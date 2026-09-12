// نقل البيانات من قاعدة (Supabase حالي) إلى قاعدة جديدة (Neon) بلا فقدان.
// ──────────────────────────────────────────────
// التشغيل بعد ضبط .env:
//   DATABASE_URL=ربط Neon          (الجديد — أنت حاطه أصلًا)
//   SUPABASE_DATABASE_URL=ربط_الأصل  (القديم — خطوة إلزامية، انسخ القديم هنا)
//
//   node scripts/migrate-neon.mjs            # أول مرة
//   node scripts/migrate-neon.mjs --force    # إعادة على قاعدة فيها بيانات (بلا مسح)
//
// النقل آمن وإضافي فقط (ON CONFLICT DO NOTHING) — ما يمسح شيئًا من المصدر ولا الهدف،
// والجداول تُملأ بأمرها الخارجي، ويُعاد ضبط تسلسل المفاتيح (sequences) بدقة.
// ──────────────────────────────────────────────
import "dotenv/config";
import pg from "pg";

const NEW_URL = process.env.DATABASE_URL;
const OLD_URL = process.env.SUPABASE_DATABASE_URL || process.env.OLD_DATABASE_URL;
const FORCE = process.argv.includes("--force");

const LOL = "─".repeat(60);

if (!NEW_URL || !OLD_URL) {
  console.error(`${LOL}\n  ❌ ينقص متغير بيئي:\n  - DATABASE_URL (الجديد/Neon) موجود؟ ${!!NEW_URL}\n  - SUPABASE_DATABASE_URL (القديم) موجود؟ ${!!OLD_URL}\n\n  أضف القديم كسطر SUPABASE_DATABASE_URL=... في .env ثم أعد.\n${LOL}`);
  process.exit(1);
}
if (NEW_URL === OLD_URL) {
  console.error("  ❌ DATABASE_URL و SUPABASE_DATABASE_URL متطابقان — لا نقل علينا.");
  process.exit(1);
}

const src = new pg.Client({ connectionString: OLD_URL });
const dst = new pg.Client({ connectionString: NEW_URL });

try {
  await src.connect();
  await dst.connect();
  console.log("  🔍 المصدر (Supabase): متصل");
  console.log("  🎯 الهدف (Neon): متصل");

  const counts = async (c) => (await c.query("SELECT COUNT(*)::int AS n FROM tenants")).rows[0].n;
  const oldN = await counts(src);
  const newN = await counts(dst);
  console.log(`  📦 tenants بالمصدر: ${oldN} | بالهدف: ${newN}`);
  if (newN > 0 && !FORCE) {
    console.error(`  ⛔ الهدف فيه بيانات (${newN} tenants) — شغّل مع --force للاستمرار (بلا مسح).`);
    process.exit(1);
  }

  const tables = (await src.query(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> 'prisma_migrations' ORDER BY tablename"
  )).rows.map((r) => r.tablename);

  const TOTAL_START = Date.now();
  const summary = [];
  for (const table of tables) {
    const cols = (await src.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position",
      [table]
    )).rows.map((r) => r.column_name);
    if (!cols.length) continue;

    const colList = cols.map((c) => `"${c}"`).join(", ");
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
    const insert = `INSERT INTO "${table}" (${colList}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;

    let copied = 0;
    const res = await src.query(`SELECT ${colList} FROM "${table}"`);
    for (let i = 0; i < res.rows.length; i += 500) {
      const batch = res.rows.slice(i, i + 500);
      for (const row of batch) {
        await dst.query(insert, cols.map((c) => row[c]));
      }
      copied += batch.length;
    }
    summary.push([table, copied]);
    console.log(`  ✅ ${table}: ${copied} صف`);
  }

  // إعادة ضبط المتسلسلات (auto-increment) على نسبها الصحيح بعد النسخ
  const identities = (await dst.query(
    "SELECT c.relname AS table_name, a.attname AS column_name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid WHERE n.nspname='public' AND a.attidentity IN ('a','d')"
  )).rows;
  for (const { table_name, column_name } of identities) {
    await dst.query(
      `SELECT setval(pg_get_serial_sequence('"${table_name}"','${column_name}'), COALESCE((SELECT MAX("${column_name}") FROM "${table_name}"), 1))`
    );
    console.log(`  🔢 تسلسل ${table_name}.${column_name} ضُبط على القيمة التالية`);
  }

  const total = summary.reduce((a, [, n]) => a + n, 0);
  console.log(LOL);
  console.log(`  ✅ اكتمل النقل: ${total} صف عبر ${summary.length} جداول في ${((Date.now() - TOTAL_START) / 1000).toFixed(1)}ث`);
  console.log(LOL);
  await src.end();
  await dst.end();
  process.exit(0);
} catch (e) {
  console.error(`  ❌ فشل النقل: ${e?.message || e}`);
  try { await src.end(); } catch {}
  try { await dst.end(); } catch {}
  process.exit(1);
}