import { db } from "./db.mjs";

export async function bookAppointment({ tenantId, phone, name, service, day, slot }) {
  const row = await db().appointment.create({
    data: {
      id: `bk_${Date.now().toString(36)}`,
      tenantId, phone, name: name || phone, service, day, slot,
    },
  });
  return rowToBooking(row);
}

export async function listAppointments(tenantId) {
  const rows = await db().appointment.findMany({
    where: tenantId ? { tenantId } : undefined,
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  return rows.map(rowToBooking);
}

function rowToBooking(r) {
  if (!r) return null;
  return {
    id: r.id, tenantId: r.tenantId, phone: r.phone, name: r.name,
    service: r.service, day: r.day, slot: r.slot, status: r.status,
    remindedAt: r.remindedAt, createdAt: r.createdAt,
  };
}

// تذكير: حجوزات مؤكدة بدون تذكير ومر عليها N دقيقة
export async function dueReminders({ afterMinutes = 60 } = {}) {
  const rows = await db().appointment.findMany({
    where: {
      status: "confirmed",
      remindedAt: null,
      createdAt: { lt: new Date(Date.now() - afterMinutes * 60 * 1000) },
    },
  });
  return rows.map(rowToBooking);
}

export async function markReminded(id) {
  await db().appointment.update({
    where: { id }, data: { remindedAt: new Date() },
  }).catch(() => null);
}

export async function cancelAppointment(id) {
  const row = await db().appointment.update({
    where: { id }, data: { status: "canceled" },
  }).catch(() => null);
  return rowToBooking(row);
}

// حالة الحجز المؤقتة — دائمة في DB (لا تضيع عند restart)
import { storeGet, storeSet, storeDel } from "./store.mjs";
const bkKey = (tenantId, phone) => `booking:${tenantId}::${phone}`;
export async function getBookingState(tenantId, phone) {
  return storeGet(bkKey(tenantId, phone));
}
export async function setBookingState(tenantId, phone, state) {
  if (!state) return storeDel(bkKey(tenantId, phone));
  return storeSet(bkKey(tenantId, phone), { ...state, updatedAt: Date.now() }, 24 * 60 * 60 * 1000);
}
