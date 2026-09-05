import pg from "pg";

const { Pool } = pg;

let pool = null;
let ready = null;

export function isDbEnabled() {
  return !!process.env.DATABASE_URL;
}

function getPool() {
  if (!isDbEnabled()) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 5,
    });
    pool.on("error", (e) => console.error(`  ❌ خطأ اتصال DB: ${e.message}`));
  }
  return pool;
}

// إنشاء الجداول (تُستدعى عند الإقلاع)
export async function initDb() {
  const p = getPool();
  if (!p) {
    console.log("  💾 وضع JSON المحلي (لا يوجد DATABASE_URL)");
    return false;
  }
  await p.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      phone TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_messages_lookup ON messages (tenant_id, phone, created_at DESC);

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      phone TEXT NOT NULL,
      name TEXT,
      items JSONB,
      total NUMERIC,
      currency TEXT DEFAULT 'USD',
      status TEXT DEFAULT 'pending',
      payment_url TEXT,
      cart_reminded_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      paid_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS appointments (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      phone TEXT NOT NULL,
      name TEXT,
      service TEXT,
      day TEXT,
      slot TEXT,
      status TEXT DEFAULT 'confirmed',
      reminded_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ratings (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      phone TEXT NOT NULL,
      score INT NOT NULL,
      ref_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS broadcasts (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      text TEXT,
      phones JSONB,
      results JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      tenant_id TEXT,
      phone TEXT,
      data JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_events_lookup ON events (tenant_id, type, created_at DESC);
  `);
  console.log("  ✅ قاعدة PostgreSQL جاهزة");
  return true;
}

export function db() {
  if (!ready) ready = initDb().catch((e) => {
    console.error(`  ❌ فشل تهيئة DB (نعود لـ JSON): ${e.message}`);
    return false;
  });
  return getPool();
}

// تنظيف الرسائل الأقدم من 30 يوم (تُستدعى من المجدول)
export async function pruneOldMessages(days = 30) {
  const p = getPool();
  if (!p) return 0;
  const r = await p.query(`DELETE FROM messages WHERE created_at < NOW() - INTERVAL '1 day' * $1`, [days]);
  return r.rowCount || 0;
}
