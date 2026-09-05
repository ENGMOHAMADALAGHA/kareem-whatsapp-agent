import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, isDbEnabled } from "./db.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, "appointments.json");

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf-8")).appointments || [];
  } catch {
    return [];
  }
}
function save(all) {
  fs.writeFileSync(FILE, JSON.stringify({ appointments: all }, null, 2) + "\n");
}

export async function bookAppointment({ tenantId, phone, name, service, day, slot }) {
  const id = `bk_${Date.now().toString(36)}`;
  if (isDbEnabled()) {
    await db().query(
      `INSERT INTO appointments (id, tenant_id, phone, name, service, day, slot) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, tenantId, phone, name || phone, service, day, slot]
    );
    return { id, tenantId, phone, name: name || phone, service, day, slot, status: "confirmed" };
  }
  const all = load();
  const booking = {
    id, tenantId, phone, name: name || phone, service, day, slot,
    status: "confirmed", createdAt: new Date().toISOString(),
  };
  all.push(booking);
  save(all);
  return booking;
}

export async function listAppointments(tenantId) {
  if (isDbEnabled()) {
    const r = tenantId
      ? await db().query(`SELECT * FROM appointments WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 500`, [tenantId])
      : await db().query(`SELECT * FROM appointments ORDER BY created_at DESC LIMIT 500`);
    return r.rows.map(rowToBooking);
  }
  return load().filter((b) => !tenantId || b.tenantId === tenantId);
}

function rowToBooking(r) {
  if (!r) return null;
  return {
    id: r.id, tenantId: r.tenant_id, phone: r.phone, name: r.name,
    service: r.service, day: r.day, slot: r.slot, status: r.status,
    remindedAt: r.reminded_at, createdAt: r.created_at,
  };
}

// تذكير: حجوزات مؤكدة بدون تذكير ومر عليها N دقيقة
export async function dueReminders({ afterMinutes = 60 } = {}) {
  if (isDbEnabled()) {
    const r = await db().query(
      `SELECT * FROM appointments WHERE status='confirmed' AND reminded_at IS NULL AND created_at < NOW() - ($1 || ' minutes')::interval`,
      [afterMinutes]
    );
    return r.rows.map(rowToBooking);
  }
  const now = Date.now();
  return load().filter((b) => {
    if (b.status !== "confirmed" || b.remindedAt) return false;
    const created = new Date(b.createdAt).getTime();
    return now - created >= afterMinutes * 60 * 1000;
  });
}

export async function markReminded(id) {
  if (isDbEnabled()) {
    await db().query(`UPDATE appointments SET reminded_at=NOW() WHERE id=$1`, [id]);
    return;
  }
  const all = load();
  const b = all.find((x) => x.id === id);
  if (!b) return null;
  b.remindedAt = new Date().toISOString();
  save(all);
  return b;
}

export async function cancelAppointment(id) {
  if (isDbEnabled()) {
    const r = await db().query(`UPDATE appointments SET status='canceled' WHERE id=$1 RETURNING *`, [id]);
    return rowToBooking(r.rows[0]);
  }
  const all = load();
  const b = all.find((x) => x.id === id);
  if (!b) return null;
  b.status = "canceled";
  save(all);
  return b;
}

// حالة الحجز المؤقتة في الذاكرة (لكل tenant::phone)
const states = new Map();
export function getBookingState(tenantId, phone) {
  return states.get(`${tenantId}::${phone}`) || null;
}
export function setBookingState(tenantId, phone, state) {
  const k = `${tenantId}::${phone}`;
  if (!state) states.delete(k);
  else states.set(k, { ...state, updatedAt: Date.now() });
}
