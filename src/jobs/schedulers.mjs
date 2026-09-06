import { getTenantFull } from "../../tenants.mjs";
import { dueReminders, markReminded } from "../../bookings.mjs";
import { dueCartRemindersAll, markCartReminded } from "../../orders.mjs";
import { logEvent } from "../../crm.mjs";
import { sendWhatsAppMessage } from "../whatsapp/sender.mjs";
import { pushHistory } from "../memory/conversations.mjs";
import { REMIND_EVERY_MS, REMIND_AFTER_MIN, CART_AFTER_MIN } from "../config/env.mjs";

export function startSchedulers() {
  // مجدول تلقائي: تذكير مواعيد + سلة مهجورة
  
  if (!global.__remindTimer) {
    global.__remindTimer = setInterval(async () => {
      try {
        // 1) تذكير مواعيد
        const due = await dueReminders({ afterMinutes: REMIND_AFTER_MIN });
        for (const b of due.slice(0, 20)) {
          const tenant = await getTenantFull(b.tenantId);
          if (!tenant) continue;
          const msg = `تذكير بموعدك يا غالي ⏰ ${b.service} - الساعة ${b.slot} (${b.id}) في ${tenant.name}.`;
          try {
            await sendWhatsAppMessage(b.phone, msg, tenant);
            await markReminded(b.id, b.tenantId);
            logEvent("booking_reminded", { tenantId: b.tenantId, phone: b.phone, bookingId: b.id }).catch(() => {});
            console.log(`  ⏰ تذكير تلقائي ${b.id} -> ${b.phone}`);
          } catch (e) {
            console.error(`  ❌ فشل التذكير ${b.id}: ${e.message}`);
          }
        }
        // 2) سلة مهجورة — رسالة واحدة لكل رقم (تجميع الطلبات)
        const carts = await dueCartRemindersAll({ afterMinutes: CART_AFTER_MIN });
        const byPhone = new Map();
        for (const o of carts.slice(0, 60)) {
          const key = `${o.tenantId}::${o.phone}`;
          if (!byPhone.has(key)) byPhone.set(key, []);
          byPhone.get(key).push(o);
        }
        for (const [, list] of byPhone) {
          const first = list[0];
          const tenant = await getTenantFull(first.tenantId);
          if (!tenant) continue;
          const lines = list.map((o) => `• ${o.id} ($${o.total})${o.paymentUrl ? ` — ${o.paymentUrl}` : ""}`).join("\n");
          const msg = list.length === 1
            ? `يا هلا يا بطل! 👋 شفنا طلبك ${first.id} ($${first.total}) لسه ما اكتمل. تحب نكمله؟ رابط الدفع: ${first.paymentUrl || "ابعت تم للتأكيد"}`
            : `يا هلا يا بطل! 👋 عندك ${list.length} طلبات لسه ما اكتملت:\n${lines}\nابعت رقم الطلب لنكمله مع بعض.`;
          try {
            await sendWhatsAppMessage(first.phone, msg, tenant);
            for (const o of list) {
              await markCartReminded(o.id, o.tenantId);
            }
            logEvent("cart_reminded", { tenantId: first.tenantId, phone: first.phone, orderIds: list.map((o) => o.id), total: list.reduce((s, o) => s + Number(o.total), 0) }).catch(() => {});
            console.log(`  🛒 سلة مهجورة (${list.length}) -> ${first.phone}`);
          } catch (e) {
            console.error(`  ❌ فشل تذكير السلة لـ ${first.phone}: ${e.message}`);
          }
        }
      } catch (e) {
        console.error(`  ❌ خطأ المجدول: ${e.message}`);
      }
    }, REMIND_EVERY_MS);
    if (global.__remindTimer.unref) global.__remindTimer.unref();
}

}