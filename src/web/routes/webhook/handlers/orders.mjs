// معالج الطلبات والتقييم: نسيان الطلبات + استعلام برقم + CSAT
import { getOrder, fmtMoney } from "../../../../../orders.mjs";
import { sendChText } from "../../../../channels/send.mjs";
import { pushHistory } from "../../../../memory/conversations.mjs";
import { hasPendingCsat, saveRating } from "../../../../../engage.mjs";
import { logEvent } from "../../../../../crm.mjs";

export async function handleCancelIntent(ctx) {
  const { from, tenant, text } = ctx;
  // —— نية إلغاء/نسيان الطلب: "انسى الطلب القديم / الغيه / كنسل / بلا / لا بدي طلب جديد" ——
  // تُلغى كل الطلبات المفتوحة فوراً ولا يُنشأ طلب بهذه الدورة (الذكاء يرد محادثة نظيفة)
  if (/(انسى|انس|أنسى|الغي|ألغي|الغاء|إلغاء|الغى|كنسل|كنسله|بلا.*طلب|ما بدي.*طلب|لا.*طلب جديد|امسح.*طلب|من غير طلب)/.test(text)) {
    const { cancelOpenOrders } = await import("../../../../../orders.mjs");
    let killed;
    try {
      killed = await cancelOpenOrders(tenant?.id, from);
    } catch (e) {
      // عطل تقني — لا ندعي "ما عندك معلقة" كذباً
      const reply = `عذراً يا غالي 🙏 تعذر الوصول لطلباتك هلا لعطل مؤقت. ابعت "أريد موظف" للمساعدة الفورية.`;
      await pushHistory(from, "user", text, tenant);
      await pushHistory(from, "assistant", reply, tenant);
      try {
        await sendChText(ctx, reply, tenant);
      } catch (se) {
        console.error(`  ❌ فشل الإرسال: ${se.message}`);
      }
      console.log(`  ☠️ فشل نسيان طلبات ${from}: ${e.message}`);
      console.log(`${"─".repeat(60)}\n`);
      return true;
    }
    const reply = killed > 0
      ? `تمام يا غالي ✅ نسيت الطلبات المعلقة (${killed}). ابعت طلبك الجديد وأنا جاهز 👟`
      : `ما عندك طلبات معلقة يا غالي 😊 ابعت طلبك الجديد وأنا جاهز 👟`;
    await pushHistory(from, "user", text, tenant);
    await pushHistory(from, "assistant", reply, tenant);
    logEvent("orders_forgotten", { tenantId: tenant?.id, phone: from, killed }).catch(() => {});
    try {
      await sendChText(ctx, reply, tenant);
    } catch (e) {
      console.error(`  ❌ فشل الإرسال: ${e.message}`);
    }
    console.log(`  🧹 نسيان طلبات ${from} (أُلغي ${killed})`);
    console.log(`${"─".repeat(60)}\n`);
    return true;
  }
  return false;
}

export async function handleOrderQuery(ctx) {
  const { from, tenant, text } = ctx;
  // —— استعلام عن طلب: "وين طلبي ord_..." (مقيد بنطاق البوت + رقم السائل) ——
  const orderMatch = text.match(/\b(ord_[a-z0-9]+)\b/i);
  if (!orderMatch) return false;
  const qOrder = await getOrder(orderMatch[1].toLowerCase(), tenant?.id).catch(() => null);
  let reply;
  if (qOrder && qOrder.phone === from) {
    const statusAr = { pending: "بانتظار الدفع ⏳", paid: "مدفوع ✅", canceled: "ملغي", proof_received: "إيصال مستلم 📸", pending_review: "قيد المراجعة اليدوية 🔍", rejected: "مرفوض — راجع الإيصال ❌" }[qOrder.status] || qOrder.status;
    reply = `طلبك ${qOrder.id} — ${(qOrder.items || []).map((i) => i.name).join(" + ")} — الإجمالي ${fmtMoney(qOrder.total, qOrder.currency)} — الحالة: ${statusAr}`;
  } else {
    reply = `ما لقيت طلب بهذا الرقم يا غالي 🤔 تأكد من الرقم (مثال: ord_abc123) أو ابعت "أريد موظف" للمساعدة.`;
  }
  await pushHistory(from, "user", text, tenant);
  await pushHistory(from, "assistant", reply, tenant);
  logEvent("message", { tenantId: tenant?.id, phone: from, intent: "استفسار", text: text.slice(0, 200) }).catch(() => {});
  try {
    await sendChText(ctx, reply, tenant);
  } catch (e) {
    console.error(`  ❌ فشل إرسال حالة الطلب: ${e.message}`);
  }
  console.log(`  📦 استعلام طلب ${orderMatch[1]} للعميل ${from}`);
  console.log(`${"─".repeat(60)}\n`);
  return true;
}

export async function handleCsat(ctx) {
  const { from, tenant, text } = ctx;
  // —— CSAT: إذا الرد رقم 1-5 وكان في طلب تقييم معلق ——
  if (!/^[1-5]$/.test(text.trim())) return false;
  const pending = await hasPendingCsat(tenant?.id, from);
  if (!pending) return false;
  const score = Number(text.trim());
  const rating = await saveRating({ tenantId: tenant.id, phone: from, score, refId: pending.refId });
  const reply = score >= 4
    ? `شكراً يا غالي! ⭐ تقييمك ${score}/5 أسعدنا ونوره يتقدم.`
    : `شكراً لصراحتك يا غالي 🙏 تقييمك ${score}/5 وصلنا ورح نشتغل نحسّن. تحب يحكي معك موظف؟`;
  await pushHistory(from, "user", text, tenant);
  await pushHistory(from, "assistant", reply, tenant);
  logEvent("csat", { tenantId: tenant.id, phone: from, score, refId: pending.refId }).catch(() => {});
  try {
    await sendChText(ctx, reply, tenant);
  } catch (e) {
    console.error(`  ❌ فشل إرسال رد التقييم: ${e.message}`);
  }
  console.log(`  ⭐ تقييم ${rating.id} ${tenant.id} ${from} = ${score}`);
  console.log(`${"─".repeat(60)}\n`);
  return true;
}
