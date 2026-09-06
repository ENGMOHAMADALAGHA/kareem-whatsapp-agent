import { tenantDb, systemDb } from "./src/security/tenantGuard.mjs";
import { storeGet, storeSet, storeDel } from "./store.mjs";

// ── Broadcast ──
export async function saveBroadcast({ tenantId, text, phones, results }) {
  const rec = {
    id: `bc_${Date.now().toString(36)}`,
    tenantId, text: (text || "").slice(0, 500),
    phones, results,
    createdAt: new Date().toISOString(),
  };
  await tenantDb(tenantId).broadcast.create({
    data: {
      id: rec.id, text: rec.text, phones, results,
    },
  });
  return rec;
}

export async function listBroadcasts(tenantId) {
  const T = tenantId ? tenantDb(tenantId) : systemDb("engage:broadcasts");
  const rows = await T.broadcast.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return rows.map((row) => ({
    id: row.id, tenantId: row.tenantId, text: row.text,
    phones: row.phones, results: row.results, createdAt: row.createdAt,
  }));
}

// ── CSAT ── (طلبات التقييم المعلقة — دائمة في DB)
const csatKey = (t, p) => `csat:${t}::${p}`;

export async function requestCsat(tenantId, phone, refId) {
  return storeSet(csatKey(tenantId, phone), { refId: refId || null, at: Date.now() }, 24 * 60 * 60 * 1000);
}
export async function hasPendingCsat(tenantId, phone) {
  return storeGet(csatKey(tenantId, phone));
}
async function clearPendingCsat(tenantId, phone) {
  return storeDel(csatKey(tenantId, phone));
}
export async function saveRating({ tenantId, phone, score, refId }) {
  const r = {
    id: `cs_${Date.now().toString(36)}`,
    tenantId, phone, score, refId: refId || null,
    createdAt: new Date().toISOString(),
  };
  await tenantDb(tenantId).rating.create({
    data: { id: r.id, phone, score, refId: refId || null },
  });
  await clearPendingCsat(tenantId, phone);
  return r;
}

export async function csatStats(tenantId) {
  const T = tenantId ? tenantDb(tenantId) : systemDb("engage:csat");
  const rows = await T.rating.findMany({
    select: { score: true },
  });
  const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  rows.forEach((r) => { if (dist[r.score] !== undefined) dist[r.score]++; });
  const avg = rows.length ? (rows.reduce((s, r) => s + r.score, 0) / rows.length).toFixed(2) : null;
  return { count: rows.length, avg: avg ? Number(avg) : null, dist };
}
