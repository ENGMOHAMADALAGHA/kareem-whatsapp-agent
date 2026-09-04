import { GoogleGenAI } from "@google/genai";

let client = null;
function getClient() {
  const key = process.env.GOOGLE_API_KEY;
  if (!key || key === "DEMO_KEY") return null;
  if (!client) client = new GoogleGenAI({ apiKey: key });
  return client;
}

// تحميل ملف صوتي من واتساب عبر media ID
export async function downloadWhatsAppMedia(mediaId, whatsappToken) {
  // 1. جيب رابط التحميل
  const meta = await fetch(`https://graph.facebook.com/v18.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${whatsappToken}` },
  });
  const metaJson = await meta.json();
  if (!meta.ok) throw new Error(metaJson.error?.message || "فشل جلب رابط الميديا");
  // 2. حمّل الملف
  const fileRes = await fetch(metaJson.url, {
    headers: { Authorization: `Bearer ${whatsappToken}` },
  });
  if (!fileRes.ok) throw new Error(`فشل تحميل الملف: ${fileRes.status}`);
  const buffer = Buffer.from(await fileRes.arrayBuffer());
  return { buffer, mimeType: metaJson.mime_type || "audio/ogg" };
}

// تفريغ صوتي عبر Gemini (يدعم ogg/mp3/m4a)
export async function transcribeAudio(buffer, mimeType = "audio/ogg") {
  const ai = getClient();
  if (!ai) return { text: "", reason: "no-api-key" };
  const model = process.env.AI_MODEL || "gemini-flash-lite-latest";
  const base64 = buffer.toString("base64");
  const response = await ai.models.generateContent({
    model,
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType, data: base64 } },
          { text: "فرّغ هذا المقطع الصوتي نصياً فقط بنفس لغته (عربي أو إنجليزي). بدون شرح." },
        ],
      },
    ],
  });
  return { text: (response.text || "").trim() };
}
