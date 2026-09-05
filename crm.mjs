import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, isDbEnabled } from "./db.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, "crm.json");

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf-8")).events || [];
  } catch {
    return [];
  }
}
function save(all) {
  // نحتفظ بآخر 2000 حدث فقط
  const trimmed = all.slice(-2000);
  fs.writeFileSync(FILE, JSON.stringify({ events: trimmed }, null, 2) + "\n");
}

// تسجيل حدث CRM + إرسال اختياري لـ webhook خارجي (Sheets/Make/n8n)
export async function logEvent(type, data = {}) {
  const event = {
    id: `ev_${Date.now().toString(36)}${Math.floor(Math.random() * 99)}`,
    type, // message | order | order_paid | booking | booking_reminded | cart_reminded | takeover | handover | broadcast | csat
    ...data,
    at: new Date().toISOString(),
  };

  if (isDbEnabled()) {
    await db().query(
      `INSERT INTO events (id, type, tenant_id, phone, data) VALUES ($1,$2,$3,$4,$5)`,
      [event.id, type, data.tenantId || null, data.phone || null, JSON.stringify(data)]
    );
  } else {
    const all = load();
    all.push(event);
    save(all);
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
  if (isDbEnabled()) {
    let q = `SELECT * FROM events WHERE 1=1`;
    const params = [];
    if (tenantId) {
      params.push(tenantId);
      q += ` AND tenant_id=$${params.length}`;
    }
    if (type) {
      params.push(type);
      q += ` AND type=$${params.length}`;
    }
    params.push(Math.min(limit, 2000));
    q += ` ORDER BY created_at DESC LIMIT $${params.length}`;
    const r = await db().query(q, params);
    return r.rows.map((row) => ({
      id: row.id, type: row.type,
      tenantId: row.tenant_id, phone: row.phone,
      ...(typeof row.data === "string" ? JSON.parse(row.data) : row.data),
      at: row.created_at,
    }));
  }
  let all = load();
  if (tenantId) all = all.filter((e) => !e.tenantId || e.tenantId === tenantId);
  if (type) all = all.filter((e) => e.type === type);
  return all.slice(-limit).reverse();
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
