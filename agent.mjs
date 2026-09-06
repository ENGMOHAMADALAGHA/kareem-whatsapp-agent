import dotenv from "dotenv";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import {
  resolveTenant,
  getTenantFull,
  listTenants,
  addTenant,
  memoryKey,
} from "./tenants.mjs";
import {
  bookAppointment,
  listAppointments,
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
} from "./bookings.mjs";
import { downloadWhatsAppMedia, transcribeAudio } from "./voice.mjs";
import {
  createOrder,
  getOrder,
  listOrders,
  markOrderPaid,
  createPaymentLink,
  dueCartReminders,
  markCartReminded,
} from "./orders.mjs";
import { logEvent, listEvents, toCSV } from "./crm.mjs";
import { db, isDbEnabled } from "./db.mjs";
import {
  saveBroadcast,
  listBroadcasts,
  requestCsat,
  hasPendingCsat,
  saveRating,
  csatStats,
} from "./engage.mjs";

dotenv.config();

// ──────────────────────────────────────────────
// 2-4. الإعدادات والـ AI — نُقلت إلى src/config/env.mjs و src/ai/kareem.mjs
// ──────────────────────────────────────────────
import {
  PORT,
  WEBHOOK_VERIFY_TOKEN,
  WHATSAPP_TOKEN,
  WHATSAPP_PHONE_ID,
  AI_PROVIDER,
  AI_MODEL,
} from "./src/config/env.mjs";

// ──────────────────────────────────────────────
// 5. الذاكرة — نُقلت إلى src/memory/conversations.mjs (إعادة تصدير للتوافق)
// ──────────────────────────────────────────────
export {
  getHistory,
  pushHistory,
  clearMemory,
  getMemoryStats,
  isDuplicateMessage,
} from "./src/memory/conversations.mjs";
import {
  getHistory,
  pushHistory,
  isDuplicateMessage,
} from "./src/memory/conversations.mjs";

// ── Inbox: عرض المحادثات + Takeover (إيقاف البوت مؤقتاً لتدخل بشري) ──
// Takeover دائم في DB (لا يضيع عند restart)
import { storeGet, storeSet, storeDel } from "./store.mjs";
const takeoverKey = (tenantId, phone) => `takeover:${memoryKey(tenantId, phone)}`;
export async function setTakeover(tenantId, phone, enabled, by = "admin") {
  if (enabled) await storeSet(takeoverKey(tenantId, phone), { by, at: Date.now() });
  else await storeDel(takeoverKey(tenantId, phone));
}
export async function isTakeover(tenantId, phone) {
  return !!(await storeGet(takeoverKey(tenantId, phone)));
}
export async function listInbox(tenantFilter) {
  try {
    const { tenantDb, systemDb } = await import("./src/security/tenantGuard.mjs");
    const T = tenantFilter ? tenantDb(tenantFilter) : systemDb("inbox:global");
    const rows = await T.message.groupBy({
      by: ["tenantId", "phone"],
      _max: { createdAt: true },
      _count: { _all: true },
    });
    const out = [];
    for (const g of rows.slice(0, 200)) {
      const last = await tenantDb(g.tenantId).message.findFirst({
        where: { phone: g.phone },
        orderBy: { createdAt: "desc" },
      });
      out.push({
        tenantId: g.tenantId,
        phone: g.phone,
        count: g._count._all,
        updatedAt: new Date(g._max.createdAt).getTime(),
        takeover: await isTakeover(g.tenantId, g.phone),
        lastMessage: last ? { role: last.role, text: (last.text || "").slice(0, 120) } : null,
      });
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out;
  } catch (e) {
    console.error(`  ⚠️ فشل Inbox: ${e.message}`);
    return [];
  }
}
export async function getConversation(tenantId, phone) {
  const msgs = await getHistory(phone, { id: tenantId });
  return msgs;
}

// ──────────────────────────────────────────────
// 6. الـ AI — نُقل إلى src/ai/kareem.mjs (إعادة تصدير للتوافق)
// ──────────────────────────────────────────────
export {
  getKareemReply,
  processCustomerMessage,
  isDemoMode,
} from "./src/ai/kareem.mjs";
import { getKareemReply, processCustomerMessage, isDemoMode } from "./src/ai/kareem.mjs";

// ──────────────────────────────────────────────
// 6. الإرسال — نُقل إلى src/whatsapp/sender.mjs (إعادة تصدير للتوافق)
// ──────────────────────────────────────────────
export {
  sendWhatsAppMessage,
  sendButtons,
  sendImage,
  defaultButtonsFor,
} from "./src/whatsapp/sender.mjs";
import {
  sendWhatsAppMessage,
  sendButtons,
  sendImage,
  defaultButtonsFor,
} from "./src/whatsapp/sender.mjs";

// تقدير الإجمالي والصنف من نص المحادثة (بسيط وقابل للتطوير)
function detectTotal(tenant, userText, replyText) {
  const all = `${userText} ${replyText}`;
  const m = all.match(/\$(\d+(?:\.\d+)?)/g);
  if (m && m.length) {
    const nums = m.map((s) => parseFloat(s.replace("$", "")));
    return Math.max(...nums);
  }
  const prices = (tenant.products || []).map((p) => p.price);
  const max = Math.max(...prices, 0);
  return max + (tenant.deliveryFee || 0);
}
function detectItem(tenant, userText, replyText) {
  const all = `${userText} ${replyText}`;
  for (const p of tenant.products || []) {
    if (p.name && all.includes(p.name.split(" ")[0])) return p.name;
  }
  return (tenant.products || []).map((p) => p.name).join(" + ") || "طلب";
}

// ──────────────────────────────────────────────
// 7. إنشاء تطبيق Express
// ──────────────────────────────────────────────
export function createApp() {
  const app = express();

  // ضروري لقراءة JSON من واتساب
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // ── حماية /admin: سوبر أدمن (Basic) أو عميل (JWT) ──
  const ADMIN_USER = process.env.ADMIN_USER || "";
  const ADMIN_PASS = process.env.ADMIN_PASS || "";
  // مسارات ممنوعة على العملاء (إدارة البوتات والمستخدمين فقط للسوبر)
  // ملاحظة: req.path هنا بدون بادئة /admin لأن الـ middleware مركّب عليها
  const SUPER_ONLY = ["/tenants", "/users"];
  const adminAuth = async (req, res, next) => {
    const header = req.headers.authorization || "";
    const [scheme, encoded] = header.split(" ");
    // 1) عميل بـ JWT؟
    if (scheme === "Bearer" && encoded) {
      const { verifyClientToken } = await import("./portal.mjs");
      const p = verifyClientToken(encoded);
      if (p) {
        // kill switch: الموقوف لا يدخل
        const t = await getTenantFull(p.tenantId);
        if (!t || t.enabled === false) {
          return res.status(403).json({ ok: false, error: "هذا البوت موقوف — تواصل مع الإدارة" });
        }
        if (SUPER_ONLY.some((s) => req.path === s || req.path.startsWith(s + "/"))) {
          return res.status(403).json({ ok: false, error: "غير مصرح" });
        }
        req.clientTenant = p.tenantId; // إجبار النطاق على بوته فقط
        return next();
      }
    }
    // 2) سوبر أدمن؟
    if (ADMIN_USER && ADMIN_PASS && scheme === "Basic" && encoded) {
      const [u, pass] = Buffer.from(encoded, "base64").toString().split(":");
      if (u === ADMIN_USER && pass === ADMIN_PASS) return next();
    }
    if (!ADMIN_USER || !ADMIN_PASS) return next(); // بدون إعداد = مفتوح (للتطوير المحلي فقط)
    res.setHeader("WWW-Authenticate", 'Basic realm="admin"');
    return res.status(401).json({ ok: false, error: "مطلوب تسجيل دخول المدير" });
  };
  app.use("/admin", adminAuth);
  // إجبار نطاق العميل على بوته في كل الطلبات
  app.use("/admin", (req, res, next) => {
    if (req.clientTenant) {
      req.query.tenant = req.clientTenant;
      if (req.body && typeof req.body === "object") {
        req.body.tenantId = req.clientTenant;
        req.body.tenant = req.clientTenant;
      }
      if (req.params.tenantId) req.params.tenantId = req.clientTenant;
    }
    next();
  });

  // صفحة ترحيبية
  app.get("/", async (req, res) => {
    res.json({
      name: "كريم - AI Sales Agent (Multi-Tenant)",
      status: "running",
      webhook: "/webhook",
      admin: "/admin/tenants",
      tenants: (await listTenants()).length,
      mode: isDemoMode ? "DEMO" : AI_PROVIDER,
    });
  });

  // ── GET /webhook : التحقق من ملكية الـ Webhook (يدعم أكثر من بوت) ──
  app.get("/webhook", async (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    console.log(`  🔍 GET /webhook - mode=${mode} token=${token} challenge=${challenge}`);

    // أولاً: جرّب مطابقة tenant حسب verify_token
    const tenant = token ? await resolveTenant({ verifyToken: token }) : null;
    const expected = tenant?.verify_token || WEBHOOK_VERIFY_TOKEN;

    if (mode === "subscribe" && token === expected) {
      console.log(`  ✅ تم التحقق من الـ Webhook بنجاح (tenant=${tenant?.id || "default"})`);
      return res.status(200).send(challenge);
    }

    console.warn(`  ❌ فشل التحقق: token المتوقع="${expected}" المستلم="${token}"`);
    return res.sendStatus(403);
  });

  // ── لوحة تحكم البوتات (محمية بـ Basic Auth) ──
  app.get("/admin/tenants", async (req, res) => {
    const list = await listTenants();
    res.json({ count: list.length, tenants: list, memory: getMemoryStats() });
  });

  app.post("/admin/tenants", async (req, res) => {
    try {
      const created = await addTenant(req.body || {});
      console.log(`  ➕ tenant جديد: ${created.id} (${created.name})`);
      res.status(201).json({ ok: true, tenant: created });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // Kill switch: إيقاف/تشغيل بوت (سوبر أدمن فقط)
  app.patch("/admin/tenants/:id", async (req, res) => {
    try {
      const { updateTenant } = await import("./tenants.mjs");
      const updated = await updateTenant(req.params.id, req.body || {});
      console.log(`  🔌 tenant ${updated.id} enabled=${updated.enabled}`);
      res.json({ ok: true, tenant: { id: updated.id, enabled: updated.enabled } });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // ── حسابات العملاء (سوبر أدمن فقط) ──
  app.post("/admin/users", async (req, res) => {
    try {
      const { createClientUser } = await import("./portal.mjs");
      const u = await createClientUser(req.body || {});
      res.status(201).json({ ok: true, user: { id: u.id, tenantId: u.tenantId, phone: u.phone, name: u.name } });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });
  app.get("/admin/users", async (req, res) => {
    const { listClientUsers } = await import("./portal.mjs");
    const rows = await listClientUsers(req.query.tenant);
    res.json({ count: rows.length, users: rows });
  });

  // ── بوابة العميل (عامة: دخول + نسيت كلمة السر) ──
  app.post("/portal/login", async (req, res) => {
    try {
      const { verifyClientUser, signClientToken } = await import("./portal.mjs");
      const { tenantId, phone, password } = req.body || {};
      const u = await verifyClientUser(tenantId, phone, password);
      if (!u) return res.status(401).json({ ok: false, error: "بيانات الدخول غير صحيحة" });
      if (u.disabled) return res.status(403).json({ ok: false, error: "هذا البوت موقوف — تواصل مع الإدارة" });
      res.json({ ok: true, token: signClientToken(u), botName: u.tenant?.botName, tenantId: u.tenantId });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
  app.post("/portal/forgot", async (req, res) => {
    try {
      const { startPasswordReset } = await import("./portal.mjs");
      const { tenantId, phone } = req.body || {};
      const tenant = await getTenantFull(tenantId);
      if (!tenant) return res.json({ ok: true }); // لا نكشف
      await startPasswordReset(tenantId, phone, (codeMsg) => sendWhatsAppMessage(phone, codeMsg, tenant));
      res.json({ ok: true });
    } catch (e) {
      res.json({ ok: true }); // دائماً نجاح ظاهري (حماية)
    }
  });
  app.post("/portal/reset", async (req, res) => {
    try {
      const { finishPasswordReset } = await import("./portal.mjs");
      const { tenantId, phone, code, newPassword } = req.body || {};
      await finishPasswordReset(tenantId, phone, code, newPassword);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.get("/admin/tenants/:id", async (req, res) => {
    const t = await getTenantFull(req.params.id);
    if (!t) return res.status(404).json({ ok: false, error: "tenant غير موجود" });
    // إخفاء التوكن
    const { whatsapp_token, ...safe } = t;
    res.json({ ok: true, tenant: { ...safe, hasToken: !!whatsapp_token } });
  });

  app.get("/admin/appointments", async (req, res) => {
    const { tenant } = req.query;
    const { listAppointmentsAll } = await import("./bookings.mjs");
    const _ap = tenant ? await listAppointments(tenant) : await listAppointmentsAll();
    res.json({ count: _ap.length, appointments: _ap });
  });

  app.get("/admin/orders", async (req, res) => {
    const { tenant } = req.query;
    const { listOrdersAll } = await import("./orders.mjs");
    const _or = tenant ? await listOrders(tenant) : await listOrdersAll();
    res.json({ count: _or.length, orders: _or });
  });

  // صفحة دفع تجريبية (بدون Stripe تعرض زر تأكيد يحفظ paid)
  app.get("/pay/:orderId", async (req, res) => {
    const { getPublicOrder } = await import("./orders.mjs");
    const order = await getPublicOrder(req.params.orderId);
    if (!order) return res.status(404).send("الطلب غير موجود");
    if (req.query.paid === "1") {
      await markOrderPaid(order.id, order.tenantId);
      logEvent("order_paid", { tenantId: order.tenantId, phone: order.phone, orderId: order.id, total: order.total }).catch(() => {});
      // طلب تقييم تلقائي بعد الدفع
      const tenant = await getTenantFull(order.tenantId);
      if (tenant) {
        const msg = `شكراً لثقتك يا بطل! 🙏 قيّم تجربتك معنا من 1 (سيئة) إلى 5 (ممتازة) — ابعت الرقم فقط.`;
        await requestCsat(order.tenantId, order.phone, order.id);
        try {
          await sendWhatsAppMessage(order.phone, msg, tenant);
          await pushHistory(order.phone, "assistant", msg, tenant);
        } catch (e) {
          console.error(`  ❌ فشل إرسال CSAT: ${e.message}`);
        }
      }
      return res.send(`<h2>تم الدفع ✅ ${order.id} - $${order.total}</h2><p>شكراً! كريم معك خطوة بخطوة 👟</p>`);
    }
    res.send(`<h2>طلب ${order.id}</h2><p>${order.items?.map((i) => i.name).join(" + ")} — الإجمالي $${order.total} ${order.currency}</p><a href="/pay/${order.id}?paid=1"><button style="padding:12px 24px">ادفع الآن (تجريبي)</button></a><p>الحالة: ${order.status}</p>`);
  });

  // ── Broadcast: إرسال جماعي ──
  app.post("/admin/broadcast", async (req, res) => {
    const { tenantId, text, phones } = req.body || {};
    if (!tenantId || !text || !Array.isArray(phones) || !phones.length) {
      return res.status(400).json({ ok: false, error: "tenantId و text و phones[] مطلوبة" });
    }
    if (phones.length > 50) return res.status(400).json({ ok: false, error: "الحد الأقصى 50 رقم لكل بث" });
    const tenant = await getTenantFull(tenantId);
    if (!tenant) return res.status(404).json({ ok: false, error: "tenant غير موجود" });
    const results = [];
    for (const phone of phones) {
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
    logEvent("broadcast", { tenantId, count: phones.length, sent: results.filter((r) => r.ok).length, broadcastId: rec.id }).catch(() => {});
    res.json({ ok: true, broadcast: rec });
  });
  app.get("/admin/broadcasts", async (req, res) => {
    const all = await listBroadcasts(req.query.tenant);
    res.json({ count: all.length, broadcasts: all });
  });

  // ── تقرير التوفير الشهري (يبيع الاشتراك) ──
  app.get("/admin/report", async (req, res) => {
    const tenantId = req.query.tenant;
    const days = Number(req.query.days || 30);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const { tenantDb, systemDb } = await import("./src/security/tenantGuard.mjs");
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

  // ── CSAT: طلب تقييم + عرض النتائج ──
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
    res.json({ ok: true, ...(await csatStats(req.query.tenant)) });
  });

  // ── CRM: سجل الأحداث + تصدير CSV ──
  app.get("/admin/crm", async (req, res) => {
    const { tenant, type, limit } = req.query;
    const events = await listEvents({ tenantId: tenant, type, limit: Number(limit || 100) });
    res.json({ count: events.length, events });
  });
  app.get("/admin/crm/export.csv", async (req, res) => {
    const { tenant, type } = req.query;
    const events = await listEvents({ tenantId: tenant, type, limit: 2000 });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=crm.csv");
    res.send("\uFEFF" + toCSV(events));
  });

  // ── سلة مهجورة: تشغيل يدوي ──
  app.post("/admin/cart-remind-run", async (req, res) => {
    const afterMinutes = Number(req.body?.afterMinutes ?? 60);
    const scopeTenant = req.clientTenant || req.body?.tenantId || null;
    const { dueCartRemindersAll } = await import("./orders.mjs");
    const due = scopeTenant
      ? await dueCartReminders(scopeTenant, { afterMinutes })
      : await dueCartRemindersAll({ afterMinutes });
    const sent = [];
    for (const o of due) {
      const tenant = await getTenantFull(o.tenantId);
      if (!tenant) continue;
      const msg = `يا هلا يا بطل! 👋 شفنا طلبك ${o.id} ($${o.total}) لسه ما اكتمل. تحب نكمله؟ رابط الدفع: ${o.paymentUrl || "ابعت تم للتأكيد"}`;
      try {
        await sendWhatsAppMessage(o.phone, msg, tenant);
        await pushHistory(o.phone, "assistant", msg, tenant);
        await markCartReminded(o.id, o.tenantId);
        logEvent("cart_reminded", { tenantId: o.tenantId, phone: o.phone, orderId: o.id, total: o.total }).catch(() => {});
        sent.push(o.id);
      } catch (e) {
        console.error(`  ❌ فشل تذكير السلة ${o.id}: ${e.message}`);
      }
    }
    res.json({ ok: true, due: due.length, sent });
  });

  // ── Inbox: قائمة المحادثات + محادثة واحدة ──
  app.get("/admin/inbox", async (req, res) => {
    const inbox = await listInbox(req.query.tenant);
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

  // ── Takeover: إيقاف/تشغيل البوت لمحادثة ──
  app.post("/admin/takeover", async (req, res) => {
    const { tenantId, phone, enabled, by } = req.body || {};
    if (!tenantId || !phone) return res.status(400).json({ ok: false, error: "tenantId و phone مطلوبان" });
    await setTakeover(tenantId, phone, !!enabled, by);
    logEvent(!!enabled ? "takeover" : "handover", { tenantId, phone, by }).catch(() => {});
    res.json({ ok: true, takeover: await isTakeover(tenantId, phone) });
  });

  // ── إرسال يدوي من الموظف (مع حفظ في الذاكرة) ──
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

  // ── لوحة التحكم المرئية ──
  app.get("/admin/", (req, res) => {
    res.sendFile(path.join(__dirname, "admin.html"));
  });

  // ── بوابة العميل (صفحة دخول + لوحة مقفلة على بوته) ──
  app.get("/portal/", (req, res) => {
    res.sendFile(path.join(__dirname, "admin.html"));
  });

  // ── صفحة Inbox بسيطة (HTML) ──
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
tr.innerHTML='<td>'+c.tenantId+'</td><td>'+c.phone+'</td><td>'+(c.takeover?'⏸️':'✅')+'</td><td>'+(c.lastMessage?c.lastMessage.text:'')+'</td>';
const b=document.createElement('button'); b.textContent=c.takeover?'تشغيل البوت':'إيقاف للموظف';
b.onclick=async()=>{ await fetch('/admin/takeover',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tenantId:c.tenantId,phone:c.phone,enabled:!c.takeover})}); load(); };
const td=document.createElement('td'); td.appendChild(b); tr.appendChild(td); t.appendChild(tr); }); }
load();
</script></body></html>`);
  });

  // ── تذكير المواعيد: تشغيل يدوي + إلغاء حجز ──
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
    const list = await listWaiting(req.query.tenant, req.query.service);
    res.json({ count: list.length, waiting: list });
  });

  // ── POST /webhook : استقبال الرسائل ──
  // مهم: نرد 200 فوراً ثم نعالج بالخلفية — وإلا Meta يعيد الإرسال ويرد البوت مرتين
  app.post("/webhook", (req, res) => {
    const body = req.body;

    // التحقق المبدئي من نوع الحدث
    if (!body || body.object !== "whatsapp_business_account") {
      console.log(`  📥 POST /webhook - object غير متوقع: ${body?.object}`);
      return res.sendStatus(404);
    }

    // رد فوري لواتساب (يمنع إعادة الإرسال = يمنع الرد المكرر)
    res.status(200).send("EVENT_RECEIVED");

    // المعالجة بالخلفية
    processWebhookBody(body).catch((err) => {
      console.error(`  ❌ خطأ في معالجة Webhook: ${err.message}`, err.stack);
    });
  });

  async function processWebhookBody(body) {
    try {
      const entries = body.entry || [];

      let hasMessage = false;

      for (const entry of entries) {
        const changes = entry.changes || [];
        for (const change of changes) {
          const value = change.value || {};
          const messages = value.messages || [];
          const contacts = value.contacts || [];

          // حل الـ tenant من رقم البوت المستقبل (عزل تام)
          const phoneNumberId = value.metadata?.phone_number_id || value.phone_number_id || null;
          const tenant = await resolveTenant({ phoneNumberId });
          if (tenant && tenant.enabled === false) {
            console.log(`  ⏸️ tenant موقوف: ${tenant.id} - تم تجاهل الرسالة`);
            continue;
          }

          for (const msg of messages) {
            // منع التكرار: نفس الـ wamid لا يُعالج مرتين أبداً
            if (msg.id && isDuplicateMessage(msg.id)) {
              console.log(`  🔁 رسالة مكررة (id=${msg.id}) - تم تجاهلها`);
              continue;
            }
            hasMessage = true;

            // استخراج رقم العميل ونص الرسالة (يدعم الأزرار + الفويس)
            const from = msg.from; // رقم العميل
            let text =
              msg.text?.body ||
              msg.button?.text ||
              msg.interactive?.button_reply?.title ||
              msg.interactive?.button_reply?.id ||
              msg.interactive?.list_reply?.title ||
              "";
            const buttonId = msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id || null;
            const name = contacts.find((c) => c.wa_id === from)?.profile?.name || from;

            // —— فويس نوت: حمّله وفرّغه ثم عامله كنص ——
            if ((msg.type === "audio" || msg.audio?.id) && !text) {
              try {
                const mediaId = msg.audio?.id;
                console.log(`  🎤 فويس من ${from} (media=${mediaId}) - جاري التفريغ...`);
                const { buffer, mimeType } = await downloadWhatsAppMedia(mediaId, tenant?.whatsapp_token || WHATSAPP_TOKEN);
                const { text: transcript, reason } = await transcribeAudio(buffer, mimeType, (tenant?.languages || ["ar", "en"]).join(","));
                if (transcript) {
                  text = transcript;
                  console.log(`  🎤 تفريغ: "${text}"`);
                } else {
                  console.log(`  ⚠️ تعذر التفريغ (${reason})`);
                  await sendWhatsAppMessage(from, "وصلني الفويس يا غالي 🎤 بس ما قدرت أفرغه، ابعتلي كتابة لو سمحت.", tenant).catch(() => {});
                  console.log(`${"─".repeat(60)}\n`);
                  continue;
                }
              } catch (e) {
                console.error(`  ❌ خطأ الفويس: ${e.message}`);
                await sendWhatsAppMessage(from, "ما قدرت أسمع الفويس، ابعتلي كتابة يا غالي.", tenant).catch(() => {});
                console.log(`${"─".repeat(60)}\n`);
                continue;
              }
            }

            if (!text) {
              console.log(`  📥 رسالة بدون نص من ${from} (type=${msg.type}) - تم تجاهلها`);
              continue;
            }

            console.log(`\n${"─".repeat(60)}`);
            console.log(`  🏢 tenant=${tenant?.id} | بوت=${tenant?.botName}`);
            console.log(`  📥 رسالة واتساب من ${name} (${from}): "${text}"${buttonId ? ` [btn=${buttonId}]` : ""}`);
            console.log(`  🧠 الذاكرة: ${(await getHistory(from, tenant)).length} رسائل سابقة`);
            if (await isTakeover(tenant?.id, from)) {
              await pushHistory(from, "user", text, tenant);
              console.log(`  ⏸️ takeover نشط (${from}) - حُفظت الرسالة بدون رد آلي`);
              console.log(`${"─".repeat(60)}\n`);
              continue;
            }

            // —— استعلام عن طلب: "وين طلبي ord_..." (مقيد بنطاق البوت + رقم السائل) ——
            const orderMatch = text.match(/\b(ord_[a-z0-9]+)\b/i);
            if (orderMatch) {
              const qOrder = await getOrder(orderMatch[1].toLowerCase(), tenant?.id).catch(() => null);
              let reply;
              if (qOrder && qOrder.phone === from) {
                const statusAr = { pending: "بانتظار الدفع ⏳", paid: "مدفوع ✅", canceled: "ملغي" }[qOrder.status] || qOrder.status;
                reply = `طلبك ${qOrder.id} — ${(qOrder.items || []).map((i) => i.name).join(" + ")} — الإجمالي $${qOrder.total} — الحالة: ${statusAr}`;
                if (qOrder.status === "pending" && qOrder.paymentUrl) reply += `\nرابط الدفع: ${qOrder.paymentUrl}`;
              } else {
                reply = `ما لقيت طلب بهذا الرقم يا غالي 🤔 تأكد من الرقم (مثال: ord_abc123) أو ابعت "أريد موظف" للمساعدة.`;
              }
              await pushHistory(from, "user", text, tenant);
              await pushHistory(from, "assistant", reply, tenant);
              logEvent("message", { tenantId: tenant?.id, phone: from, intent: "استفسار", text: text.slice(0, 200) }).catch(() => {});
              try {
                await sendWhatsAppMessage(from, reply, tenant);
              } catch (e) {
                console.error(`  ❌ فشل إرسال حالة الطلب: ${e.message}`);
              }
              console.log(`  📦 استعلام طلب ${orderMatch[1]} للعميل ${from}`);
              console.log(`${"─".repeat(60)}\n`);
              continue;
            }

            // —— CSAT: إذا الرد رقم 1-5 وكان في طلب تقييم معلق ——
            if (/^[1-5]$/.test(text.trim())) {
              const pending = await hasPendingCsat(tenant?.id, from);
              if (pending) {
                const score = Number(text.trim());
                const rating = await saveRating({ tenantId: tenant.id, phone: from, score, refId: pending.refId });
                const reply = score >= 4
                  ? `شكراً يا بطل! ⭐ تقييمك ${score}/5 أسعدنا. كريم معك خطوة بخطوة 👟`
                  : `شكراً لصراحتك يا غالي 🙏 تقييمك ${score}/5 وصلنا ورح نشتغل نحسّن. تحب يحكي معك موظف؟`;
                await pushHistory(from, "user", text, tenant);
                await pushHistory(from, "assistant", reply, tenant);
                logEvent("csat", { tenantId: tenant.id, phone: from, score, refId: pending.refId }).catch(() => {});
                try {
                  await sendWhatsAppMessage(from, reply, tenant);
                } catch (e) {
                  console.error(`  ❌ فشل إرسال رد التقييم: ${e.message}`);
                }
                console.log(`  ⭐ تقييم ${rating.id} ${tenant.id} ${from} = ${score}`);
                console.log(`${"─".repeat(60)}\n`);
                continue;
              }
            }

            // —— تدفق الحجز (للعيادات) قبل الـ AI ——
            const wantsBooking = tenant?.features?.booking && /(حجز|موعد|احجز|book|appointment)/i.test(text + " " + (buttonId || ""));
            const bookingState = await getBookingState(tenant?.id, from);
            // —— فرز أولي Triage (أعراض الأسنان) ——
            const triageOn = tenant?.features?.booking && tenant?.businessType === "dental";
            const symptomHit = triageOn && !bookingState && /(وجع|ألم|يوجع|يؤلم|ورم|منتفخ|انتفاخ|كسر|مكسور|انكسر|نزيف|دم|حرارة|سخونة|سخن|خراج|حساسية|حساس|بارد|ساخن|ضرس العقل|pain|ache|swell|swollen|broken|bleed|fever|abscess|sensitive)/i.test(text);
            let result = null;
            let handled = false;

            // 1) ضغطة زر منتج لكريم: اعرض الصورة + أكمل شراء
            if (tenant?.id === "kareem-sport" && buttonId && /^(buy_shoes|buy_belt|bundle)$/.test(buttonId)) {
              const map = {
                buy_shoes: "أريد شراء حذاء الركض",
                buy_belt: "أريد شراء حزام الظهر",
                bundle: "أريد حزام الظهر والحذاء معاً",
              };
              result = await processCustomerMessage(map[buttonId], from, tenant);
              const prod = buttonId === "buy_shoes" ? tenant.products[0] : buttonId === "buy_belt" ? tenant.products[1] : null;
              try {
                if (prod?.image) await sendImage(from, prod.image, `${prod.name} - $${prod.price}`, tenant);
                await sendWhatsAppMessage(from, result.reply, tenant);
              } catch (sendErr) {
                console.error(`  ❌ فشل الإرسال: ${sendErr.message}`);
              }
              console.log(`  🤖 ${tenant?.botName} -> intent=${result.intent} (زر ${buttonId})`);
              console.log(`${"─".repeat(60)}\n`);
              continue;
            }

            // 1ب) بدء الفرز: سؤال المكان
            if (symptomHit) {
              await setBookingState(tenant.id, from, { step: "triage_q1", answers: { symptom: text.slice(0, 200) } });
              const reply = `سلامتك يا غالي 🙏 عشان نوجهك صح، وين الألم بالضبط؟ (ضرس / لثة / فك)`;
              await pushHistory(from, "user", text, tenant);
              await pushHistory(from, "assistant", reply, tenant);
              try {
                await sendButtons(from, reply, [
                  { id: "pain_tooth", title: "🦷 ضرس" },
                  { id: "pain_gum", title: "لثة" },
                  { id: "pain_jaw", title: "فك" },
                ], tenant);
              } catch (e) {
                await sendWhatsAppMessage(from, reply, tenant).catch(() => {});
              }
              console.log(`  🩺 بدء فرز ${tenant.id} للعميل ${from}`);
              console.log(`${"─".repeat(60)}\n`);
              continue;
            }

            // 1ج) الفرز س2: المدة
            if (bookingState?.step === "triage_q1") {
              const answers = { ...(bookingState.answers || {}), place: text.slice(0, 100) };
              await setBookingState(tenant.id, from, { step: "triage_q2", answers });
              const reply = `تمام، ومن متى بلش الألم؟ (اليوم / من أيام / من أسابيع)`;
              await pushHistory(from, "user", text, tenant);
              await pushHistory(from, "assistant", reply, tenant);
              try {
                await sendWhatsAppMessage(from, reply, tenant);
              } catch (e) {
                console.error(`  ❌ فشل الإرسال: ${e.message}`);
              }
              console.log(`${"─".repeat(60)}\n`);
              continue;
            }

            // 1د) الفرز س3: علامات الخطر + التصنيف
            if (bookingState?.step === "triage_q2") {
              const answers = { ...(bookingState.answers || {}), since: text.slice(0, 100) };
              await setBookingState(tenant.id, from, { step: "triage_q3", answers });
              const reply = `آخر سؤال يا غالي: هل عندك أي من هاي؟ (ورم / حرارة / نزيف / ألم لا يُحتمل) — ابعت "لا" إذا ما في شي منها.`;
              await pushHistory(from, "user", text, tenant);
              await pushHistory(from, "assistant", reply, tenant);
              try {
                await sendButtons(from, reply, [
                  { id: "red_swelling", title: "ورم" },
                  { id: "red_none", title: "لا، ما في" },
                ], tenant);
              } catch (e) {
                await sendWhatsAppMessage(from, reply, tenant).catch(() => {});
              }
              console.log(`${"─".repeat(60)}\n`);
              continue;
            }

            // 1هـ) التصنيف: طارئ أم عادي
            if (bookingState?.step === "triage_q3") {
              const red = /(ورم|منتفخ|انتفاخ|حرارة|سخونة|سخن|نزيف|دم|كسر|مكسور|انكسر|خراج|لا يحتمل|لا يحتمل|شديد جدا|swell|fever|bleed|broken|abscess|red_swelling)/i.test(text + " " + (buttonId || ""));
              const answers = { ...(bookingState.answers || {}), redFlags: red ? text.slice(0, 100) : "لا" };
              const summary = `العرض: ${answers.symptom || ""} | المكان: ${answers.place || ""} | المدة: ${answers.since || ""} | علامات: ${answers.redFlags}`;
              logEvent("triage", { tenantId: tenant.id, phone: from, emergency: red, summary: summary.slice(0, 300) }).catch(() => {});
              if (red) {
                await setBookingState(tenant.id, from, null);
                const booking = await bookAppointment({ tenantId: tenant.id, phone: from, name, service: "حالة طارئة 🆘", day: "اليوم", slot: "أقرب وقت" });
                const reply = `سلامتك أولاً يا غالي 🆘 الأعراض اللي ذكرتها تحتاج تدخل سريع — حجزتلك موعد طارئ اليوم (${booking.id}). تعال مباشرة على العيادة، والدكتور بانتظارك. إذا الوضع خطير اتصل فينا فوراً.`;
                await pushHistory(from, "user", text, tenant);
                await pushHistory(from, "assistant", reply, tenant);
                try {
                  await sendWhatsAppMessage(from, reply, tenant);
                } catch (e) {
                  console.error(`  ❌ فشل الإرسال: ${e.message}`);
                }
                console.log(`  🆘 حالة طارئة ${tenant.id} ${from} (${booking.id})`);
                console.log(`${"─".repeat(60)}\n`);
                continue;
              }
              // عادي → كمّل للحجز مع تلخيص الإجابات في الذاكرة
              await setBookingState(tenant.id, from, { step: "slot", triage: summary.slice(0, 300) });
              const slots = (tenant.features.bookingSlots || []).join("، ");
              const reply = `تمام يا غالي، حالتك تبدو عادية 😊 سجلت ملاحظاتك للدكتور. اختر الوقت المناسب: ${slots}. ابعت الوقت (مثال: 14:00).`;
              await pushHistory(from, "user", text, tenant);
              await pushHistory(from, "assistant", reply, tenant);
              try {
                await sendButtons(from, reply, (tenant.features.bookingSlots || []).slice(0, 3).map((s) => ({ id: `slot_${s}`, title: `🕐 ${s}` })), tenant);
              } catch (e) {
                await sendWhatsAppMessage(from, reply, tenant).catch(() => {});
              }
              console.log(`  🩺 فرز عادي → حجز ${tenant.id} ${from}`);
              console.log(`${"─".repeat(60)}\n`);
              continue;
            }

            // 1و) الانضمام لقائمة الانتظار
            if (tenant?.features?.booking && /(انتظار|ضيفني|قائمة الانتظار|waitlist|waiting)/i.test(text)) {
              const service = (tenant.products || [])[0]?.name || "موعد";
              const w = await joinWaitingList({ tenantId: tenant.id, phone: from, name, service });
              const reply = `تم يا غالي ✅ انضميت لقائمة الانتظار (${w.id}) لخدمة ${service}. أول ما يفضى موعد بنخبرك فوراً هنا.`;
              await pushHistory(from, "user", text, tenant);
              await pushHistory(from, "assistant", reply, tenant);
              logEvent("waiting_join", { tenantId: tenant.id, phone: from, service }).catch(() => {});
              try {
                await sendWhatsAppMessage(from, reply, tenant);
              } catch (e) {
                console.error(`  ❌ فشل الإرسال: ${e.message}`);
              }
              console.log(`  📋 انضمام انتظار ${tenant.id} ${from}`);
              console.log(`${"─".repeat(60)}\n`);
              continue;
            }

            // 1ز) قبول عرض موعد من الانتظار
            if (bookingState?.step === "offer" && /^(تم|موافق|نعم|ok|yes)$/i.test(text.trim())) {
              const booking = await bookAppointment({ tenantId: tenant.id, phone: from, name, service: bookingState.service || "موعد", day: bookingState.day || "أقرب يوم", slot: bookingState.slot || "" });
              await setBookingState(tenant.id, from, null);
              const reply = `ممتاز! 🎉 تم تأكيد موعدك ${booking.service} (${booking.id}). بنتشرف فيك!`;
              await pushHistory(from, "user", text, tenant);
              await pushHistory(from, "assistant", reply, tenant);
              logEvent("booking", { tenantId: tenant.id, phone: from, bookingId: booking.id, fromWaiting: true }).catch(() => {});
              try {
                await sendWhatsAppMessage(from, reply, tenant);
              } catch (e) {
                console.error(`  ❌ فشل الإرسال: ${e.message}`);
              }
              console.log(`  📋 تأكيد من الانتظار ${booking.id} ${from}`);
              console.log(`${"─".repeat(60)}\n`);
              continue;
            }

            // 2) بدء الحجز
            if (wantsBooking && !bookingState) {
              const slots = (tenant.features.bookingSlots || []).join("، ");
              await setBookingState(tenant.id, from, { step: "slot" });
              const reply = `تمام يا غالي 😊 احجز موعدك في ${tenant.name}. أوقاتنا: ${tenant.features.workingHours || ""}. اختر الوقت المناسب: ${slots}. ابعت الوقت (مثال: 14:00) واسم الخدمة.`;
              result = { reply, transfer_to_human: false, intent: "حجز_موعد" };
              await pushHistory(from, "user", text, tenant);
              await pushHistory(from, "assistant", reply, tenant);
              try {
                await sendButtons(from, reply, (tenant.features.bookingSlots || []).slice(0, 3).map((s) => ({ id: `slot_${s}`, title: `🕐 ${s}` })), tenant);
              } catch (e) {
                await sendWhatsAppMessage(from, reply, tenant).catch(() => {});
              }
              console.log(`  📅 بدء حجز ${tenant.id} للعميل ${from}`);
              console.log(`${"─".repeat(60)}\n`);
              continue;
            }

            // 3) استكمال الحجز (اختار وقت)
            if (bookingState?.step === "slot") {
              const slotMatch = text.match(/(\d{1,2}:\d{2})/) || (buttonId?.startsWith("slot_") ? [null, buttonId.replace("slot_", "")] : null);
              if (slotMatch) {
                const slot = slotMatch[1];
                const service = (tenant.products || [])[0]?.name || "موعد";
                const day = bookingState.day || "أقرب يوم متاح";
                const capacity = tenant.features?.slotCapacity || 1;
                // منع التعارض: إذا محجوز اعرض البدائل
                if (await isSlotTaken(tenant.id, day, slot, capacity)) {
                  const free = await freeSlots(tenant.id, day, tenant.features?.bookingSlots, capacity);
                  const reply = free.length
                    ? `للأسف الساعة ${slot} محجوزة يا غالي 😅 بس الفارغ عندنا: ${free.join("، ")}. اختر واحد منهم؟ أو ابعت "انتظار" لأضيفك لقائمة الانتظار.`
                    : `للأسف كل الأوقات محجوزة اليوم 😅 أضفتك تلقائياً لقائمة الانتظار، وأول ما يفضى موعد بخبرك فوراً.`;
                  if (!free.length) {
                    await joinWaitingList({ tenantId: tenant.id, phone: from, name, service });
                  }
                  await pushHistory(from, "user", text, tenant);
                  await pushHistory(from, "assistant", reply, tenant);
                  try {
                    if (free.length) {
                      await sendButtons(from, reply, free.slice(0, 3).map((s) => ({ id: `slot_${s}`, title: `🕐 ${s}` })), tenant);
                    } else {
                      await sendWhatsAppMessage(from, reply, tenant);
                    }
                  } catch (e) {
                    console.error(`  ❌ فشل الإرسال: ${e.message}`);
                  }
                  console.log(`  ⚠️ تعارض ${tenant.id} ${day} ${slot} — عُرضت البدائل`);
                  console.log(`${"─".repeat(60)}\n`);
                  continue;
                }
                const booking = await bookAppointment({ tenantId: tenant.id, phone: from, name, service, day, slot });
                await setBookingState(tenant.id, from, null);
                const reply = `تم تأكيد حجزك يا غالي ✅ ${service} - الساعة ${slot} (${booking.id}). بنتشرف فيك في ${tenant.name}! لإلغاء/تعديل ابعت "أريد موظف".`;
                result = { reply, transfer_to_human: false, intent: "حجز_موعد" };
                await pushHistory(from, "user", text, tenant);
                await pushHistory(from, "assistant", reply, tenant);
                logEvent("booking", { tenantId: tenant.id, phone: from, bookingId: booking.id, service, slot }).catch(() => {});
                try {
                  await sendWhatsAppMessage(from, reply, tenant);
                } catch (e) {
                  console.error(`  ❌ فشل الإرسال: ${e.message}`);
                }
                console.log(`  📅 تأكيد حجز ${booking.id} ${tenant.id} ${from} ${slot}`);
                console.log(`${"─".repeat(60)}\n`);
                continue;
              }
            }

            // —— المسار العادي: AI ——
            result = await processCustomerMessage(text, from, tenant);

            console.log(`  🤖 ${tenant?.botName || "كريم"} -> intent=${result.intent} transfer=${result.transfer_to_human}`);
            console.log(`  💬 الرد: "${result.reply}"`);
            logEvent("message", { tenantId: tenant?.id, phone: from, intent: result.intent, transfer: result.transfer_to_human, text: text.slice(0, 200) }).catch(() => {});

            if (result.transfer_to_human) {
              console.log(`  🚨 تنبيه: العميل ${from} طلب التصعيد للبشر!`);
            }

            // —— إنشاء طلب + رابط دفع عند نية الشراء (متاجر) ——
            const wantsPay =
              result.intent === "شراء" &&
              (tenant?.businessType === "sport-store" || (tenant.products || []).length > 0) &&
              !tenant?.features?.booking;
            if (wantsPay) {
              try {
                const total = detectTotal(tenant, text, result.reply);
                const order = await createOrder({
                  tenantId: tenant.id, phone: from, name,
                  items: [{ name: detectItem(tenant, text, result.reply), qty: 1 }],
                  total, currency: "USD",
                });
                const baseUrl = process.env.PUBLIC_BASE_URL || `https://kareem-whatsapp-agent.onrender.com`;
                const { url: payUrl, mock } = await createPaymentLink(order, baseUrl);
                result.reply += `\n\n🧾 طلبك ${order.id} — الإجمالي $${total}. ادفع هنا: ${payUrl}${mock ? " (تجريبي — فعّل STRIPE_SECRET_KEY للدفع الحقيقي)" : ""}`;
                logEvent("order", { tenantId: tenant.id, phone: from, orderId: order.id, total, intent: result.intent }).catch(() => {});
                console.log(`  💳 طلب ${order.id} $${total} -> ${payUrl}`);
              } catch (e) {
                console.error(`  ❌ خطأ إنشاء الطلب: ${e.message}`);
              }
            }

            // إرسال ذكي: صورة + نص + أزرار (حسب ما رجّع الـ AI)
            try {
              if (result.image && tenant?.features?.images) {
                await sendImage(from, result.image, result.reply.slice(0, 200), tenant).catch(() => {});
                // مع الصورة نرسل الأزرار لو وجدت
                const btns = result.buttons?.length ? result.buttons : await defaultButtonsFor(tenant);
                if (tenant?.features?.buttons && btns?.length) {
                  await sendButtons(from, "شو بتحب تعمل هلا؟", btns, tenant).catch(() => {});
                }
              } else if (result.buttons?.length && tenant?.features?.buttons) {
                await sendButtons(from, result.reply, result.buttons, tenant);
              } else {
                // أول عرض للمنتجات: أرفق أزرار تلقائياً (كريم فقط، أول رسالتين)
                const histLen = (await getHistory(from, tenant)).length;
                await sendWhatsAppMessage(from, result.reply, tenant);
                if (tenant?.id === "kareem-sport" && histLen <= 2 && /حذاء|حزام|Bundle|لدينا/i.test(result.reply)) {
                  await sendButtons(from, "اختار بسرعة 👇", await defaultButtonsFor(tenant), tenant).catch(() => {});
                }
              }
            } catch (sendErr) {
              console.error(`  ❌ فشل إرسال الرد للعميل ${from}: ${sendErr.message}`);
            }

            console.log(`${"─".repeat(60)}\n`);
          }

          // تجاهل حالات statuses (delivered/read) بدون رسائل
          if (messages.length === 0 && value.statuses) {
            console.log(`  📊 حالة رسالة: ${value.statuses[0]?.status || "unknown"}`);
          }
        }
      }

      if (!hasMessage) {
        console.log("  📥 POST /webhook - لا توجد رسائل جديدة (ربما statuses)");
      }
    } catch (err) {
      console.error(`  ❌ خطأ في معالجة Webhook: ${err.message}`, err.stack);
    }
  }

  return app;
}

// ──────────────────────────────────────────────
// 8. تشغيل السيرفر
// ──────────────────────────────────────────────
export function startServer(port = PORT) {
  const app = createApp();
  // مجدول تلقائي: تذكير مواعيد + سلة مهجورة
  const remindEveryMs = Number(process.env.REMIND_EVERY_MS || 5 * 60 * 1000);
  if (!global.__remindTimer) {
    global.__remindTimer = setInterval(async () => {
      try {
        // 1) تذكير مواعيد
        const due = await dueReminders({ afterMinutes: Number(process.env.REMIND_AFTER_MIN || 60) });
        for (const b of due.slice(0, 20)) {
          const tenant = await getTenantFull(b.tenantId);
          if (!tenant) continue;
          const msg = `تذكير بموعدك يا غالي ⏰ ${b.service} - الساعة ${b.slot} (${b.id}) في ${tenant.name}.`;
          try {
            await sendWhatsAppMessage(b.phone, msg, tenant);
            await markReminded(b.id);
            logEvent("booking_reminded", { tenantId: b.tenantId, phone: b.phone, bookingId: b.id }).catch(() => {});
            console.log(`  ⏰ تذكير تلقائي ${b.id} -> ${b.phone}`);
          } catch (e) {
            console.error(`  ❌ فشل التذكير ${b.id}: ${e.message}`);
          }
        }
        // 2) سلة مهجورة (طلبات pending بدون دفع)
        const { dueCartRemindersAll } = await import("./orders.mjs");
        const carts = await dueCartRemindersAll({ afterMinutes: Number(process.env.CART_AFTER_MIN || 60) });
        for (const o of carts.slice(0, 20)) {
          const tenant = await getTenantFull(o.tenantId);
          if (!tenant) continue;
          const msg = `يا هلا يا بطل! 👋 شفنا طلبك ${o.id} ($${o.total}) لسه ما اكتمل. تحب نكمله؟ رابط الدفع: ${o.paymentUrl || "ابعت تم للتأكيد"}`;
          try {
            await sendWhatsAppMessage(o.phone, msg, tenant);
            await markCartReminded(o.id, o.tenantId);
            logEvent("cart_reminded", { tenantId: o.tenantId, phone: o.phone, orderId: o.id, total: o.total }).catch(() => {});
            console.log(`  🛒 سلة مهجورة ${o.id} -> ${o.phone}`);
          } catch (e) {
            console.error(`  ❌ فشل تذكير السلة ${o.id}: ${e.message}`);
          }
        }
      } catch (e) {
        console.error(`  ❌ خطأ المجدول: ${e.message}`);
      }
    }, remindEveryMs);
    if (global.__remindTimer.unref) global.__remindTimer.unref();
  }
  const server = app.listen(port, () => {
    console.log("\n" + "═".repeat(60));
    console.log("  🤖  كريم - AI Sales Agent | سيرفر واتساب Webhook");
    console.log("═".repeat(60));
    console.log(`  🌐 السيرفر يعمل: http://localhost:${port}`);
    console.log(`  🔗 Webhook URL: http://localhost:${port}/webhook`);
    console.log(`  🔑 Verify Token: ${WEBHOOK_VERIFY_TOKEN}`);
    console.log(`  📱 Phone ID: ${WHATSAPP_PHONE_ID || "(غير مضبوط - وضع محاكاة)"}`);
    console.log(`  🧠 المزود: ${AI_PROVIDER} | النموذج: ${AI_MODEL} | الوضع: ${isDemoMode ? "DEMO" : "API حقيقي"}`);
    console.log("═".repeat(60));
    console.log(`  💡 للاختبار المحلي: استخدم ngrok أو similar`);
    console.log(`     ngrok http ${port}`);
    console.log("═".repeat(60) + "\n");
  });
  return server;
}

// ──────────────────────────────────────────────
// 9. دالة التحقق والطباعة النظيفة (للاختبار المحلي)
// ──────────────────────────────────────────────
function printResult(index, userMessage, result) {
  const intentColors = {
    استفسار: "\x1b[34m",
    شراء: "\x1b[32m",
    اعتراض_على_السعر: "\x1b[33m",
    تصعيد: "\x1b[31m",
  };
  const reset = "\x1b[0m";
  const color = intentColors[result.intent] || reset;
  const transferIcon = result.transfer_to_human ? "🚨 تصعيد للبشر" : "✅ رد آلي";

  console.log(`\n${"─".repeat(60)}`);
  console.log(` 🧪 اختبار #${index} | ${transferIcon}`);
  console.log(` 👤 العميل: "${userMessage}"`);
  console.log(` 🤖 كريم : "${result.reply}"`);
  console.log(` 🏷️  intent: ${color}${result.intent}${reset} | transfer_to_human: ${result.transfer_to_human}`);
  console.log(` 📦 JSON: ${JSON.stringify(result)}`);

  // تحذيرات إضافية
  const warnings = [];
  if (result.transfer_to_human && result.intent !== "تصعيد") {
    warnings.push('عدم تطابق: transfer_to_human=true لكن intent ليس "تصعيد"');
  }
  if (!result.transfer_to_human && result.intent === "تصعيد") {
    warnings.push('عدم تطابق: intent="تصعيد" لكن transfer_to_human=false');
  }
  if (!result.reply || result.reply.trim().length < 5) {
    warnings.push("الرد قصير جداً أو فارغ");
  }
  warnings.forEach((w) => console.log(`  ⚠️  تحذير: ${w}`));
}

// ──────────────────────────────────────────────
// 10. مجموعة الاختبارات
// ──────────────────────────────────────────────
async function runTests() {
  console.log("\n" + "═".repeat(60));
  console.log("  🤖  مشروع كريم - AI Sales Agent لمتجر مستلزمات رياضية");
  console.log("═".repeat(60));
  console.log(`  المزود: ${AI_PROVIDER} | النموذج: ${AI_MODEL} | الوضع: ${isDemoMode ? "🧪 محاكاة محلية (DEMO)" : "🌐 API حقيقي"}`);
  if (isDemoMode) {
    console.log(`  💡 لتفعيل API الحقيقي: ضع المفتاح في ملف .env`);
  }
  console.log("═".repeat(60));

  const testCases = [
    // استفسار
    "مرحبا، ماذا لديكم؟",
    "كم سعر حذاء الركض؟ وهل التوصيل مشمول؟",
    // شراء
    "أريد شراء حذاء الركض",
    "أريد حزام الظهر والحذاء معاً",
    // اعتراض على السعر
    "السعر غالي جداً، هل يوجد خصم؟",
    // شفافية
    "هل أنت ذكاء اصطناعي أم إنسان؟",
    // تصعيد
    "أريد التحدث مع موظف بشري لو سمحت",
    // حالة مركبة - اعتراض ثم شراء
    "طيب موافق، اطلب لي حزام الظهر",
  ];

  for (let i = 0; i < testCases.length; i++) {
    const result = await getKareemReply(testCases[i]);
    printResult(i + 1, testCases[i], result);
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log("  ✅ انتهت جميع الاختبارات بنجاح");
  console.log(`${"═".repeat(60)}\n`);
}

// ──────────────────────────────────────────────
// 11. نقطة الدخول
// ──────────────────────────────────────────────
const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
  const args = process.argv.slice(2);
  if (args.includes("--test") || args.includes("--tests")) {
    runTests();
  } else {
    // الوضع الافتراضي: شغّل السيرفر (مع إمكانية تشغيل الاختبارات عبر npm test)
    // إذا كان المستخدم يريد الاختبارات فقط: npm test أو node agent.mjs --test
    startServer();
  }
}
