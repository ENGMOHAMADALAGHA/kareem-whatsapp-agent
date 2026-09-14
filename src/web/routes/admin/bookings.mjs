// راوتر الحجوزات: appointments CRUD + waiting + remind-run + cancel + export + reschedule
import { getTenantFull } from "../../../../tenants.mjs";
import {
  listAppointments,
  cancelAppointment,
  setBookingState,
  dueReminders,
  markReminded,
  listWaiting,
  popWaiting,
  removeFromWaiting,
} from "../../../../bookings.mjs";
import { sendWhatsAppMessage } from "../../../whatsapp/sender.mjs";
import { pushHistory } from "../../../memory/conversations.mjs";
import { sendWithWindowFallback } from "../../../compliance/messaging.mjs";
import { logEvent } from "../../../../crm.mjs";
import { resolveScope, denyGlobal } from "./scope.mjs";

export function registerBookingRoutes(app) {
  app.get("/admin/appointments", async (req, res) => {
    const scope = resolveScope(req, req.query.tenant);
    if (scope.denied) return denyGlobal(res);
    const { listAppointmentsAll } = await import("../../../../bookings.mjs");
    const _ap = scope.global ? await listAppointmentsAll() : await listAppointments(scope.tenant);
    res.json({ count: _ap.length, appointments: _ap });
  });
  // حجز يدوي (موظف الاستقبال: تلفون/حضور) — يحترم القيد الفريد
  app.post("/admin/appointments", async (req, res) => {
    const tenantId = req.clientTenant || req.body?.tenantId || req.query.tenant;
    if (!tenantId) return res.status(400).json({ ok: false, error: "tenantId مطلوب" });
    const { phone, name, service, day, slot } = req.body || {};
    if (!phone || !day || !slot) return res.status(400).json({ ok: false, error: "phone و day و slot مطلوبة" });
    const { bookAppointment, freeSlots } = await import("../../../../bookings.mjs");
    try {
      const { isTenantActive: isActiveManual } = await import("../../../../tenants.mjs");
      const tCheck = await getTenantFull(tenantId);
      if (tCheck && !isActiveManual(tCheck)) {
        return res.status(403).json({ ok: false, error: "هذا البوت موقوف أو منتهي التجربة" });
      }
      const b = await bookAppointment({ tenantId, phone: String(phone).trim(), name: (name || "").trim() || String(phone).trim(), service: (service || "").trim() || "موعد", day: String(day).trim(), slot: String(slot).trim() });
      const { getTenantFull: gtf } = await import("../../../../tenants.mjs");
      const tenant = await gtf(tenantId);
      if (tenant) {
        const msg = `تم حجز موعدك يا غالي ✅ ${b.service} — ${b.day} الساعة ${b.slot} (${b.id}) في ${tenant.name}. بنتشرف فيك!`;
        await sendWhatsAppMessage(b.phone, msg, tenant).catch(() => {});
        await pushHistory(b.phone, "assistant", msg, tenant).catch(() => {});
      }
      logEvent("booking", { tenantId, phone: b.phone, bookingId: b.id, service: b.service, slot: b.slot, manual: true }).catch(() => {});
      res.status(201).json({ ok: true, booking: b });
    } catch (e) {
      if (e?.code === "SLOT_TAKEN") {
        const tenant = await getTenantFull(tenantId);
        const free = await freeSlots(tenantId, String(day).trim(), tenant?.features?.bookingSlots).catch(() => []);
        return res.status(409).json({ ok: false, error: "الموعد محجوز", free });
      }
      res.status(400).json({ ok: false, error: e.message });
    }
  });
  app.post("/admin/remind-run", async (req, res) => {
    const afterMinutes = Number(req.body?.afterMinutes ?? 1);
    const scopeTenant = req.clientTenant || null;
    const dueAll = await dueReminders({ afterMinutes });
    // عزل العميل: بوابة العميل تشغّل تذكير بوته فقط — أبداً كل البوتات
    const due = scopeTenant ? dueAll.filter((b) => b.tenantId === scopeTenant) : dueAll;
    const sent = [];
    for (const b of due) {
      const tenant = await getTenantFull(b.tenantId);
      if (!tenant) continue;
      const { isTenantActive } = await import("../../../../tenants.mjs");
      if (!isTenantActive(tenant)) continue; // kill-switch: لا تذكير لموقوف/منتهي
      const msg = `تذكير بموعدك يا غالي ⏰ ${b.service} - الساعة ${b.slot} (${b.id}) في ${tenant.name}. للتأكيد ابعت "تم"، وللإلغاء ابعت "أريد موظف".`;
      // ادّعاء ذري قبل الإرسال — لا تكرار مع المؤقت أو مع نسخة أخرى
      const claimed = await markReminded(b.id, b.tenantId);
      if (!claimed) continue;
      sent.push(b.id);
      try {
        const r = await sendWithWindowFallback(b.phone, msg, tenant);
        if (!r.ok) {
          console.log(`  ⏭️ تذكير يدوي ${b.id} -> ${b.phone}: ${r.reason}`);
        } else {
          await pushHistory(b.phone, "assistant", msg, tenant);
        }
      } catch (e) {
        const { unmarkReminded } = await import("../../../../bookings.mjs");
        await unmarkReminded(b.id, b.tenantId); // فشل عابر → يُعاد في دورة لاحقة
        console.error(`  ❌ فشل التذكير ${b.id}: ${e.message}`);
      }
    }
    res.json({ ok: true, due: due.length, sent });
  });
  app.post("/admin/appointments/:id/cancel", async (req, res) => {
    const tenantId = req.clientTenant || req.body?.tenantId || req.query.tenant;
    if (!tenantId) return res.status(400).json({ ok: false, error: "tenantId مطلوب" });
    const b = await cancelAppointment(req.params.id, tenantId);
    if (!b) return res.status(404).json({ ok: false, error: "حجز غير موجود" });
    logEvent("booking_canceled", { tenantId: b.tenantId, phone: b.phone, bookingId: b.id, service: b.service, slot: b.slot }).catch(() => {});
    // تعبئة تلقائية: أول واحد بالانتظار ياخذ الموعد
    let offered = null;
    try {
      const next = await popWaiting(b.tenantId, b.service);
      if (next) {
        const tenant = await getTenantFull(b.tenantId);
        const msg = `خبر حلو يا غالي 🎉 فضي موعد ${b.service || ""} — يوم ${b.day || "أقرب يوم"} — الساعة ${b.slot || ""}. رد بـ "تم" خلال ساعة لتأكيده، أو تجاهل الرسالة.`;
        if (tenant) {
          // يمر عبر البديل المتوافق: لا رسالة خارج نافذة 24h بدون قالب
          await sendWithWindowFallback(next.phone, msg, tenant).catch(() => {});
          await pushHistory(next.phone, "assistant", msg, tenant);
        }
        await setBookingState(b.tenantId, next.phone, { step: "offer", service: b.service, slot: b.slot, day: b.day, offeredAt: Date.now() });
        await removeFromWaiting(next.id, b.tenantId);
        offered = next.phone;
        console.log(`  📋 عرض موعد ملغي ${b.id} على ${offered}`);
      }
    } catch (e) {
      console.error(`  ❌ خطأ تعبئة الانتظار: ${e.message}`);
    }
    res.json({ ok: true, booking: b, offeredTo: offered });
  });
  app.get("/admin/waiting", async (req, res) => {
    const scope = resolveScope(req, req.query.tenant);
    if (scope.denied) return denyGlobal(res);
    const list = await listWaiting(scope.global ? undefined : scope.tenant, req.query.service);
    res.json({ count: list.length, waiting: list });
  });
  // تصدير الحجوزات Excel/CSV (بوت + مدى تاريخ اختياري على createdAt)
  app.get("/admin/appointments/export.csv", async (req, res) => {
    const scope = resolveScope(req, req.query.tenant);
    if (scope.denied) return denyGlobal(res);
    const { bookingsToCSV } = await import("../../../../bookings.mjs");
    const { tenantDb, systemDb } = await import("../../../security/tenantGuard.mjs");
    const T = scope.global ? systemDb("bookings:export") : tenantDb(scope.tenant);
    const where = {};
    const from = req.query.from ? new Date(req.query.from) : null;
    const to = req.query.to ? new Date(req.query.to) : null;
    if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime()))) {
      return res.status(400).json({ ok: false, error: "صيغة التاريخ غير صالحة (YYYY-MM-DD)" });
    }
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = from;
      if (to) where.createdAt.lte = new Date(to.getTime() + 24 * 60 * 60 * 1000 - 1);
    }
    const rows = await T.appointment.findMany({ where, orderBy: { createdAt: "desc" }, take: 2000 });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=appointments.csv");
    const mapped = rows.map((r) => ({
      id: r.id, name: r.name, phone: r.phone, service: r.service, day: r.day,
      slot: r.slot, status: r.status, remindedAt: r.remindedAt, createdAt: r.createdAt,
    }));
    res.send(bookingsToCSV(mapped));
  });
  // تعديل حجز (اسم/هاتف/خدمة/يوم/وقت) — تعارض الموعد → 409 مع البدائل
  app.patch("/admin/appointments/:id", async (req, res) => {
    const tenantId = req.clientTenant || req.body?.tenantId || req.query.tenant;
    if (!tenantId) return res.status(400).json({ ok: false, error: "tenantId مطلوب" });
    const { updateAppointment, freeSlots } = await import("../../../../bookings.mjs");
    try {
      const b = await updateAppointment(req.params.id, tenantId, req.body || {});
      if (!b) return res.status(404).json({ ok: false, error: "حجز غير موجود" });
      logEvent("booking_updated", { tenantId, bookingId: b.id }).catch(() => {});
      res.json({ ok: true, booking: b });
    } catch (e) {
      if (e?.code === "SLOT_TAKEN") {
        const tenant = await getTenantFull(tenantId);
        const free = await freeSlots(tenantId, req.body?.day, tenant?.features?.bookingSlots).catch(() => []);
        return res.status(409).json({ ok: false, error: "الموعد الجديد محجوز", free });
      }
      res.status(400).json({ ok: false, error: e.message });
    }
  });
  app.post("/admin/appointments/:id/reschedule", async (req, res) => {
    const tenantId = req.clientTenant || req.body?.tenantId || req.query.tenant;
    if (!tenantId) return res.status(400).json({ ok: false, error: "tenantId مطلوب" });
    const { day, slot } = req.body || {};
    if (!day || !slot) return res.status(400).json({ ok: false, error: "day و slot مطلوبان" });
    const { rescheduleAppointment, freeSlots } = await import("../../../../bookings.mjs");
    try {
      const b = await rescheduleAppointment(req.params.id, tenantId, { day, slot });
      if (!b) return res.status(404).json({ ok: false, error: "حجز غير موجود" });
      logEvent("booking_rescheduled", { tenantId, bookingId: b.id, day, slot }).catch(() => {});
      res.json({ ok: true, booking: b });
    } catch (e) {
      if (e?.code === "SLOT_TAKEN") {
        const tenant = await getTenantFull(tenantId);
        const free = await freeSlots(tenantId, day, tenant?.features?.bookingSlots).catch(() => []);
        return res.status(409).json({ ok: false, error: "الموعد الجديد محجوز", free });
      }
      res.status(400).json({ ok: false, error: e.message });
    }
  });
  // تذكير يدوي لحجز واحد (يرسل الآن ويعلّم)
  app.post("/admin/appointments/:id/remind", async (req, res) => {
    const tenantId = req.clientTenant || req.body?.tenantId || req.query.tenant;
    if (!tenantId) return res.status(400).json({ ok: false, error: "tenantId مطلوب" });
    const { tenantDb } = await import("../../../security/tenantGuard.mjs");
    const b = await tenantDb(tenantId).appointment.findFirst({ where: { id: req.params.id } }).catch(() => null);
    if (!b) return res.status(404).json({ ok: false, error: "حجز غير موجود" });
    const tenant = await getTenantFull(tenantId);
    if (!tenant) return res.status(404).json({ ok: false, error: "tenant غير موجود" });
    const { isTenantActive: isActiveSingle } = await import("../../../../tenants.mjs");
    if (!isActiveSingle(tenant)) {
      return res.status(403).json({ ok: false, error: "هذا البوت موقوف أو منتهي التجربة" });
    }
    const { markReminded } = await import("../../../../bookings.mjs");
    const msg = `تذكير بموعدك يا غالي ⏰ ${b.service} - الساعة ${b.slot} (${b.id}) في ${tenant.name}. للتأكيد ابعت "تم"، وللإلغاء ابعت "أريد موظف".`;
    try {
      await sendWhatsAppMessage(b.phone, msg, tenant);
      await pushHistory(b.phone, "assistant", msg, tenant);
      await markReminded(b.id, tenantId);
      logEvent("booking_reminded", { tenantId, phone: b.phone, bookingId: b.id, manual: true }).catch(() => {});
      res.json({ ok: true, sent: b.id });
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message });
    }
  });
}
