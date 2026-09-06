import { tenantDb, systemDb } from "./src/security/tenantGuard.mjs";
import crypto from "node:crypto";

const nid = (prefix) => `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

export async function bookAppointment({ tenantId, phone, name, service, day, slot }) {
  // DB-level uniqueness (@@unique tenantId/day/slot) is the last line of defense.
  // Map P2002 → clean SLOT_TAKEN error so callers can offer freeSlots().
  try {
    const row = await tenantDb(tenantId).appointment.create({
      data: {
        id: nid("bk"),
        phone, name: name || phone, service, day, slot,
      },
    });
    return rowToBooking(row);
  } catch (e) {
    if (e?.code === "P2002") {
      const err = new Error("SLOT_TAKEN");
      err.code = "SLOT_TAKEN";
      err.meta = { tenantId, day, slot };
      throw err;
    }
    throw e;
  }
}

export async function listAppointments(tenantId) {
  if (!tenantId) throw new Error("listAppointments يتطلب tenantId — استخدم listAppointmentsAll للسوبر");
  const rows = await tenantDb(tenantId).appointment.findMany({
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  return rows.map(rowToBooking);
}

// للسوبر أدمن فقط (قائمة عامة) — مسار معلن ومراقب
export async function listAppointmentsAll() {
  const rows = await systemDb("bookings:listAll").appointment.findMany({
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

// تذكير: حجوزات مؤكدة بدون تذكير ومر عليها N دقيقة (مجدول عام)
export async function dueReminders({ afterMinutes = 60 } = {}) {
  const rows = await systemDb("scheduler:dueReminders").appointment.findMany({
    where: {
      status: "confirmed",
      remindedAt: null,
      createdAt: { lt: new Date(Date.now() - afterMinutes * 60 * 1000) },
    },
  });
  return rows.map(rowToBooking);
}

export async function markReminded(id, tenantId) {
  await tenantDb(tenantId).appointment.update({
    where: { id }, data: { remindedAt: new Date() },
  }).catch(() => null);
}

export async function cancelAppointment(id, tenantId) {
  const row = await tenantDb(tenantId).appointment.update({
    where: { id }, data: { status: "canceled" },
  }).catch(() => null);
  return rowToBooking(row);
}

// ── منع التعارض: هل الموعد محجوز؟ ──
export async function countSlotBookings(tenantId, day, slot) {
  return tenantDb(tenantId).appointment.count({
    where: { day, slot, status: "confirmed" },
  });
}

export async function isSlotTaken(tenantId, day, slot, capacity = 1) {
  return (await countSlotBookings(tenantId, day, slot)) >= capacity;
}

// أقرب الأوقات الفارغة لنفس اليوم
export async function freeSlots(tenantId, day, allSlots, capacity = 1) {
  const free = [];
  for (const s of allSlots || []) {
    if (!(await isSlotTaken(tenantId, day, s, capacity))) free.push(s);
  }
  return free;
}

// قائمة الانتظار: حجوزات بحالة waiting (تُعبأ تلقائياً عند الإلغاء)
// ملاحظة: slot فريد لكل صف حتى لا يتعارض مع @@unique(tenantId, day, slot)
export async function joinWaitingList({ tenantId, phone, name, service }) {
  const row = await tenantDb(tenantId).appointment.create({
    data: {
      id: nid("wt"),
      phone, name: name || phone, service, day: "انتظار", slot: `wl_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`,
      status: "waiting",
    },
  });
  return rowToBooking(row);
}

export async function listWaiting(tenantId, service) {
  const T = tenantId ? tenantDb(tenantId) : systemDb("bookings:waiting-all");
  const rows = await T.appointment.findMany({
    where: {
      status: "waiting",
      ...(service ? { service } : {}),
    },
    orderBy: { createdAt: "asc" },
    take: 20,
  });
  return rows.map(rowToBooking);
}

export async function popWaiting(tenantId, service) {
  const list = await listWaiting(tenantId, service);
  return list[0] || null;
}

export async function removeFromWaiting(id, tenantId) {
  await tenantDb(tenantId).appointment.delete({ where: { id } }).catch(() => null);
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
