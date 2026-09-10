import { getTenantFull, isTenantActive } from "../../tenants.mjs";
import { dueReminders, markReminded } from "../../bookings.mjs";
import { dueCartRemindersAll, markCartReminded, fmtMoney } from "../../orders.mjs";
import { logEvent } from "../../crm.mjs";
import { sendWithWindowFallback } from "../compliance/messaging.mjs";
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
          if (!tenant || !isTenantActive(tenant)) continue;
          const msg = `تذكير بموعدك يا غالي ⏰ ${b.service} - يوم ${b.day} - الساعة ${b.slot} (${b.id}) في ${tenant.name}.`;
          try {
            // يمر عبر sendWithWindowFallback: (أ) يمتنع عن ألغوا الاشتراك (ب) قالب بديل خارج النافذة
            const r = await sendWithWindowFallback(b.phone, msg, tenant);
            if (!r.ok) {
              console.log(`  ⏭️ تذكير ${b.id} -> ${b.phone}: ${r.reason}`);
            } else {
              await pushHistory(b.phone, "assistant", msg, tenant).catch(() => {});
            }
            // نعلّم دائماً حتى لا يتكرر مع من ألغوا الاشتراك أو خارج النافذة
            await markReminded(b.id, b.tenantId);
            logEvent("booking_reminded", { tenantId: b.tenantId, phone: b.phone, bookingId: b.id, skipped: r.ok ? undefined : r.reason }).catch(() => {});
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
          if (!tenant || !isTenantActive(tenant)) continue;
          const lines = list.map((o) => `• ${o.id} (${fmtMoney(o.total, o.currency)})`).join("\n");
          const msg = list.length === 1
            ? `يا هلا يا بطل! 👋 شفنا طلبك ${first.id} (${fmtMoney(first.total, first.currency)}) لسه ما اكتمل. تحب نكمله؟ ابعت لقطة الشاشة هون 📸`
            : `يا هلا يا بطل! 👋 عندك ${list.length} طلبات لسه ما اكتملت:\n${lines}\nابعت رقم الطلب لنكمله مع بعض.`;
          try {
            // نفس سياسة الامتثال: من ألغى الاشتراك لا يرى سلة مهجورة، وخارج النافذة قالب بديل
            const r = await sendWithWindowFallback(first.phone, msg, tenant);
            if (!r.ok) {
              console.log(`  ⏭️ سلة مهجورة (${list.length}) -> ${first.phone}: ${r.reason}`);
            } else {
              await pushHistory(first.phone, "assistant", msg, tenant).catch(() => {});
              console.log(`  🛒 سلة مهجورة (${list.length}) -> ${first.phone}`);
            }
            for (const o of list) {
              await markCartReminded(o.id, o.tenantId);
            }
            logEvent("cart_reminded", { tenantId: first.tenantId, phone: first.phone, orderIds: list.map((o) => o.id), total: list.reduce((s, o) => s + Number(o.total), 0), skipped: r.ok ? undefined : r.reason }).catch(() => {});
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

  if (!global.__pruneTimer) {
    global.__pruneTimer = setInterval(async () => {
      try {
        const { pruneOldMessages } = await import("../../db.mjs");
        const n = await pruneOldMessages(30);
        if (n) console.log(`  🧹 تنظيف رسائل أقدم من 30 يوم: ${n}`);
      } catch (e) {
        console.error(`  ❌ خطأ تنظيف الرسائل: ${e.message}`);
      }
    }, 60 * 60 * 1000);
    if (global.__pruneTimer.unref) global.__pruneTimer.unref();
  }

}