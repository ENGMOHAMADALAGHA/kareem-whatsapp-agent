import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, isDbEnabled } from "./db.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BC_FILE = path.join(__dirname, "broadcasts.json");
const CSAT_FILE = path.join(__dirname, "csat.json");

function loadJson(file, key) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"))[key] || [];
  } catch {
    return [];
  }
}
function saveJson(file, key, arr) {
  fs.writeFileSync(file, JSON.stringify({ [key]: arr }, null, 2) + "\n");
}

// ── Broadcast ──
export async function saveBroadcast({ tenantId, text, phones, results }) {
  const rec = {
    id: `bc_${Date.now().toString(36)}`,
    tenantId, text: (text || "").slice(0, 500),
    phones, results,
    createdAt: new Date().toISOString(),
  };
  if (isDbEnabled()) {
    await db().query(
      `INSERT INTO broadcasts (id, tenant_id, text, phones, results) VALUES ($1,$2,$3,$4,$5)`,
      [rec.id, tenantId, rec.text, JSON.stringify(phones), JSON.stringify(results)]
    );
    return rec;
  }
  const all = loadJson(BC_FILE, "broadcasts");
  all.push(rec);
  saveJson(BC_FILE, "broadcasts", all);
  return rec;
}

export async function listBroadcasts(tenantId) {
  if (isDbEnabled()) {
    const r = tenantId
      ? await db().query(`SELECT * FROM broadcasts WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 200`, [tenantId])
      : await db().query(`SELECT * FROM broadcasts ORDER BY created_at DESC LIMIT 200`);
    return r.rows.map((row) => ({
      id: row.id, tenantId: row.tenant_id, text: row.text,
      phones: typeof row.phones === "string" ? JSON.parse(row.phones) : row.phones,
      results: typeof row.results === "string" ? JSON.parse(row.results) : row.results,
      createdAt: row.created_at,
    }));
  }
  return loadJson(BC_FILE, "broadcasts").filter((b) => !tenantId || b.tenantId === tenantId);
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
  if (isDbEnabled()) {
    await db().query(
      `INSERT INTO ratings (id, tenant_id, phone, score, ref_id) VALUES ($1,$2,$3,$4,$5)`,
      [r.id, tenantId, phone, score, refId || null]
    );
    pending.delete(keyOf(tenantId, phone));
    return r;
  }
  const all = loadJson(CSAT_FILE, "ratings");
  all.push(r);
  saveJson(CSAT_FILE, "ratings", all);
  pending.delete(keyOf(tenantId, phone));
  return r;
}

export async function csatStats(tenantId) {
  let all;
  if (isDbEnabled()) {
    const r = tenantId
      ? await db().query(`SELECT score FROM ratings WHERE tenant_id=$1`, [tenantId])
      : await db().query(`SELECT score FROM ratings`);
    all = r.rows;
  } else {
    all = loadJson(CSAT_FILE, "ratings").filter((r) => !tenantId || r.tenantId === tenantId);
  }
  const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  all.forEach((r) => { if (dist[r.score] !== undefined) dist[r.score]++; });
  const avg = all.length ? (all.reduce((s, r) => s + r.score, 0) / all.length).toFixed(2) : null;
  return { count: all.length, avg: avg ? Number(avg) : null, dist };
}
