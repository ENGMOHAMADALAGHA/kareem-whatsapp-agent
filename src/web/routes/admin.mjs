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
  createPaymentLink,
  detectTotal,
  detectItem,
  dueCartReminders,
  dueCartRemindersAll,
  markCartReminded,
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
import { getHistory, pushHistory } from "../../memory/conversations.mjs";
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
    try {
      const { updateTenant, isTrialExpired } = await import("../../../tenants.mjs");
      const updated = await updateTenant(req.params.id, req.body || {});
      console.log(`  🔌 tenant ${updated.id} enabled=${updated.enabled} plan=${updated.plan}`);
      res.json({ ok: true, tenant: { id: updated.id, enabled: updated.enabled, plan: updated.plan, trialExpired: isTrialExpired(updated) } });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
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
  app.post("/admin/users", async (req, res) => {
    try {
      const { createClientUser } = await import("../../../portal.mjs");
      const u = await createClientUser(req.body || {});
      res.status(201).json({ ok: true, user: { id: u.id, tenantId: u.tenantId, phone: u.phone, name: u.name } });
    } catch (e) {
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
  app.get("/admin/orders", async (req, res) => {
    const scope = resolveScope(req, req.query.tenant);
    if (scope.denied) return denyGlobal(res);
    const { listOrdersAll } = await import("../../../orders.mjs");
    const _or = scope.global ? await listOrdersAll() : await listOrders(scope.tenant);
    res.json({ count: _or.length, orders: _or });
  });
  // تأكيد دفع يدوي (موظف تحقق من المحفظة) + إشعار الزبون
  app.post("/admin/orders/:id/confirm", async (req, res) => {
    const tenantId = req.clientTenant || req.body?.tenantId || req.query.tenant;
    if (!tenantId) return res.status(400).json({ ok: false, error: "tenantId مطلوب" });
    const { getOrder } = await import("../../../orders.mjs");
    const order = await getOrder(req.params.id, tenantId).catch(() => null);
    if (!order) return res.status(404).json({ ok: false, error: "الطلب غير موجود" });
    await markOrderPaid(order.id, tenantId);
    const { getTenantFull } = await import("../../../tenants.mjs");
    const tenant = await getTenantFull(tenantId);
    const { pushHistory } = await import("../../memory/conversations.mjs");
    const msg = `تم استلام الدفع يا بطل ✅ طلبك ${order.id} ($${order.total}) تأكد وبتجهز هلا للتوصيل. شكراً لثقتك!`;
    if (tenant) {
      await sendWhatsAppMessage(order.phone, msg, tenant).catch(() => {});
      await pushHistory(order.phone, "assistant", msg, tenant);
    }
    logEvent("order_paid", { tenantId, phone: order.phone, orderId: order.id, total: order.total, manual: true }).catch(() => {});
    res.json({ ok: true, orderId: order.id });
  });
  app.get("/pay/:orderId", async (req, res) => {
    const { getPublicOrder } = await import("../../../orders.mjs");
    const order = await getPublicOrder(req.params.orderId);
    if (!order) return res.status(404).send("الطلب غير موجود");
    if (req.query.paid === "1") {
      // NEVER trust ?paid=1 alone — only a verified Stripe session may flip to paid.
      // Without STRIPE_SECRET_KEY there is no verification possible → refuse.
      if (!process.env.STRIPE_SECRET_KEY || !order.stripeSessionId) {
        return res.status(402).send(
          `<h2>الدفع غير مؤكد ⏳ ${order.id}</h2><p>رابط الدفع تجريبي — لا يمكن تأكيد الدفع تلقائياً. أكمل الدفع عبر الرابط الرسمي أو انتظر تأكيد الموظف.</p>`
        );
      }
      try {
        const sres = await fetch(`https://api.stripe.com/v1/checkout/sessions/${order.stripeSessionId}`, {
          headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },
        });
        const sess = await sres.json();
        if (sess.payment_status !== "paid") {
          return res.send(`<h2>الدفع غير مكتمل ⏳ ${order.id}</h2><p>لم يصلنا تأكيد الدفع بعد. أكمل الدفع ثم حدّث الصفحة.</p>`);
        }
      } catch (e) {
        return res.status(502).send("تعذر التحقق من الدفع، حاول لاحقاً.");
      }
      const { finalizePaidOrder } = await import("./billing.mjs");
      await finalizePaidOrder(order.id, "pay-page-verified");
      return res.send(`<h2>تم الدفع ✅ ${order.id} - $${order.total}</h2><p>شكراً! كريم معك خطوة بخطوة 👟</p>`);
    }
    res.send(`<h2>طلب ${order.id}</h2><p>${order.items?.map((i) => i.name).join(" + ")} — الإجمالي $${order.total} ${order.currency}</p><a href="/pay/${order.id}?paid=1"><button style="padding:12px 24px">ادفع الآن (تجريبي)</button></a><p>الحالة: ${order.status}</p>`);
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
      message: `البوت رد على ${msgs} رسالة (~${staffHoursSaved} ساعة موظفين)، وحقق $${revenue} مدفوعات، بتقييم ${avgCsat || "—"}/5`,
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
      const lines = list.map((o) => `• ${o.id} ($${o.total})`).join("\n");
      const msg = list.length === 1
        ? `يا هلا يا بطل! 👋 شفنا طلبك ${first.id} ($${first.total}) لسه ما اكتمل. تحب نكمله؟ رابط الدفع: ${first.paymentUrl || "ابعت تم للتأكيد"}`
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
    res.sendFile(ADMIN_HTML);
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
}
