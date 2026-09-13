import { systemDb } from "./src/security/tenantGuard.mjs";
const db = () => systemDb("store:kv");

// مخزن حالات مؤقتة دائم (Takeover/حجز/CSAT) — بديل Maps الطائرة
// كاش ذاكرة للسرعة + Postgres للبقاء بعد restart
const cache = new Map();
const CACHE_MAX = Number(process.env.STORE_CACHE_MAX || 2000);

function pruneCache() {
  if (cache.size <= CACHE_MAX) return;
  const now = Date.now();
  for (const [k, v] of cache) {
    if (v.expiresAt && v.expiresAt < now) cache.delete(k);
  }
  for (const k of cache.keys()) {
    if (cache.size <= CACHE_MAX) break;
    cache.delete(k);
  }
}

function expired(entry) {
  return entry.expiresAt && entry.expiresAt < Date.now();
}

export async function storeGet(key) {
  const hit = cache.get(key);
  if (hit) {
    if (expired(hit)) cache.delete(key);
    else return hit.value;
  }
  try {
    const row = await db().kvStore.findUnique({ where: { key } });
    if (!row) return null;
    if (row.expiresAt && new Date(row.expiresAt) < new Date()) {
      await db().kvStore.delete({ where: { key } }).catch(() => {});
      return null;
    }
    cache.set(key, { value: row.value, expiresAt: row.expiresAt ? new Date(row.expiresAt).getTime() : null });
    return row.value;
  } catch (e) {
    console.error(`  ⚠️ فشل قراءة store: ${e.message}`);
    return null;
  }
}

export async function storeSet(key, value, ttlMs = null) {
  const expiresAt = ttlMs ? new Date(Date.now() + ttlMs) : null;
  cache.set(key, { value, expiresAt: expiresAt ? expiresAt.getTime() : null });
  pruneCache();
  try {
    await db().kvStore.upsert({
      where: { key },
      update: { value, expiresAt },
      create: { key, value, expiresAt },
    });
  } catch (e) {
    console.error(`  ⚠️ فشل حفظ store: ${e.message}`);
  }
}

export async function storeKeys(prefix) {
  try {
    const rows = await db().kvStore.findMany({
      where: { key: { startsWith: prefix } },
      select: { key: true },
      take: 500,
    });
    return rows.map((r) => r.key);
  } catch (e) {
    console.error(`  ⚠️ فشل مسح store بالبادئة: ${e.message}`);
    return [];
  }
}

export async function storeDel(key) {
  cache.delete(key);
  try {
    await db().kvStore.delete({ where: { key } }).catch(() => {});
  } catch (e) {
    console.error(`  ⚠️ فشل حذف store: ${e.message}`);
  }
}
