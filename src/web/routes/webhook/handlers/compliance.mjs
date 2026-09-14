// معالج الامتثال والطاقم: إلغاء/إعادة اشتراك + أوامر الموظف + takeover
import { STAFF_PHONE } from "../../../../config/env.mjs";
import { normalizePhone } from "../../../../utils/phone.mjs";
import { sendWhatsAppMessage } from "../../../../whatsapp/sender.mjs";
import { pushHistory } from "../../../../memory/conversations.mjs";
import { setTakeover, isTakeover } from "../../../../inbox/service.mjs";
import { logEvent } from "../../../../../crm.mjs";

export async function handleCompliance(ctx) {
  const { from, tenant, text } = ctx;
  const { isOptOut, isOptIn, markOptedOut, clearOptOut } = await import("../../../../compliance/messaging.mjs");
  if (isOptOut(text)) {
    await markOptedOut(tenant?.id, from);
    const reply = `تم يا غالي ✅ ألغينا اشتراكك وما رح نراسلك بأي عروض. إذا غيّرت رأيك ابعت "اشتراك".`;
    await pushHistory(from, "user", text, tenant);
    await pushHistory(from, "assistant", reply, tenant);
    logEvent("opt_out", { tenantId: tenant?.id, phone: from }).catch(() => {});
    try {
      await sendWhatsAppMessage(from, reply, tenant);
    } catch (e) {
      console.error(`  ❌ فشل إرسال تأكيد الإلغاء: ${e.message}`);
    }
    console.log(`  🚫 إلغاء اشتراك ${from} (${tenant?.id})`);
    console.log(`${"─".repeat(60)}\n`);
    return true;
  }
  if (isOptIn(text)) {
    await clearOptOut(tenant?.id, from);
    const reply = `أهلاً بعودتك يا غالي! 🎉 رجّعنا اشتراكك ورح توصلك عروضنا. كيف بقدر أساعدك اليوم؟`;
    await pushHistory(from, "user", text, tenant);
    await pushHistory(from, "assistant", reply, tenant);
    logEvent("opt_in", { tenantId: tenant?.id, phone: from }).catch(() => {});
    try {
      await sendWhatsAppMessage(from, reply, tenant);
    } catch (e) {
      console.error(`  ❌ فشل الإرسال: ${e.message}`);
    }
    console.log(`${"─".repeat(60)}\n`);
    return true;
  }
  return false;
}

export async function handleStaff(ctx) {
  const { from, tenant, text } = ctx;
  // —— أوامر الطاقم: "قف" يُسكت البوت على هذه المحادثة (takeover)، "شغّل" يرجعّه — رقم الموظف المسجل فقط ——
  // السلوك قبل هذه الكتلة: لو كان takeover نشطاً نتجاهل الرسالة — لذلك تُعترض هنا قبل فحصه
  // حتى يتمكن الموظف المُسكَت نفسه من إعادة تفعيل البوت بكلمة "شغّل".
  const staffNum = tenant?.features?.staffPhone || STAFF_PHONE;
  const cmdText = text.trim().replace(/^(البوت\s*|يا\s*بوت\s*)/, "");
  if ((cmdText === "قف" || cmdText === "شغّل") && staffNum && normalizePhone(staffNum) === from) {
    const on = cmdText === "قف";
    await setTakeover(tenant?.id, from, on, `staff:${from}`);
    const reply = on
      ? "تم ✅ سكّت البوت على هالمحادثة — بيرد الموظف من الموقع مباشرة. لإرجاعه ابعت \"شغّل\"."
      : "تمام ✅ البوت رجع يرد على هالمحادثة.";
    await pushHistory(from, "user", text, tenant);
    await pushHistory(from, "assistant", reply, tenant);
    logEvent(on ? "staff_pause" : "staff_resume", { tenantId: tenant?.id, phone: from }).catch(() => {});
    try {
      await sendWhatsAppMessage(from, reply, tenant);
    } catch (e) {
      console.error(`  ❌ فشل إرسال تأكيد أمر الطاقم: ${e.message}`);
    }
    console.log(`  🎛️  أمر طاقم ${cmdText} من ${from} (${tenant?.id})`);
    console.log(`${"─".repeat(60)}\n`);
    return true;
  }
  if (await isTakeover(tenant?.id, from)) {
    await pushHistory(from, "user", text, tenant);
    console.log(`  ⏸️ takeover نشط (${from}) - حُفظت الرسالة بدون رد آلي`);
    console.log(`${"─".repeat(60)}\n`);
    return true;
  }
  return false;
}
