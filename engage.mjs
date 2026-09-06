import { db } from "./db.mjs";

// ── Broadcast ──
export async function saveBroadcast({ tenantId, text, phones, results }) {
  const rec = {
    id: `bc_${Date.now().toString(36)}`,
    tenantId, text: (text || "").slice(0, 500),
    phones, results,
    createdAt: new Date().toISOString(),
  };
  await db().broadcast.create({
    data: {
      id: rec.id, tenantId, text: rec.text, phones, results,
    },
  });
  return rec;
}

export async function listBroadcasts(tenantId) {
  const rows = await db().broadcast.findMany({
    where: tenantId ? { tenantId } : undefined,
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return rows.map((row) => ({
    id: row.id, tenantId: row.tenantId, text: row.text,
    phones: row.phones, results: row.results, createdAt: row.createdAt,
  }));
}

// ── CSAT ──
const pending = new Map(); // tenant::phone -> {refId, at}
const keyOf = (t, p) => `${t}::${p}`;

export function requestCsat(tenantId, phone, refId) {
  pending.set(keyOf(tenantId, phone), { refId: refId || null, at: Date.now() });
}
export function hasPendingCsat(tenantId, phone) {
  const s = pending.get(keyOf(tenantId, phone));
  if (!s) return null;
  if (Date.now() - s.at > 24 * 60 * 60 * 1000) {
    pending.delete(keyOf(tenantId, phone));
    return null;
  }
  return s;
}
export async function saveRating({ tenantId, phone, score, refId }) {
  const r = {
    id: `cs_${Date.now().toString(36)}`,
    tenantId, phone, score, refId: refId || null,
    createdAt: new Date().toISOString(),
  };
  await db().rating.create({
    data: { id: r.id, tenantId, phone, score, refId: refId || null },
  });
  pending.delete(keyOf(tenantId, phone));
  return r;
}

export async function csatStats(tenantId) {
  const rows = await db().rating.findMany({
    where: tenantId ? { tenantId } : undefined,
    select: { score: true },
  });
  const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  rows.forEach((r) => { if (dist[r.score] !== undefined) dist[r.score]++; });
  const avg = rows.length ? (rows.reduce((s, r) => s + r.score, 0) / rows.length).toFixed(2) : null;
  return { count: rows.length, avg: avg ? Number(avg) : null, dist };
}
