import { memoryKey } from "../../tenants.mjs";
import { storeGet, storeSet, storeDel } from "../../store.mjs";
import { getHistory } from "../memory/conversations.mjs";
import { tenantDb, systemDb } from "../security/tenantGuard.mjs";

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
