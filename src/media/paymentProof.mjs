// ──────────────────────────────────────────────
// التحقق الآلي من إيصالات الدفع (CliQ / محافظ إلكترونية) عبر Gemini Vision
// المسار الأساسي للدفع (Stripe اختياري فقط) — لقطة الشاشة → JSON منظم → مطابقة → تأكيد تلقائي
// ──────────────────────────────────────────────
import { GoogleGenAI } from "@google/genai";
import { GOOGLE_API_KEY, AI_MODEL } from "../config/env.mjs";

let client = null;
function getClient() {
  const key = GOOGLE_API_KEY;
  if (!key || key === "DEMO_KEY") return null;
  if (!client) client = new GoogleGenAI({ apiKey: key });
  return client;
}

const CONFIDENCE_THRESHOLD = Number(process.env.RECEIPT_MIN_CONFIDENCE || 0.7);
const AMOUNT_TOLERANCE_ABS = Number(process.env.RECEIPT_AMOUNT_TOLERANCE || 1);

const digitsOnly = (s) => String(s || "").replace(/\D/g, "");

// ── 1) استخراج منظم من صورة الإيصال ──
// يرجع: { ok, amountPaid, recipientIdentifier, referenceNumber, transactionDate, confidenceScore, reason }
export async function extractReceipt(buffer, mimeType = "image/jpeg") {
  const ai = getClient();
  if (!ai) return { ok: false, reason: "no-api-key" };
  const models = [AI_MODEL || "gemini-flash-lite-latest", "gemini-flash-latest"].filter((v, i, a) => a.indexOf(v) === i);
  const prompt =
    `حلل صورة إيصال التحويل المالي هذه وأرجع JSON فقط (بدون markdown) بهذا الشكل بالضبط:\n` +
    `{"amountPaid": 0.0, "currency": "JOD", "recipientIdentifier": "", "senderIdentifier": "", ` +
    `"referenceNumber": "", "transactionDate": "", "merchantHint": "", "confidenceScore": 0.0}\n` +
    `- amountPaid: المبلغ المحوّل رقمياً فقط. - currency: العملة كما تظهر.\n` +
    `- recipientIdentifier: رقم/اسم المستلم (محفظة/CliQ). - referenceNumber: الرقم المرجعي إن وجد وإلا "".\n` +
    `- transactionDate: التاريخ كما يظهر وإلا "". - confidenceScore: من 0 إلى 1 حسب وضوح الصورة.\n` +
    `إذا لم تكن الصورة إيصال تحويل واضح أرجع {"confidenceScore": 0}.`;

  let lastErr = "empty";
  for (const model of models) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: [{
          role: "user",
          parts: [
            { inlineData: { mimeType, data: buffer.toString("base64") } },
            { text: prompt },
          ],
        }],
      });
      const raw = (response.text || "").trim().replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
      const parsed = JSON.parse(raw);
      const out = {
        ok: true,
        amountPaid: Number(parsed.amountPaid) || 0,
        currency: parsed.currency || null,
        recipientIdentifier: parsed.recipientIdentifier || "",
        senderIdentifier: parsed.senderIdentifier || "",
        referenceNumber: parsed.referenceNumber || "",
        transactionDate: parsed.transactionDate || "",
        merchantHint: parsed.merchantHint || "",
        confidenceScore: Number(parsed.confidenceScore) || 0,
        model,
      };
      if (!out.amountPaid || out.confidenceScore <= 0) return { ok: false, reason: "not-a-receipt", ...out };
      return out;
    } catch (e) {
      lastErr = e.message?.slice(0, 150) || "unknown";
      console.warn(`  ⚠️ قراءة إيصال (${model}): ${lastErr}`);
    }
  }
  return { ok: false, reason: lastErr };
}

// ── 2) مطابقة الاستخراج مع الطلب ──
// يرجع: { match: bool, reasons: [] } — الأسباب تقنية للسجل والموظف فقط
// المبالغ تُطبّع للدولار قبل المقارنة (إيصالات CliQ بالأردني مقابل أسعار USD)
const JOD_PER_USD = Number(process.env.RECEIPT_JOD_PER_USD || 0.71);
function normCurrency(c) {
  const s = String(c || "").toLowerCase();
  if (/jod|jd|دينار|jordan|د\.أ/.test(s)) return "JOD";
  if (/usd|\$|dollar|دولار/.test(s)) return "USD";
  return null;
}
// 1 USD ≈ ‏0.71 JOD → للأردني نقسم (39 دينار ≈ $55)
function toUSD(amount, currency) {
  if (currency === "JOD") return Number(amount) / JOD_PER_USD;
  return Number(amount);
}
export function verifyReceiptAgainstOrder(extracted, order, tenant) {
  const reasons = [];
  if (!extracted?.ok) {
    reasons.push("unreadable");
    return { match: false, reasons };
  }
  // المبلغ بعد توحيد العملة (بتسامح بسيط للتقريب والعمولة)
  const rCur = normCurrency(extracted.currency) || normCurrency(order.currency) || "USD";
  const oCur = normCurrency(order.currency) || "USD";
  const rUSD = toUSD(extracted.amountPaid, rCur);
  const oUSD = toUSD(order.total, oCur);
  const diff = Math.abs(rUSD - oUSD);
  if (diff > AMOUNT_TOLERANCE_ABS) reasons.push(`amount-mismatch (receipt=${extracted.amountPaid}${rCur}≈$${rUSD.toFixed(2)} order=${order.total}${oCur})`);
  // المستلم: آخر 7 أرقام من أي محفظة مسجلة يجب أن تظهر في نص المستلم
  const wallets = tenant?.features?.paymentWallets || [];
  if (wallets.length && extracted.recipientIdentifier) {
    const rec = digitsOnly(extracted.recipientIdentifier);
    const hit = wallets.some((w) => {
      const wn = digitsOnly(w.number);
      return wn.length >= 7 && rec.includes(wn.slice(-7));
    });
    if (!hit) reasons.push("recipient-mismatch");
  }
  // الثقة
  if (Number(extracted.confidenceScore) < CONFIDENCE_THRESHOLD) reasons.push(`low-confidence (${extracted.confidenceScore})`);
  return { match: reasons.length === 0, reasons };
}

// ── 3) المنسّق الكامل: صورة واتساب → (تأكيد تلقائي | مراجعة يدوية) ──
export async function handleReceiptImage({ tenant, phone, mediaId, mimeType = "image/jpeg" }) {
  const { downloadWhatsAppMedia } = await import("../../voice.mjs");
  const { latestPendingOrder, latestRejectedOrder, reopenRejectedOrder, markOrderReview } = await import("../../orders.mjs");
  const { finalizePaidOrder } = await import("../web/routes/billing.mjs");
  const { sendWhatsAppMessage } = await import("../whatsapp/sender.mjs");
  const { pushHistory } = await import("../memory/conversations.mjs");
  const { logEvent } = await import("../../crm.mjs");

  if (!tenant) return { outcome: "no-tenant" }; // تحصين: لا نعالج إيصالاً بلا مستأجر
  let order = await latestPendingOrder(tenant.id, phone);
  let reopened = false;
  if (!order) {
    // إعادة المحاولة: طلب مرفوض خلال 48 ساعة يُعاد فتحه تلقائياً عند وصول لقطة جديدة —
    // عميل دفع فعلياً ولا يمكن أن يُترك خارج الحلقة بعد رفض إداري.
    const rejected = await latestRejectedOrder(tenant.id, phone);
    if (rejected) {
      const re = await reopenRejectedOrder(rejected.id, tenant.id);
      if (re) {
        order = re;
        reopened = true;
        console.log(`  ♻️ طلب مرفوض ${order.id} أُعيد فتحه لإعادة المحاولة (${phone})`);
        await logEventSafe(logEvent, "order_reopened", { tenantId: tenant.id, phone, orderId: order.id });
      }
    }
  }
  if (!order) return { outcome: "no-order" };

  const token = tenant?.whatsapp_token || process.env.WHATSAPP_TOKEN;
  let buffer;
  try {
    ({ buffer } = await downloadWhatsAppMedia(mediaId, token));
  } catch (e) {
    return { outcome: "download-failed", orderId: order.id, error: e.message };
  }

  const extracted = await extractReceipt(buffer, mimeType);
  if (!extracted.ok && extracted.reason === "no-api-key") {
    // بدون مفتاح AI: المسار اليدوي القديم (إرفاق + انتظار الموظف)
    const { attachProof } = await import("../../orders.mjs");
    await attachProof(order.id, tenant.id, { mediaId, at: new Date().toISOString(), auto: false });
    await logEventSafe(logEvent, "proof_received", { tenantId: tenant.id, phone, orderId: order.id });
    return { outcome: "manual", orderId: order.id, total: order.total, currency: order.currency };
  }

  const { match, reasons } = verifyReceiptAgainstOrder(extracted, order, tenant);
  // حماية إعادة الاستخدام: نفس رقم المرجع المرجعي لا يُسدد طلباً ثانياً تلقائياً —
  // لقطة واحدة (أو صورة متطابقة) تُدفع مرة واحدة فقط مهما تعددت الطلبات المعلقة.
  if (match && extracted.referenceNumber) {
    const { tenantDb } = await import("../../security/tenantGuard.mjs");
    const dup = await tenantDb(tenant.id).order.findFirst({
      where: {
        phone,
        status: "paid",
        id: { not: order.id },
        proof: { path: ["receipt", "referenceNumber"], equals: extracted.referenceNumber },
        paidAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
      },
    }).catch(() => null);
    if (dup) {
      reasons.push(`reference-already-paid (${dup.id})`);
      console.log(`  ⚠️ مرجع ${extracted.referenceNumber} سبق دفعه للطلب ${dup.id} — طلب ${order.id} للمراجعة اليدوية`);
    }
  }
  const proof = { mediaId, at: new Date().toISOString(), auto: true, receipt: extracted, reasons };
  const isMatch = match && reasons.length === 0;

  if (isMatch) {
    await finalizePaidOrder(order.id, "receipt-ai");
    const paidLabel = extracted.currency
      ? `${extracted.amountPaid} ${extracted.currency}`
      : `$${extracted.amountPaid}`;
    const msg =
      `تم التحقق من إيصالك تلقائياً ✅\n` +
      `🧾 الطلب ${order.id} — المبلغ المستلم ${paidLabel} (مرجع: ${extracted.referenceNumber || "—"}).\n` +
      (reopened ? `وعدنا فتح الطلب من جديد بعد الرفض السابق 🙌\n` : ``) +
      `طلبك تأكد وبتجهز هلا للتوصيل. شكراً لثقتك! 🙏`;
    try {
      await sendWhatsAppMessage(phone, msg, tenant);
      await pushHistory(phone, "assistant", msg, tenant);
    } catch (e) { console.error(`  ❌ فشل إرسال تأكيد الإيصال: ${e.message}`); }
    await logEventSafe(logEvent, "receipt_auto_paid", {
      tenantId: tenant.id, phone, orderId: order.id,
      amount: extracted.amountPaid, reference: extracted.referenceNumber,
    });
    return { outcome: "paid", orderId: order.id, receipt: extracted };
  }

  // مشبوه/غير مطابق → مراجعة يدوية + تنبيه الموظف
  // (التفاصيل التقنية للموظف والسجل فقط — الزبون توصله صياغة بشرية)
  await markOrderReview(order.id, tenant.id, proof);
  const reasonArMap = {
    "unreadable": "تعذر قراءة الإيصال بوضوح",
    "recipient-mismatch": "رقم المستلم بالإيصال غير مطابق لأرقامنا",
    "low-confidence": "صورة الإيصال غير واضحة كفاية",
  };
  const noteAr = reasons.length
    ? reasons.map((r) => {
        if (r.startsWith("amount-mismatch")) return "المبلغ بالإيصال مختلف عن قيمة طلبك";
        if (r.startsWith("low-confidence")) return reasonArMap["low-confidence"];
        return reasonArMap[r] || "تحقق إضافي";
      }).join("، ")
    : "تحقق إضافي";
  const msg =
    `وصلني الإيصال يا بطل 📸 بس في ملاحظة: ${noteAr}.\n` +
    `حطيت طلبك ${order.id} قيد المراجعة 🔍 والموظف رح يتأكد ويبعتلك التأكيد هنا. شكراً لصبرك!`;
  try {
    await sendWhatsAppMessage(phone, msg, tenant);
    await pushHistory(phone, "user", "[صورة: إيصال تحويل]", tenant);
    await pushHistory(phone, "assistant", msg, tenant);
  } catch (e) { console.error(`  ❌ فشل إرسال رد المراجعة: ${e.message}`); }
  await logEventSafe(logEvent, "proof_needs_review", {
    tenantId: tenant.id, phone, orderId: order.id, reasons, receipt: extracted,
  });
  try {
    const { notifyStaff } = await import("../compliance/messaging.mjs");
    await notifyStaff(tenant, `🔍 إيصال يحتاج مراجعة: طلب ${order.id} من ${phone} (${reasons.join("، ")})`);
  } catch { /* التنبيه أفضل-جهد */ }
  return { outcome: "review", orderId: order.id, reasons, receipt: extracted };
}

async function logEventSafe(logEvent, type, data) {
  try { await logEvent(type, data); } catch { /* لا تكسر التدفق */ }
}
