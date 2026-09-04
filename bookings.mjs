import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

export function bookAppointment({ tenantId, phone, name, service, day, slot }) {
  const all = load();
  const booking = {
    id: `bk_${Date.now().toString(36)}`,
    tenantId, phone, name: name || phone, service, day, slot,
    status: "confirmed", createdAt: new Date().toISOString(),
  };
  all.push(booking);
  save(all);
  return booking;
}

export function listAppointments(tenantId) {
  return load().filter((b) => !tenantId || b.tenantId === tenantId);
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
