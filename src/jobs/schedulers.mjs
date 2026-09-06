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
            await markReminded(b.id);
            logEvent("booking_reminded", { tenantId: b.tenantId, phone: b.phone, bookingId: b.id }).catch(() => {});
            console.log(`  ⏰ تذكير تلقائي ${b.id} -> ${b.phone}`);
          } catch (e) {
            console.error(`  ❌ فشل التذكير ${b.id}: ${e.message}`);
          }
        }
        // 2) سلة مهجورة (طلبات pending بدون دفع)
        const { dueCartRemindersAll } = await import("./orders.mjs");
        const carts = await dueCartRemindersAll({ afterMinutes: CART_AFTER_MIN });
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
    }, REMIND_EVERY_MS);
    if (global.__remindTimer.unref) global.__remindTimer.unref();
}

}