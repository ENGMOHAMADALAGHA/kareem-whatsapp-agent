import { GoogleGenAI } from "@google/genai";

let client = null;
function getClient() {
  const key = process.env.GOOGLE_API_KEY;
  if (!key || key === "DEMO_KEY") return null;
  if (!client) client = new GoogleGenAI({ apiKey: key });
  return client;
}

const TIMEOUT_MS = Number(process.env.VOICE_TIMEOUT_MS || 15000);
const MAX_MB = Number(process.env.VOICE_MAX_MB || 8);
// مهلة التفريغ نفسه (منفصلة عن مهلة التحميل) — gdyby تجاوزها نرد برسالة بديلة
const TRANSCRIBE_TIMEOUT_MS = Number(process.env.VOICE_TRANSCRIBE_TIMEOUT_MS || 45000);

async function fetchWithTimeout(url, options = {}, ms = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// تحميل ملف صوتي من واتساب عبر media ID (مع مهلة + حد حجم)
export async function downloadWhatsAppMedia(mediaId, whatsappToken) {
  if (!mediaId) throw new Error("لا يوجد media ID");
  // 1. جيب رابط التحميل
  const meta = await fetchWithTimeout(`https://graph.facebook.com/v18.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${whatsappToken}` },
  });
  const metaJson = await meta.json();
  if (!meta.ok) throw new Error(metaJson.error?.message || "فشل جلب رابط الميديا");
  const size = metaJson.file_size ? `(${(metaJson.file_size / 1024).toFixed(0)}KB)` : "";
  console.log(`  🎤 ملف صوتي: ${metaJson.mime_type || "?"} ${size}`);
  // فحص مسبق من الـ metadata قبل سحب أي بايت (يمنع قفزات الذاكرة من base64)
  if (metaJson.file_size && metaJson.file_size > MAX_MB * 1024 * 1024) {
    throw new Error(`الملف كبير (${(metaJson.file_size / 1024 / 1024).toFixed(1)}MB) — ابعت فويس أقصر من دقيقة لو سمحت`);
  }
  // 2. حمّل الملف مع حد حجم
  const fileRes = await fetchWithTimeout(metaJson.url, {
    headers: { Authorization: `Bearer ${whatsappToken}` },
  });
  if (!fileRes.ok) throw new Error(`فشل تحميل الملف: ${fileRes.status}`);
  const buffer = Buffer.from(await fileRes.arrayBuffer());
  if (buffer.length > MAX_MB * 1024 * 1024) {
    throw new Error(`الملف كبير (${(buffer.length / 1024 / 1024).toFixed(1)}MB) — ابعت فويس أقصر من دقيقة لو سمحت`);
  }
  return { buffer, mimeType: metaJson.mime_type || "audio/ogg" };
}

// تفريغ صوتي عبر Gemini (إعادة محاولة + موديل بديل + تلميح لغة + مهلة إجمالية)
export async function transcribeAudio(buffer, mimeType = "audio/ogg", langHint = "ar,en") {
  const ai = getClient();
  if (!ai) return { text: "", reason: "no-api-key" };
  // حارس الذاكرة: لا نحوّل لم base64 أكثر من الحد (فحص مزدوج بعد التحميل)
  if (buffer.length > MAX_MB * 1024 * 1024) {
    return { text: "", reason: "too-large" };
  }
  const job = _transcribeInner(ai, buffer, mimeType, langHint);
  let timer;
  try {
    return await Promise.race([
      job,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("transcribe-timeout")), TRANSCRIBE_TIMEOUT_MS);
      }),
    ]);
  } catch (e) {
    if (e?.message === "transcribe-timeout") return { text: "", reason: "timeout" };
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function _transcribeInner(ai, buffer, mimeType, langHint) {
  const primary = process.env.AI_MODEL || "gemini-flash-lite-latest";
  const models = [primary, "gemini-flash-latest"].filter((v, i, a) => a.indexOf(v) === i);
  const base64 = buffer.toString("base64");
  const prompt =
    `فرّغ هذا المقطع الصوتي نصياً فقط بنفس لغته (${langHint}). ` +
    `قد تكون اللهجة أردنية عامية — اكتبها كما سمعتها بدون ترجمة للفصحى. بدون شرح أو مقدمات.`;

  let lastErr = "";
  for (const model of models) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: [
            {
              role: "user",
              parts: [
                { inlineData: { mimeType, data: base64 } },
                { text: prompt },
              ],
            },
          ],
        });
        const text = (response.text || "").trim();
        if (text) return { text, model };
        lastErr = "رد فارغ";
      } catch (e) {
        lastErr = e.message?.slice(0, 150) || "خطأ غير معروف";
        console.warn(`  ⚠️ تفريغ (${model} محاولة ${attempt}): ${lastErr}`);
        await new Promise((r) => setTimeout(r, 800 * attempt));
      }
    }
  }
  return { text: "", reason: lastErr };
}
