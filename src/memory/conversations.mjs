import { resolveTenantInput, memoryKey } from "../../tenants.mjs";
import { MAX_HISTORY, MEMORY_TTL_MS } from "../config/env.mjs";
import { tenantDb } from "../security/tenantGuard.mjs";

function keyOf(phone, tenant) {
  const tid = tenant?.id || "kareem-sport";
  // عزل تام: tenant + phone (نفس الرقم عند بوتين = ذاكرتين منفصلتين)
  return memoryKey(tid, phone);
}

async function tenantOf(input) {
  return resolveTenantInput(input);
}

const conversations = new Map(); // phone -> [{role, text, timestamp}]

// ── منع التكرار: Meta يعيد إرسال نفس الرسالة إذا تأخر الـ 200 ──
const seenMessageIds = new Map(); // wamid -> timestamp
const SEEN_TTL_MS = 1000 * 60 * 60 * 24; // 24 ساعة
// تحديث آخر رد للمساعد (مثلاً بعد إلحاق تعليمات الدفع) — كاش + DB
export async function updateLastAssistant(phone, text, tenantInput) {
  const tenant = await tenantOf(tenantInput);
  const key = keyOf(phone, tenant);
  const entry = conversations.get(key);
  if (entry && entry.messages.length) {
    for (let i = entry.messages.length - 1; i >= 0; i--) {
      if (entry.messages[i].role === "assistant") {
        entry.messages[i].text = text;
        break;
      }
    }
    entry.updatedAt = Date.now();
  }
  try {
    const rows = await tenantDb(tenant?.id).message.findMany({
      where: { phone, role: "assistant" },
      orderBy: { createdAt: "desc" },
      take: 1,
    });
    if (rows[0]) {
      await tenantDb(tenant?.id).message.update({
        where: { id: rows[0].id },
        data: { text },
      });
    }
  } catch (e) {
    console.error(`  ⚠️ فشل تحديث الرد: ${e.message}`);
  }
}

export function isDuplicateMessage(msgId) {
  if (!msgId) return false;
  // تنظيف دوري
  if (seenMessageIds.size > 2000) {
    const now = Date.now();
    for (const [k, ts] of seenMessageIds) {
      if (now - ts > SEEN_TTL_MS) seenMessageIds.delete(k);
    }
  }
  if (seenMessageIds.has(msgId)) return true;
  seenMessageIds.set(msgId, Date.now());
  // ثبات عبر restart: احفظ المعرف في KvStore (fire-and-forget)
  persistSeenMessage(msgId);
  return false;
}

// نسخة دائمة: ذاكرة → Redis (SETNX ذري عبر النسخ) → KvStore/DB.
// تُستخدم في الـ webhook لمنع الرد المكرر بعد restart أو عند التوسع.
export async function isDuplicateMessageAsync(msgId) {
  if (!msgId) return false;
  if (seenMessageIds.has(msgId)) return true;
  try {
    const { redisSetNx } = await import("../jobs/redisClient.mjs");
    const dup = await redisSetNx(`wamid:${msgId}`, SEEN_TTL_MS);
    if (dup === true) {
      seenMessageIds.set(msgId, Date.now());
      return true;
    }
    if (dup === false) {
      seenMessageIds.set(msgId, Date.now());
      persistSeenMessage(msgId);
      return false;
    }
    // dup === null: لا Redis — تحقق من DB ثم سجّل
    const { storeGet } = await import("../../store.mjs");
    if (await storeGet(`wamid:${msgId}`)) {
      seenMessageIds.set(msgId, Date.now());
      return true;
    }
    seenMessageIds.set(msgId, Date.now());
    persistSeenMessage(msgId);
    return false;
  } catch {
    return isDuplicateMessage(msgId);
  }
}

function persistSeenMessage(msgId) {
  import("../../store.mjs")
    .then(({ storeSet }) => storeSet(`wamid:${msgId}`, { at: Date.now() }, SEEN_TTL_MS))
    .catch(() => {});
}

export async function getHistory(phone, tenantInput) {
  const tenant = await tenantOf(tenantInput);
  const key = keyOf(phone, tenant);
  const entry = conversations.get(key);
  if (entry) {
    // تنظيف المنتهية
    if (Date.now() - entry.updatedAt > MEMORY_TTL_MS) {
      conversations.delete(key);
    } else {
      return entry.messages;
    }
  }
  // عند غياب الكاش (مثلاً بعد restart) حمّل من Postgres
  try {
    const { tenantDb } = await import("../security/tenantGuard.mjs");
    const rows = await tenantDb(tenant?.id).message.findMany({
      where: { phone },
      orderBy: { createdAt: "desc" },
      take: MAX_HISTORY,
    });
    const messages = rows.reverse().map((row) => ({
      role: row.role, text: row.text, ts: new Date(row.createdAt).getTime(),
    }));
    conversations.set(key, { messages, updatedAt: Date.now() });
    return messages;
  } catch (e) {
    console.error(`  ⚠️ فشل تحميل الذاكرة: ${e.message}`);
  }
  return [];
}

export async function pushHistory(phone, role, text, tenantInput) {
  const tenant = await tenantOf(tenantInput);
  const key = keyOf(phone, tenant);
  let entry = conversations.get(key);
  if (!entry) {
    entry = { messages: [], updatedAt: Date.now() };
    conversations.set(key, entry);
  }
  entry.messages.push({ role, text, ts: Date.now() });
  if (entry.messages.length > MAX_HISTORY) entry.messages.shift();
  entry.updatedAt = Date.now();
  // حفظ دائم في Postgres (لا يضيع عند restart)
  try {
    const { tenantDb } = await import("../security/tenantGuard.mjs");
    await tenantDb(tenant?.id).message.create({
      data: { phone, role, text },
    });
  } catch (e) {
    console.error(`  ⚠️ فشل حفظ الرسالة: ${e.message}`);
  }
}

export function clearMemory(phone, tenantId) {
  if (phone && tenantId) conversations.delete(memoryKey(tenantId, phone));
  else if (phone) {
    // امسح كل مفاتيح هذا الرقم عبر كل البوتات
    for (const k of [...conversations.keys()]) {
      if (k === phone || k.endsWith(`::${phone}`)) conversations.delete(k);
    }
  } else conversations.clear();
}

export function getMemoryStats() {
  return { conversations: conversations.size, maxHistory: MAX_HISTORY };
}
