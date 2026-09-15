// معالج الوسائط: فويس نوت + صور الإيصالات — يرجع true إذا عالج الرسالة
import { WHATSAPP_TOKEN } from "../../../../config/env.mjs";
import { downloadWhatsAppMedia, transcribeAudio } from "../../../../../voice.mjs";
import { voiceQueue } from "../../../../jobs/queue.mjs";
import { sendWhatsAppMessage } from "../../../../whatsapp/sender.mjs";
import { pushHistory } from "../../../../memory/conversations.mjs";
import { fmtMoney } from "../../../../../orders.mjs";
import { logEvent } from "../../../../../crm.mjs";

export async function handleVoice(ctx) {
  const { msg, from, tenant, text, channel } = ctx;
  // نوع الوسائط عبر القناة (واتساب/ماسنجر/انستغرام) — نفس الشروط السابقة
  const media = channel?.extractMedia ? channel.extractMedia(msg) : null;
  if (!((media?.kind === "audio" || msg.type === "audio" || msg.audio?.id) && !text)) return false;
  try {
    const mediaId = msg.audio?.id;
    console.log(`  🎤 فويس من ${from} (media=${mediaId}) - جاري التفريغ...`);
    const { text: transcript, reason } = await voiceQueue.run(`voice:${msg.id || `${from}:${Date.now()}`}`, async () => {
      const { buffer, mimeType } = await downloadWhatsAppMedia(mediaId, tenant?.whatsapp_token || WHATSAPP_TOKEN);
      return transcribeAudio(buffer, mimeType, (tenant?.languages || ["ar", "en"]).join(","));
    });
    if (transcript) {
      ctx.text = transcript;
      console.log(`  🎤 تفريغ: "${ctx.text}"`);
      return false; // أكمل المعالجة بالنص المفرّغ
    }
    console.log(`  ⚠️ تعذر التفريغ (${reason})`);
    await sendWhatsAppMessage(from, "وصلني الفويس يا غالي 🎤 بس ما قدرت أفرغه، ابعتلي كتابة لو سمحت.", tenant).catch(() => {});
    console.log(`${"─".repeat(60)}\n`);
    return true;
  } catch (e) {
    console.error(`  ❌ خطأ الفويس: ${e.message}`);
    await sendWhatsAppMessage(from, "ما قدرت أسمع الفويس، ابعتلي كتابة يا غالي.", tenant).catch(() => {});
    console.log(`${"─".repeat(60)}\n`);
    return true;
  }
}

export async function handleReceiptImage(ctx) {
  const { msg, from, tenant, text, channel } = ctx;
  const media = channel?.extractMedia ? channel.extractMedia(msg) : null;
  if (!((media?.kind === "image" || media?.kind === "document" || msg.type === "image" || msg.image?.id || msg.type === "document" || msg.document?.id) && !text)) return false;
  const mediaId = media?.id || msg.image?.id || msg.document?.id;
  const mimeType = media?.mimeType || msg.document?.mime_type || "image/jpeg";
  // الكابشن قد يحمل رقم الطلب — يُمرر للربط الدقيق بدل الأحدث دائماً
  const caption = media?.caption || msg.image?.caption || msg.document?.caption || msg.document?.filename || "";
  const { handleReceiptImage } = await import("../../../../media/paymentProof.mjs");
  const res = await handleReceiptImage({ tenant, phone: from, mediaId, mimeType, caption });
  if (res.outcome === "no-tenant") {
    // دفاع بالعمق: البوابة العليا تمنع الوصول أصلاً — هذا الفرع للوضوح فقط
    console.log(`  ⛔ إيصال بلا مستأجر (media=${mediaId}) — تجاهل صريح`);
    console.log(`${"─".repeat(60)}\n`);
  } else if (res.outcome === "no-order") {
    const reply = `وصلتني الصورة يا غالي 📸 بس ما لقيت طلب معلق برقمك. إذا بدك تطلب ابعت "بدي اطلب"، وإذا هاي لقطة تحويل ابعت رقم الطلب معها.`;
    try {
      await sendWhatsAppMessage(from, reply, tenant);
    } catch (e) {
      console.error(`  ❌ فشل الإرسال: ${e.message}`);
    }
    console.log(`${"─".repeat(60)}\n`);
  } else if (res.outcome === "download-failed") {
    const reply = `وصلتني الصورة بس ما قدرت أحملها 😅 ابعتها مرة تانية لو سمحت.`;
    try {
      await sendWhatsAppMessage(from, reply, tenant);
    } catch (e) {
      console.error(`  ❌ فشل الإرسال: ${e.message}`);
    }
    console.log(`  ⚠️ فشل تحميل إيصال ${res.orderId}: ${res.error}`);
    console.log(`${"─".repeat(60)}\n`);
  } else if (res.outcome === "manual") {
    // بدون مفتاح AI: المسار اليدوي — إرفاق + انتظار الموظف
    const reply = `وصلتني اللقطة يا غالي 📸 ربطتها بطلبك ${res.orderId} (${fmtMoney(res.total, res.currency)}). الموظف رح يتأكد من التحويل ويبعتلك التأكيد هنا. شكراً لثقتك!`;
    await pushHistory(from, "user", "[صورة: لقطة تحويل]", tenant);
    await pushHistory(from, "assistant", reply, tenant);
    try {
      await sendWhatsAppMessage(from, reply, tenant);
    } catch (e) {
      console.error(`  ❌ فشل الإرسال: ${e.message}`);
    }
    console.log(`  📸 إثبات ${res.orderId} من ${from} (media=${mediaId})`);
    console.log(`${"─".repeat(60)}\n`);
  } else {
    // paid/review: الردود أُرسلت داخل handleReceiptImage
    console.log(`  🧾 إيصال ${res.orderId} من ${from} → ${res.outcome}`);
    console.log(`${"─".repeat(60)}\n`);
  }
  return true;
}
