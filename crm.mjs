import { tenantDb, systemDb } from "./src/security/tenantGuard.mjs";

// تسجيل حدث CRM + إرسال اختياري لـ webhook خارجي (Sheets/Make/n8n)
export async function logEvent(type, data = {}) {
  const event = {
    id: `ev_${Date.now().toString(36)}${Math.floor(Math.random() * 99)}`,
    type, // message | order | order_paid | booking | booking_reminded | cart_reminded | takeover | handover | broadcast | csat
    ...data,
    at: new Date().toISOString(),
  };

  try {
    const T = data.tenantId ? tenantDb(data.tenantId) : systemDb("crm:system-event");
    await T.event.create({
      data: {
        id: event.id, type,
        tenantId: data.tenantId || null,
        phone: data.phone || null,
        data,
      },
    });
  } catch (e) {
    console.error(`  ⚠️ فشل حفظ حدث CRM: ${e.message}`);
  }

  // webhook خارجي اختياري (Google Sheets عبر Make/n8n)
  const hook = process.env.CRM_WEBHOOK_URL;
  if (hook) {
    try {
      await fetch(hook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
      });
    } catch (e) {
      console.error(`  ⚠️ فشل CRM webhook: ${e.message}`);
    }
  }
  return event;
}

export async function listEvents({ tenantId, type, limit = 100 } = {}) {
  const T = tenantId ? tenantDb(tenantId) : systemDb("crm:listAll");
  const rows = await T.event.findMany({
    where: { ...(type ? { type } : {}) },
    orderBy: { createdAt: "desc" },
    take: Math.min(limit, 2000),
  });
  return rows.map((row) => ({
    id: row.id, type: row.type,
    tenantId: row.tenantId, phone: row.phone,
    ...(row.data || {}),
    at: row.createdAt,
  }));
}

export function toCSV(events) {
  const header = "id,type,tenantId,phone,intent,total,at";
  const rows = events.map((e) =>
    [e.id, e.type, e.tenantId || "", e.phone || "", e.intent || "", e.total ?? "", e.at]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(",")
  );
  return [header, ...rows].join("\n");
}
