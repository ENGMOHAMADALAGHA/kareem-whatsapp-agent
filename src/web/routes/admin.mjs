import { getTenantFull, listTenants, addTenant } from "../../../tenants.mjs";
import {
  bookAppointment,
  listAppointments,
  listAppointmentsAll,
  getBookingState,
  setBookingState,
  dueReminders,
  markReminded,
  cancelAppointment,
  joinWaitingList,
  listWaiting,
  popWaiting,
  removeFromWaiting,
  isSlotTaken,
  freeSlots,
} from "../../../bookings.mjs";
import { downloadWhatsAppMedia, transcribeAudio } from "../../../voice.mjs";
import {
  createOrder,
  getOrder,
  listOrders,
  listOrdersAll,
  markOrderPaid,
  detectTotal,
  detectItem,
  dueCartReminders,
  dueCartRemindersAll,
  markCartReminded,
  fmtMoney,
} from "../../../orders.mjs";
import { logEvent, listEvents, toCSV } from "../../../crm.mjs";
import {
  saveBroadcast,
  listBroadcasts,
  requestCsat,
  hasPendingCsat,
  saveRating,
  csatStats,
} from "../../../engage.mjs";
import {
  sendWhatsAppMessage,
  sendButtons,
  sendImage,
  defaultButtonsFor,
} from "../../whatsapp/sender.mjs";
import { getHistory, pushHistory, getMemoryStats } from "../../memory/conversations.mjs";
import { setTakeover, isTakeover, listInbox, getConversation } from "../../inbox/service.mjs";
import { getKareemReply, processCustomerMessage } from "../../ai/kareem.mjs";
import { updateTenant } from "../../../tenants.mjs";
import { createClientUser, listClientUsers } from "../../../portal.mjs";
import { WHATSAPP_TOKEN } from "../../config/env.mjs";

import { webhookQueue } from "../../jobs/queue.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// admin.html lives at repo root; this file is at src/web/routes/
const ADMIN_HTML = path.join(__dirname, "..", "..", "..", "admin.html");

// Fail-closed multi-tenant scope: client JWT may only see its own tenant.
// Global *All() fallbacks require super-admin (Basic). Otherwise 403.
function resolveScope(req, explicitTenant) {
  if (req.clientTenant) return { tenant: req.clientTenant, global: false };
  const t = explicitTenant || req.query.tenant || req.body?.tenantId || req.body?.tenant || null;
  if (t) return { tenant: t, global: false };
  if (req.isSuperAdmin) return { tenant: null, global: true };
  return { tenant: null, global: false, denied: true };
}
function denyGlobal(res) {
  return res.status(403).json({ ok: false, error: "غير مصرح — حدد tenant أو سجل كسوبر أدمن" });
}

export function registerAdminRoutes(app) {
  app.get("/admin/queue", (req, res) => {
    res.json({ ok: true, ...webhookQueue.stats() });
  });
  app.get("/admin/tenants", async (req, res) => {
    const list = await listTenants();
    res.json({ count: list.length, tenants: list, memory: getMemoryStats() });
  });
  app.post("/admin/tenants", async (req, res) => {
    try {
      const created = await addTenant(req.body || {});
      console.log(`  ➕ tenant جديد: ${created.id} (${created.name}) plan=${created.plan}`);
      const { whatsappToken: _s, ...safe } = created;
      res.status(201).json({ ok: true, tenant: { ...safe, hasOwnToken: !!created.whatsappToken } });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });
  app.patch("/admin/tenants/:id", async (req, res) => {
    // عزل العملاء: JWT العميل مقيد ببوته فقط — أي id آخر مرفوض
    if (req.clientTenant && req.params.id !== req.clientTenant) {
      return res.status(403).json({ ok: false, error: "غير مصرح — هذا البوت ليس لك" });
    }
    try {
      const { updateTenant, isTrialExpired } = await import("../../../tenants.mjs");
      const updated = await updateTenant(req.params.id, req.body || {});
      console.log(`  🔌 tenant ${updated.id} enabled=${updated.enabled} plan=${updated.plan}`);
      res.json({ ok: true, tenant: { id: updated.id, enabled: updated.enabled, plan: updated.plan, trialExpired: isTrialExpired(updated) } });
    } catch (e) {
      // P2025 = البوت غير موجود بهذه القاعدة (قائمة قديمة؟ سيرفر مختلف؟) — 404 واضحة بدل 400 عمياء
      if (e?.code === "P2025") {
        return res.status(404).json({ ok: false, error: `البوت "${req.params.id}" غير موجود — حدّث قائمة البوتات وحاول مجدداً` });
      }
      res.status(400).json({ ok: false, error: e.message });
    }
  });
  // معاينة منظور العميل (سوبر فقط): رابط بوابة مؤقت 10 دقائق لنفس البوت
  // للعروض التقديمية — العميل يرى بوابته بالضبط، بنفس العزل الكامل
  app.get("/admin/preview/:tenantId", async (req, res) => {
    if (!req.isSuperAdmin) {
      return res.status(403).json({ ok: false, error: "المعاينة للسوبر أدمن فقط" });
    }
    const t = await getTenantFull(req.params.tenantId);
    if (!t) return res.status(404).json({ ok: false, error: "tenant غير موجود" });
    const { signPreviewToken } = await import("../../../portal.mjs");
    const { PUBLIC_BASE_URL } = await import("../../config/env.mjs");
    const base = (PUBLIC_BASE_URL || "").replace(/\/$/, "");
    const url = `/portal/?tenant=${encodeURIComponent(t.id)}&preview=${encodeURIComponent(signPreviewToken(t.id))}`;
    logEvent("preview", { tenantId: t.id }).catch(() => {});
    res.json({ ok: true, tenantId: t.id, url, absoluteUrl: base ? base + url : url, expiresIn: "10m" });
  });
  // حذف بوت (سوبر فقط عبر SUPER_ONLY) — الحذف متتالٍ لكل بياناته
  app.delete("/admin/tenants/:id", async (req, res) => {
    try {
      const { deleteTenant } = await import("../../../tenants.mjs");
      const out = await deleteTenant(req.params.id);
      console.log(`  🗑️ حذف tenant: ${out.id}`);
      res.json({ ok: true, deleted: out.id });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });
  // فحص الربط الحي: هل Phone ID + Token شغالان فعلاً على Meta؟ (وضع Coexistence)
  app.post("/admin/tenants/:id/test-link", async (req, res) => {
    if (req.clientTenant && req.params.id !== req.clientTenant) {
      return res.status(403).json({ ok: false, error: "غير مصرح — هذا البوت ليس لك" });
    }
    const t = await getTenantFull(req.params.id);
    if (!t) return res.status(404).json({ ok: false, error: "tenant غير موجود" });
    const token = t.whatsapp_token;
    const phoneId = t.phone_number_id;
    if (!token || !phoneId) {
      return res.json({ ok: false, linked: false, reason: "لا توجد بيانات ربط — أدخل Phone ID و Token أولاً" });
    }
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      let r, data;
      try {
        r = await fetch(`https://graph.facebook.com/v18.0/${phoneId}?fields=id,display_phone_number,verified_name,quality_rating`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: ctrl.signal,
        });
        data = await r.json().catch(() => ({}));
      } finally {
        clearTimeout(timer);
      }
      if (!r.ok) {
        return res.json({ ok: false, linked: false, reason: data?.error?.message || ("Meta HTTP " + r.status) });
      }
      logEvent("link_test", { tenantId: t.id, ok: true }).catch(() => {});
      res.json({ ok: true, linked: true, number: data.display_phone_number || null, name: data.verified_name || null, quality: data.quality_rating || null });
    } catch (e) {
      res.json({ ok: false, linked: false, reason: e.message });
    }
  });
  // دعوة عميل: إنشاء حساب بوابة + كلمة مؤقتة + رابط دخول + إرسال واتساب اختياري
  app.post("/admin/invites", async (req, res) => {
    const tenantId = req.clientTenant || req.body?.tenantId;
    const { phone, name, send } = req.body || {};
    if (!tenantId || !phone) return res.status(400).json({ ok: false, error: "tenantId و phone مطلوبان" });
    const { isTenantActive } = await import("../../../tenants.mjs");
    const tenant = await getTenantFull(tenantId);
    if (!tenant) return res.status(404).json({ ok: false, error: "tenant غير موجود" });
    if (!isTenantActive(tenant)) {
      return res.status(403).json({ ok: false, error: "هذا البوت موقوف أو منتهي التجربة" });
    }
    const cryptoMod = await import("node:crypto");
    const tempPassword = cryptoMod.randomBytes(4).toString("hex"); // 8 خانات
    const { createClientUser } = await import("../../../portal.mjs");
    const { PUBLIC_BASE_URL } = await import("../../config/env.mjs");
    let u;
    try {
      u = await createClientUser({ tenantId, phone: String(phone).trim(), name: (name || "").trim() || String(phone).trim(), password: tempPassword, allowReset: true });
    } catch (e) {
      return res.status(400).json({ ok: false, error: e.message });
    }
    const portalUrl = `${(PUBLIC_BASE_URL || "").replace(/\/$/, "")}/portal/?tenant=${encodeURIComponent(tenantId)}`;
    logEvent("invite_created", { tenantId, phone: u.phone }).catch(() => {});
    let sent = false;
    let sendError = null;
    if (send) {
      const msg =
        `أهلاً ${u.name} 👋 تم ربط رقمك مع ${tenant.name} على منصة وصل.\n` +
        `🔗 رابط الدخول: ${portalUrl}\n` +
        `🤖 البوت: ${tenantId}\n📱 الجوال: ${u.phone}\n🔑 كلمة مؤقتة: ${tempPassword}\n` +
        `ادخل وغيّر الكلمة من (نسيت كلمة السر) بعد أول دخول.`;
      try {
        await sendWhatsAppMessage(String(phone).trim(), msg, tenant);
        sent = true;
        logEvent("invite_sent", { tenantId, phone: u.phone }).catch(() => {});
      } catch (e) {
        sendError = e.message;
      }
    }
    res.status(201).json({ ok: true, invite: { tenantId, phone: u.phone, name: u.name, tempPassword, portalUrl, sent, sendError } });
  });
  app.post("/admin/users", async (req, res) => {
    try {
      const { createClientUser } = await import("../../../portal.mjs");
      const u = await createClientUser(req.body || {});
      res.status(201).json({ ok: true, user: { id: u.id, tenantId: u.tenantId, phone: u.phone, name: u.name } });
    } catch (e) {
      if (e?.code === "USER_EXISTS") return res.status(409).json({ ok: false, error: e.message });
      res.status(400).json({ ok: false, error: e.message });
    }
  });
  app.get("/admin/users", async (req, res) => {
    const scope = resolveScope(req, req.query.tenant);
    if (scope.denied) return denyGlobal(res);
    // User list is SUPER_ONLY per middleware, but double-guard global reads here.
    if (scope.global && !req.isSuperAdmin) return denyGlobal(res);
    const { listClientUsers } = await import("../../../portal.mjs");
    const rows = await listClientUsers(scope.global ? undefined : scope.tenant);
    res.json({ count: rows.length, users: rows });
  });
  app.get("/admin/tenants/:id", async (req, res) => {
    if (req.clientTenant && req.params.id !== req.clientTenant) {
      return res.status(403).json({ ok: false, error: "غير مصرح — هذا البوت ليس لك" });
    }
    const t = await getTenantFull(req.params.id);
    if (!t) return res.status(404).json({ ok: false, error: "tenant غير موجود" });
    // إخفاء التوكن (المشفر والمفكوك معاً — لا يغادر الخادم أبداً)
    const { whatsapp_token, whatsappToken: _enc, ...safe } = t;
    res.json({ ok: true, tenant: { ...safe, hasToken: !!whatsapp_token, hasOwnToken: !!_enc } });
  });
  app.get("/admin/appointments", async (req, res) => {
    const scope = resolveScope(req, req.query.tenant);
    if (scope.denied) return denyGlobal(res);
    const { listAppointmentsAll } = await import("../../../bookings.mjs");
    const _ap = scope.global ? await listAppointmentsAll() : await listAppointments(scope.tenant);
    res.json({ count: _ap.length, appointments: _ap });
  });
  // حجز يدوي (موظف الاستقبال: تلفون/حضور) — يحترم القيد الفريد
  app.post("/admin/appointments", async (req, res) => {
    const tenantId = req.clientTenant || req.body?.tenantId || req.query.tenant;
    if (!tenantId) return res.status(400).json({ ok: false, error: "tenantId مطلوب" });
    const { phone, name, service, day, slot } = req.body || {};
    if (!phone || !day || !slot) return res.status(400).json({ ok: false, error: "phone و day و slot مطلوبة" });
    const { bookAppointment, freeSlots } = await import("../../../bookings.mjs");
    try {
      const b = await bookAppointment({ tenantId, phone: String(phone).trim(), name: (name || "").trim() || String(phone).trim(), service: (service || "").trim() || "موعد", day: String(day).trim(), slot: String(slot).trim() });
      const { getTenantFull: gtf } = await import("../../../tenants.mjs");
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
  app.get("/admin/orders", async (req, res) => {
    const scope = resolveScope(req, req.query.tenant);
    if (scope.denied) return denyGlobal(res);
    const { listOrdersAll } = await import("../../../orders.mjs");
    const _or = scope.global ? await listOrdersAll() : await listOrders(scope.tenant);
    res.json({ count: _or.length, orders: _or });
  });
  // ملخص عددي خفيف للطلبات (للكواجهات KPI — تجميع واحد بدل سحب 500 صف)
  app.get("/admin/orders/summary", async (req, res) => {
    const scope = resolveScope(req, req.query.tenant);
    if (scope.denied) return denyGlobal(res);
    const { tenantDb, systemDb } = await import("../../security/tenantGuard.mjs");
    const T = scope.global ? systemDb("orders:summary") : tenantDb(scope.tenant);
    const groups = await T.order.groupBy({ by: ["status"], _count: { _all: true } });
    const byStatus = {};
    let total = 0;
    for (const g of groups) {
      byStatus[g.status] = g._count._all;
      total += g._count._all;
    }
    res.json({ ok: true, tenant: scope.global ? "all" : scope.tenant, total, byStatus });
  });
  // تأكيد دفع يدوي (موظف تحقق من المحفظة) + إشعار الزبون — عبر المسار الذري الموحد
  app.post("/admin/orders/:id/confirm", async (req, res) => {
    const tenantId = req.clientTenant || req.body?.tenantId || req.query.tenant;
    if (!tenantId) return res.status(400).json({ ok: false, error: "tenantId مطلوب" });
    const { getOrder } = await import("../../../orders.mjs");
    const order = await getOrder(req.params.id, tenantId).catch(() => null);
    if (!order) return res.status(404).json({ ok: false, error: "الطلب غير موجود" });
    const { finalizePaidOrder } = await import("./billing.mjs");
    const { already } = await finalizePaidOrder(order.id, "manual", { csat: false });
    if (already) return res.json({ ok: true, orderId: order.id, already: true });
    const { getTenantFull } = await import("../../../tenants.mjs");
    const tenant = await getTenantFull(tenantId);
    const { pushHistory } = await import("../../memory/conversations.mjs");
    const msg = `تم استلام الدفع يا بطل ✅ طلبك ${order.id} (${fmtMoney(order.total, order.currency)}) تأكد وبتجهز هلا للتوصيل. شكراً لثقتك!`;
    if (tenant) {
      await sendWhatsAppMessage(order.phone, msg, tenant).catch(() => {});
      await pushHistory(order.phone, "assistant", msg, tenant);
    }
    res.json({ ok: true, orderId: order.id });
  });
  app.post("/admin/broadcast", async (req, res) => {
    const { tenantId, text, phones } = req.body || {};
    if (!tenantId || !text || !Array.isArray(phones) || !phones.length) {
      return res.status(400).json({ ok: false, error: "tenantId و text و phones[] مطلوبة" });
    }
    if (phones.length > 50) return res.status(400).json({ ok: false, error: "الحد الأقصى 50 رقم لكل بث" });
    const tenant = await getTenantFull(tenantId);
    if (!tenant) return res.status(404).json({ ok: false, error: "tenant غير موجود" });
    const { isTenantActive } = await import("../../../tenants.mjs");
    if (!isTenantActive(tenant)) {
      return res.status(403).json({ ok: false, error: tenant.enabled === false ? "هذا البوت موقوف" : "الفترة التجريبية لهذا البوت انتهت — جدد الخطة" });
    }
    // امتثال: استبعاد من ألغوا الاشتراك قبل الإرسال
    const { isOptedOut } = await import("../../compliance/messaging.mjs");
    const eligible = [];
    const skippedOptOut = [];
    for (const phone of phones) {
      if (await isOptedOut(tenantId, phone)) skippedOptOut.push(phone);
      else eligible.push(phone);
    }
    const results = [];
    for (const phone of eligible) {
      try {
        await sendWhatsAppMessage(phone, text, tenant);
        await pushHistory(phone, "assistant", text, tenant);
        results.push({ phone, ok: true });
      } catch (e) {
        results.push({ phone, ok: false, error: e.message });
      }
      await new Promise((r) => setTimeout(r, 800)); // تجنب rate limit
    }
    const rec = await saveBroadcast({ tenantId, text, phones, results });
    logEvent("broadcast", { tenantId, count: phones.length, sent: results.filter((r) => r.ok).length, broadcastId: rec.id, skippedOptOut: skippedOptOut.length }).catch(() => {});
    res.json({ ok: true, broadcast: rec, skippedOptOut });
  });
  app.get("/admin/broadcasts", async (req, res) => {
    const scope = resolveScope(req, req.query.tenant);
    if (scope.denied) return denyGlobal(res);
    if (scope.global && !req.isSuperAdmin) return denyGlobal(res);
    const all = await listBroadcasts(scope.global ? undefined : scope.tenant);
    res.json({ count: all.length, broadcasts: all });
  });
  app.get("/admin/report", async (req, res) => {
    const scope = resolveScope(req, req.query.tenant);
    if (scope.denied) return denyGlobal(res);
    const tenantId = scope.global ? undefined : scope.tenant;
    const days = Number(req.query.days || 30);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const { tenantDb, systemDb } = await import("../../security/tenantGuard.mjs");
    const T = tenantId ? tenantDb(tenantId) : systemDb("report:global");
    const where = { createdAt: { gte: since } };
    const [msgs, orders, bookings, ratings, broadcasts] = await Promise.all([
      T.message.count({ where }),
      T.order.findMany({ where, select: { total: true, status: true } }),
      T.appointment.count({ where }),
      T.rating.findMany({ where, select: { score: true } }),
      T.broadcast.count({ where }),
    ]);
    const revenue = orders.filter((o) => o.status === "paid").reduce((s, o) => s + Number(o.total), 0);
    const avgCsat = ratings.length ? Number((ratings.reduce((s, r) => s + r.score, 0) / ratings.length).toFixed(2)) : null;
    const staffHoursSaved = Number(((msgs * 3) / 60).toFixed(1)); // 3 دقائق لكل رد آلي
    res.json({
      ok: true, tenant: tenantId || "all", days,
      messagesHandled: msgs,
      orders: { count: orders.length, paid: orders.filter((o) => o.status === "paid").length, revenue },
      bookings: bookings,
      csat: { avg: avgCsat, count: ratings.length },
      broadcasts,
      staffHoursSaved,
      message: `البوت رد على ${msgs} رسالة (~${staffHoursSaved} ساعة موظفين)، وحقق ${fmtMoney(revenue, "JOD")} مدفوعات، بتقييم ${avgCsat || "—"}/5`,
    });
  });
  app.post("/admin/csat-request", async (req, res) => {
    const { tenantId, phone } = req.body || {};
    if (!tenantId || !phone) return res.status(400).json({ ok: false, error: "tenantId و phone مطلوبان" });
    const tenant = await getTenantFull(tenantId);
    if (!tenant) return res.status(404).json({ ok: false, error: "tenant غير موجود" });
    const msg = `شكراً لتعاملك معنا يا غالي! 🙏 قيّم تجربتك من 1 (سيئة) إلى 5 (ممتازة) — ابعت الرقم فقط.`;
    await requestCsat(tenantId, phone, null);
    try {
      await sendWhatsAppMessage(phone, msg, tenant);
      await pushHistory(phone, "assistant", msg, tenant);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
  app.get("/admin/csat", async (req, res) => {
    const scope = resolveScope(req, req.query.tenant);
    if (scope.denied) return denyGlobal(res);
    res.json({ ok: true, ...(await csatStats(scope.global ? undefined : scope.tenant)) });
  });
  app.get("/admin/crm", async (req, res) => {
    const scope = resolveScope(req, req.query.tenant);
    if (scope.denied) return denyGlobal(res);
    const { type, limit } = req.query;
    const events = await listEvents({ tenantId: scope.global ? undefined : scope.tenant, type, limit: Number(limit || 100) });
    res.json({ count: events.length, events });
  });
  app.get("/admin/crm/export.csv", async (req, res) => {
    const scope = resolveScope(req, req.query.tenant);
    if (scope.denied) return denyGlobal(res);
    const { type } = req.query;
    const events = await listEvents({ tenantId: scope.global ? undefined : scope.tenant, type, limit: 2000 });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=crm.csv");
    res.send("\uFEFF" + toCSV(events));
  });
  app.post("/admin/cart-remind-run", async (req, res) => {
    const afterMinutes = Number(req.body?.afterMinutes ?? 60);
    const scopeTenant = req.clientTenant || req.body?.tenantId || null;
    const { dueCartRemindersAll } = await import("../../../orders.mjs");
    const due = scopeTenant
      ? await dueCartReminders(scopeTenant, { afterMinutes })
      : await dueCartRemindersAll({ afterMinutes });
    // تجميع: رسالة واحدة لكل رقم بدل رسالة لكل طلب
    const byPhone = new Map();
    for (const o of due) {
      const key = `${o.tenantId}::${o.phone}`;
      if (!byPhone.has(key)) byPhone.set(key, []);
      byPhone.get(key).push(o);
    }
    const sent = [];
    for (const [, list] of byPhone) {
      const first = list[0];
      const tenant = await getTenantFull(first.tenantId);
      if (!tenant) continue;
      const lines = list.map((o) => `• ${o.id} (${fmtMoney(o.total, o.currency)})`).join("\n");
      const msg = list.length === 1
        ? `يا هلا يا بطل! 👋 شفنا طلبك ${first.id} (${fmtMoney(first.total, first.currency)}) لسه ما اكتمل. تحب نكمله؟ ابعت لقطة الشاشة هون 📸`
        : `يا هلا يا بطل! 👋 عندك ${list.length} طلبات لسه ما اكتملت:\n${lines}\nابعت رقم الطلب لنكمله مع بعض.`;
      try {
        await sendWhatsAppMessage(first.phone, msg, tenant);
        await pushHistory(first.phone, "assistant", msg, tenant);
        for (const o of list) {
          await markCartReminded(o.id, o.tenantId);
        }
        logEvent("cart_reminded", { tenantId: first.tenantId, phone: first.phone, orderIds: list.map((o) => o.id) }).catch(() => {});
        sent.push(...list.map((o) => o.id));
      } catch (e) {
        console.error(`  ❌ فشل تذكير السلة لـ ${first.phone}: ${e.message}`);
      }
    }
    res.json({ ok: true, due: due.length, sent });
  });
  app.get("/admin/inbox", async (req, res) => {
    const scope = resolveScope(req, req.query.tenant);
    if (scope.denied) return denyGlobal(res);
    const inbox = await listInbox(scope.global ? undefined : scope.tenant);
    res.json({ count: inbox.length, inbox });
  });
  app.get("/admin/inbox/:tenantId/:phone", async (req, res) => {
    if (req.clientTenant && req.params.tenantId !== req.clientTenant) {
      return res.status(403).json({ ok: false, error: "غير مصرح — هذه المحادثة ليست لك" });
    }
    const tenantId = req.clientTenant || req.params.tenantId;
    const { phone } = req.params;
    res.json({
      tenantId, phone,
      takeover: await isTakeover(tenantId, phone),
      messages: await getConversation(tenantId, phone),
    });
  });
  app.post("/admin/takeover", async (req, res) => {
    const { tenantId, phone, enabled, by } = req.body || {};
    if (!tenantId || !phone) return res.status(400).json({ ok: false, error: "tenantId و phone مطلوبان" });
    await setTakeover(tenantId, phone, !!enabled, by);
    logEvent(!!enabled ? "takeover" : "handover", { tenantId, phone, by }).catch(() => {});
    res.json({ ok: true, takeover: await isTakeover(tenantId, phone) });
  });
  app.post("/admin/send", async (req, res) => {
    const { tenantId, phone, text } = req.body || {};
    if (!tenantId || !phone || !text) return res.status(400).json({ ok: false, error: "tenantId و phone و text مطلوبة" });
    const tenant = await getTenantFull(tenantId);
    if (!tenant) return res.status(404).json({ ok: false, error: "tenant غير موجود" });
    try {
      const r = await sendWhatsAppMessage(phone, text, tenant);
      await pushHistory(phone, "assistant", text, tenant);
      res.json({ ok: true, result: r });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
  app.get("/admin/", (req, res) => {
    res.sendFile(ADMIN_HTML);
  });
  app.get("/portal/", (req, res) => {
    res.sendFile(path.join(ADMIN_HTML, "..", "client.html"));
  });
  app.get("/admin/inbox.html", (req, res) => {
    res.send(`<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>Inbox</title>
<style>body{font-family:system-ui;margin:20px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:8px}.u{color:#0a7}.a{color:#06c}</style></head><body>
<h2>📥 Inbox — المحادثات الحية</h2>
<p>API: <code>/admin/inbox?tenant=ID</code> | محادثة: <code>/admin/inbox/:tenant/:phone</code></p>
<table id="t"><tr><th>البوت</th><th>الرقم</th><th>takeover</th><th>آخر رسالة</th><th>إجراء</th></tr></table>
<script>
async function load(){ const q=new URLSearchParams(location.search); const r=await fetch('/admin/inbox?tenant='+(q.get('tenant')||'')); const j=await r.json();
const t=document.getElementById('t');
j.inbox.forEach(c=>{ const tr=document.createElement('tr');
const td1=document.createElement('td'); td1.textContent=c.tenantId||''; tr.appendChild(td1);
const td2=document.createElement('td'); td2.textContent=c.phone||''; tr.appendChild(td2);
const td3=document.createElement('td'); td3.textContent=(c.takeover?'⏸️':'✅'); tr.appendChild(td3);
const td4=document.createElement('td'); td4.textContent=(c.lastMessage?c.lastMessage.text:''); tr.appendChild(td4);
const b=document.createElement('button'); b.textContent=c.takeover?'تشغيل البوت':'إيقاف للموظف';
b.onclick=async()=>{ await fetch('/admin/takeover',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tenantId:c.tenantId,phone:c.phone,enabled:!c.takeover})}); load(); };
const td=document.createElement('td'); td.appendChild(b); tr.appendChild(td); t.appendChild(tr); }); }
load();
</script></body></html>`);
  });
  app.post("/admin/remind-run", async (req, res) => {
    const afterMinutes = Number(req.body?.afterMinutes ?? 1);
    const due = await dueReminders({ afterMinutes });
    const sent = [];
    for (const b of due) {
      const tenant = await getTenantFull(b.tenantId);
      if (!tenant) continue;
      const msg = `تذكير بموعدك يا غالي ⏰ ${b.service} - الساعة ${b.slot} (${b.id}) في ${tenant.name}. للتأكيد ابعت "تم"، وللإلغاء ابعت "أريد موظف".`;
      try {
        await sendWhatsAppMessage(b.phone, msg, tenant);
        await pushHistory(b.phone, "assistant", msg, tenant);
        await markReminded(b.id, b.tenantId);
        sent.push(b.id);
      } catch (e) {
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
        const msg = `خبر حلو يا غالي 🎉 فضي موعد ${b.service || ""} — الساعة ${b.slot || ""}. رد بـ "تم" خلال ساعة لتأكيده، أو تجاهل الرسالة.`;
        if (tenant) {
          await sendWhatsAppMessage(next.phone, msg, tenant).catch(() => {});
          await pushHistory(next.phone, "assistant", msg, tenant);
        }
        await setBookingState(b.tenantId, next.phone, { step: "offer", service: b.service, slot: b.slot, day: b.day });
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
    const { bookingsToCSV } = await import("../../../bookings.mjs");
    const { tenantDb, systemDb } = await import("../../security/tenantGuard.mjs");
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
  // إعادة جدولة حجز (يحترم القيد الفريد — تعارض → 409 مع البدائل)
  app.post("/admin/appointments/:id/reschedule", async (req, res) => {
    const tenantId = req.clientTenant || req.body?.tenantId || req.query.tenant;
    if (!tenantId) return res.status(400).json({ ok: false, error: "tenantId مطلوب" });
    const { day, slot } = req.body || {};
    if (!day || !slot) return res.status(400).json({ ok: false, error: "day و slot مطلوبان" });
    const { rescheduleAppointment, freeSlots } = await import("../../../bookings.mjs");
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
    const { tenantDb } = await import("../../security/tenantGuard.mjs");
    const b = await tenantDb(tenantId).appointment.findFirst({ where: { id: req.params.id } }).catch(() => null);
    if (!b) return res.status(404).json({ ok: false, error: "حجز غير موجود" });
    const tenant = await getTenantFull(tenantId);
    if (!tenant) return res.status(404).json({ ok: false, error: "tenant غير موجود" });
    const { markReminded } = await import("../../../bookings.mjs");
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
