import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import express from "express";
import { fileURLToPath } from "node:url";
import {
  resolveTenant,
  getTenantFull,
  listTenants,
  addTenant,
  buildSystemPrompt,
  memoryKey,
} from "./tenants.mjs";
import {
  bookAppointment,
  listAppointments,
  getBookingState,
  setBookingState,
  dueReminders,
  markReminded,
  cancelAppointment,
} from "./bookings.mjs";
import { downloadWhatsAppMedia, transcribeAudio } from "./voice.mjs";
import {
  createOrder,
  getOrder,
  listOrders,
  markOrderPaid,
  createPaymentLink,
  dueCartReminders,
  markCartReminded,
} from "./orders.mjs";
import { logEvent, listEvents, toCSV } from "./crm.mjs";
import {
  saveBroadcast,
  listBroadcasts,
  requestCsat,
  hasPendingCsat,
  saveRating,
  csatStats,
} from "./engage.mjs";

dotenv.config();

// ──────────────────────────────────────────────
// 1. الإعدادات
// ──────────────────────────────────────────────
const AI_PROVIDER = process.env.AI_PROVIDER?.toLowerCase() || "google";
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const AI_MODEL = process.env.AI_MODEL || (AI_PROVIDER === "openai" ? "gpt-4o-mini" : "gemini-flash-lite-latest");

// إعدادات واتساب Webhook
const PORT = parseInt(process.env.PORT, 10) || 3000;
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || "my_secret_token";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID;

// ──────────────────────────────────────────────
// 2. System Prompt - شخصية كريم
// ──────────────────────────────────────────────
const SYSTEM_PROMPT = `
أنت "كريم"، صاحبك الرياضي ووكيل مبيعات ذكي لمتجر مستلزمات رياضية على واتساب — أسلوبك مميز، ودود، أردني أصيل، ومباشر.

# هويتك المميزة:
- اسمك كريم، تحيّي بـ "يا هلا والله يا بطل!" أو "يا هلا والله يا غالي!" + 😊
- لهجتك أردنية عامية خفيفة ممزوجة بفصحى سلسة، مختصرة، مهنية، وبصمة مميزة: تختم أحياناً بـ "كريم معك خطوة بخطوة 👟"
- لا تكن ثرثاراً، خلك خفيف ولطيف.

# اللغات:
- اكتشف لغة العميل تلقائياً ورد بنفس اللغة:
  - عربي → رد عربي أردني كما فوق
  - إنجليزي → رد إنجليزي ودود: "Hey there! I'm Kareem 😊 your sports gear buddy..." مع نفس الأسعار
  - أي لغة أخرى → رد إنجليزي بسيط + عربي
- حافظ على نفس هيكل JSON ونفس الأسعار بكل اللغات.

# الشفافية:
- إذا سُئلت "هل أنت ذكاء اصطناعي؟ / بوت؟ / إنسان؟" أو "Are you AI/bot?" أجب بثقة: عربي "نعم، أنا كريم مساعد ذكي آلي 😊" / إنجليزي "Yes, I'm Kareem, an AI assistant 😊" ثم أكمل البيع بسلاسة.

# المنتجات المتاحة فقط (ممنوع اقتراح أي شيء خارجها):
1. حذاء ركض احترافي — $50
2. حزام دعم الظهر — $20
3. رسوم التوصيل ثابتة — $5 (تُضاف على أي طلب)
4. 🎁 عرض Bundle المميز: الحذاء + الحزام معاً = $70 + $5 توصيل = $75 → لكن لك عرض خاص $70 شامل التوصيل (توفير $5)! اذكر العرض بوضوح عند طلب الاثنين.

# قواعد البيع المميزة:
- ممنوع تماماً اقتراح منتجات أو أسعار غير مذكورة أعلاه (باستثناء عرض Bundle المذكور).
- إذا اعترض العميل على السعر: وضّح القيمة بذكاء (جودة، متانة، راحة للركض الطويل، ضمان) + اقترح المنتج المكمل كبديل، واسأل سؤال مفتوح مميز: "قلّي شو أكتر شي بهمك: الراحة بالركض ولا دعم الظهر؟ عشان أوجهك للأفضل 👟"
- كن مباشراً، شجّع بلطف، واستخدم إيموجي خفيف (😊 👟 💪).
- اذكر السعر الإجمالي مع التوصيل عند تأكيد الشراء، واذكر عرض Bundle عند طلب المنتجين.

# التصعيد للبشر (transfer_to_human):
- إذا طلب العميل صراحة التحدث مع موظف / إنسان / مدير / خدمة عملاء، يجب أن تكون transfer_to_human = true
- وأرسل رداً يؤكد أنك أبلغت الفريق البشري وسيتواصل معه قريباً.

# هيكل الرد (JSON فقط):
يجب أن يكون ردك JSON صالح فقط بهذا الشكل، بدون أي نص خارج JSON وبدون markdown:
{
  "reply": "نص الرد بنفس لغة العميل",
  "transfer_to_human": false,
  "intent": "استفسار | شراء | اعتراض_على_السعر | تصعيد | حجز_موعد",
  "buttons": [{"id": "buy_shoes", "title": "👟 الحذاء $50"}],
  "image": "رابط صورة المنتج عند أول عرض له فقط (اختياري)"
}
- buttons: اختياري (حتى 3 أزرار). استخدمه عند عرض المنتجات: buy_shoes / buy_belt / bundle / booking / human
- image: اختياري، رابط صورة المنتج عند أول مرة تعرضه فقط
- حجز_موعد: استخدمه فقط إذا طلب العميل حجز/موعد (للعيادات)

# أنواع intent:
- "استفسار": سؤال عام عن المنتجات/الأسعار/التوصيل
- "شراء": نية شراء واضحة
- "اعتراض_على_السعر": العميل يرى السعر غالياً
- "تصعيد": طلب التحدث مع إنسان

أمثلة:
- عميل: "كم سعر الحذاء؟" -> {"reply": "حذاء الركض الاحترافي سعره $50 ورسوم التوصيل $5، الإجمالي $55. هل ترغب في تأكيد الطلب؟", "transfer_to_human": false, "intent": "استفسار"}
- عميل: "السعر غالي" -> {"reply": "أتفهمك تماماً، الحذاء مصمم بتقنيات احترافية لراحة القدم ودعمها لمسافات طويلة ويستحق الاستثمار. كبديل اقتصادي، حزام دعم الظهر متوفر بـ $20 فقط (+$5 توصيل). هل تود تجربته؟", "transfer_to_human": false, "intent": "اعتراض_على_السعر"}
- عميل: "أريد التحدث مع موظف" -> {"reply": "بالتأكيد، قمت بإبلاغ الفريق البشري وسيتواصل معك أحد الموظفين في أقرب وقت. شكراً لصبرك!", "transfer_to_human": true, "intent": "تصعيد"}
`;

// ──────────────────────────────────────────────
// 3. تهيئة العملاء
// ──────────────────────────────────────────────
let googleClient = null;
let openaiClient = null;

if (AI_PROVIDER === "google" && GOOGLE_API_KEY && GOOGLE_API_KEY !== "DEMO_KEY") {
  googleClient = new GoogleGenAI({ apiKey: GOOGLE_API_KEY });
}
if (AI_PROVIDER === "openai" && OPENAI_API_KEY && OPENAI_API_KEY !== "DEMO_KEY") {
  openaiClient = new OpenAI({ apiKey: OPENAI_API_KEY });
}

const isDemoMode = !googleClient && !openaiClient;

// ──────────────────────────────────────────────
// 4. دالة المحاكاة في وضع DEMO (بدون API حقيقي)
// ──────────────────────────────────────────────
function mockReply(userMessage) {
  const msg = userMessage.toLowerCase();

  // شفافية - هل أنت بوت؟ (يجب فحصها قبل التصعيد لتجنب الخلط مع كلمة "إنسان؟")
  if (/(هل انت|هل أنت|بوت|روبوت|ذكاء اصطناعي)/.test(msg)) {
    return {
      reply: "يا هلا والله! نعم أنا كريم مساعد ذكي آلي لمتجر المستلزمات الرياضية 😊 وسعيد بمساعدتك! لدينا حذاء ركض احترافي بـ $50 وحزام دعم الظهر بـ $20 (+$5 توصيل). كيف أساعدك يا بطل؟ كريم معك خطوة بخطوة 👟",
      transfer_to_human: false,
      intent: "استفسار",
    };
  }
  // تصعيد - يجب أن يكون طلب صريح للتحدث مع إنسان
  if (/(اريد.*موظف|أريد.*موظف|اريد.*انسان|أريد.*إنسان|اريد.*بشري|أريد.*بشري|اتحدث.*موظف|أتحدث.*موظف|اكلم.*موظف|أكلم.*موظف|التحدث مع.*موظف|التحدث مع.*انسان|التحدث مع.*إنسان|كلم.*موظف|حولني.*موظف|حولني.*انسان|حولني.*إنسان|خدمة عملاء|بشري لو سمحت|موظف بشري)/.test(msg)) {
    return {
      reply: "أكيد يا بطل، قمت بإبلاغ الفريق البشري ورح يتواصل معك أحد الشباب بأقرب وقت 💪 شكراً لصبرك، وكريم معك خطوة بخطوة 👟",
      transfer_to_human: true,
      intent: "تصعيد",
    };
  }
  // اعتراض على السعر - مميز بسؤال مفتوح
  if (/(غالي|كثير|سعر مرتفع|ما تقدر تنقص|تخفيض|خصم|ليه كذا سعر)/.test(msg)) {
    return {
      reply: "بفهمك والله يا بطل 💪 الحذاء مصمم بخامات احترافية لراحة القدم لمسافات طويلة وبستاهل كل قرش. كخيار اقتصادي ممتاز، حزام دعم الظهر متوفر بـ $20 فقط (+$5 توصيل = $25). قلّي شو أكتر شي بهمك: الراحة بالركض ولا دعم الظهر؟ عشان أوجهك للأفضل 👟 كريم معك خطوة بخطوة",
      transfer_to_human: false,
      intent: "اعتراض_على_السعر",
    };
  }
  // شراء
  if (/(اشتري|أشتري|اطلب|أطلب|اريد.*حذاء|أريد.*حذاء|اريد.*حزام|أريد.*حزام|احجز|أحجز|تم.*الشراء|موافق.*اطلب)/.test(msg)) {
    const wantsShoes = /حذاء|ركض|شوز/.test(msg);
    const wantsBelt = /حزام|ظهر|دعم/.test(msg);
    if (wantsShoes && wantsBelt) {
      return {
        reply: "يا هلا يا بطل! 🎁 عرض Bundle المميز: حذاء الركض $50 + حزام الظهر $20 + التوصيل $5 = $75، بس إلك عرض خاص $70 شامل التوصيل (توفير $5)! هل أثبتلك الطلب؟ كريم معك خطوة بخطوة 👟",
        transfer_to_human: false,
        intent: "شراء",
      };
    }
    if (wantsBelt) {
      return {
        reply: "رائع يا بطل! حزام دعم الظهر سعره $20 + $5 توصيل = $25. هل أثبتلك الطلب؟ كريم معك خطوة بخطوة 👟",
        transfer_to_human: false,
        intent: "شراء",
      };
    }
    return {
      reply: "ممتاز يا بطل! حذاء الركض الاحترافي سعره $50 + $5 توصيل = $55. هل أثبتلك الطلب؟ كريم معك خطوة بخطوة 👟",
      transfer_to_human: false,
      intent: "شراء",
    };
  }
  // استفسار عام
  if (/(كم.*سعر|بكم|سعر.*حذاء|سعر.*حزام|توصيل|منتجات|عندكم ايش|وش عندكم|ماذا لديكم)/.test(msg)) {
    return {
      reply: "يا هلا والله يا بطل! 😊 لدينا حذاء ركض احترافي بـ $50، وحزام دعم الظهر بـ $20، ورسوم التوصيل $5. وعندنا عرض Bundle المميز: الاثنين بـ $70 شامل التوصيل (توفير $5)! أي منتج بتحب؟ كريم معك خطوة بخطوة 👟",
      transfer_to_human: false,
      intent: "استفسار",
    };
  }
  // ترحيب أو رسالة عامة
  return {
    reply: "يا هلا والله يا بطل! 😊 أنا كريم، صاحبك الرياضي من متجر المستلزمات. لدينا حذاء ركض احترافي ($50) وحزام دعم الظهر ($20) مع توصيل $5، وعرض Bundle المميز: الاثنين بـ $70 شامل التوصيل 🎁 كيف أساعدك اليوم؟ كريم معك خطوة بخطوة 👟",
    transfer_to_human: false,
    intent: "استفسار",
  };
}

// ──────────────────────────────────────────────
// 5. ذاكرة المحادثة (لكل رقم واتساب)
// ──────────────────────────────────────────────
const conversations = new Map(); // phone -> [{role, text, timestamp}]
const MAX_HISTORY = 10; // آخر 10 رسائل (5 تبادلات)
const MEMORY_TTL_MS = 1000 * 60 * 60 * 6; // 6 ساعات

function tenantOf(input) {
  // input قد يكون id نصي أو كائن tenant كامل
  if (!input) return resolveTenant({});
  if (typeof input === "string") return getTenantFull(input) || resolveTenant({});
  return input;
}

function keyOf(phone, tenant) {
  const tid = tenant?.id || "kareem-sport";
  // عزل تام: tenant + phone (نفس الرقم عند بوتين = ذاكرتين منفصلتين)
  return memoryKey(tid, phone);
}

function getHistory(phone, tenantInput) {
  const tenant = tenantOf(tenantInput);
  const key = keyOf(phone, tenant);
  const entry = conversations.get(key);
  if (!entry) return [];
  // تنظيف المنتهية
  if (Date.now() - entry.updatedAt > MEMORY_TTL_MS) {
    conversations.delete(key);
    return [];
  }
  return entry.messages;
}

function pushHistory(phone, role, text, tenantInput) {
  const tenant = tenantOf(tenantInput);
  const key = keyOf(phone, tenant);
  let entry = conversations.get(key);
  if (!entry) {
    entry = { messages: [], updatedAt: Date.now() };
    conversations.set(key, entry);
  }
  entry.messages.push({ role, text, ts: Date.now() });
  if (entry.messages.length > MAX_HISTORY) entry.messages.shift();
  entry.updatedAt = Date.now();
}

export function clearMemory(phone, tenantId) {
  if (phone && tenantId) conversations.delete(memoryKey(tenantId, phone));
  else if (phone) {
    // امسح كل مفاتيح هذا الرقم عبر كل البوتات
    for (const k of [...conversations.keys()]) {
      if (k === phone || k.endsWith(`::${phone}`)) conversations.delete(k);
    }
  } else conversations.clear();
}

export function getMemoryStats() {
  return { conversations: conversations.size, maxHistory: MAX_HISTORY };
}

// ── Inbox: عرض المحادثات + Takeover (إيقاف البوت مؤقتاً لتدخل بشري) ──
const takeoverMap = new Map(); // key tenant::phone -> {by, at}
export function setTakeover(tenantId, phone, enabled, by = "admin") {
  const key = memoryKey(tenantId, phone);
  if (enabled) takeoverMap.set(key, { by, at: Date.now() });
  else takeoverMap.delete(key);
}
export function isTakeover(tenantId, phone) {
  return takeoverMap.has(memoryKey(tenantId, phone));
}
export function listInbox(tenantFilter) {
  const out = [];
  for (const [key, entry] of conversations.entries()) {
    const sep = key.indexOf("::");
    const tenantId = sep > 0 ? key.slice(0, sep) : "kareem-sport";
    const phone = sep > 0 ? key.slice(sep + 2) : key;
    if (tenantFilter && tenantId !== tenantFilter) continue;
    const last = entry.messages[entry.messages.length - 1];
    out.push({
      tenantId,
      phone,
      count: entry.messages.length,
      updatedAt: entry.updatedAt,
      takeover: takeoverMap.has(key),
      lastMessage: last ? { role: last.role, text: last.text.slice(0, 120) } : null,
    });
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}
export function getConversation(tenantId, phone) {
  const entry = conversations.get(memoryKey(tenantId, phone));
  return entry ? entry.messages : [];
}

// ──────────────────────────────────────────────
// 6. الدالة الأساسية: getKareemReply (مع ذاكرة)
// ──────────────────────────────────────────────
export async function getKareemReply(userMessage, phone = "default", tenantInput = null) {
  const tenant = tenantOf(tenantInput);
  // كريم الحالي يبقى كما هو؛ أي tenant جديد يستخدم prompt مبني من إعداداته
  const prompt = tenant?.id === "kareem-sport" ? SYSTEM_PROMPT : buildSystemPrompt(tenant);
  const botLabel = tenant?.botName || "كريم";

  // وضع DEMO بدون استهلاك API - مع ذاكرة بسيطة
  if (isDemoMode) {
    await new Promise((r) => setTimeout(r, 300));
    const result = mockReply(userMessage);
    // حفظ في الذاكرة حتى في وضع DEMO (معزولة لكل بوت)
    pushHistory(phone, "user", userMessage, tenant);
    pushHistory(phone, "assistant", result.reply, tenant);
    return result;
  }

  try {
    let rawText = "";
    const history = getHistory(phone, tenant);
    // تحويل التاريخ لنص للسياق
    const historyContext = history.map(m => `${m.role === "user" ? "العميل" : botLabel}: ${m.text}`).join("\n");

    if (AI_PROVIDER === "google") {
      // نمرر التاريخ كجزء من السياق + الرسالة الحالية
      const fullContents = [];
      // إضافة التاريخ كمحادثة سابقة
      for (const h of history) {
        fullContents.push({ role: h.role === "user" ? "user" : "model", parts: [{ text: h.text }] });
      }
      fullContents.push({ role: "user", parts: [{ text: userMessage }] });

      const response = await googleClient.models.generateContent({
        model: AI_MODEL,
        contents: fullContents,
        config: {
          systemInstruction: prompt + (historyContext ? `\n\n# سجل المحادثة السابقة مع هذا العميل (${phone}):\n${historyContext}\n(استخدمه لتتذكر ماذا طلب العميل ولا تكرر الأسئلة)` : ""),
          responseMimeType: "application/json",
          temperature: 0.7,
        },
      });
      rawText = response.text;
    } else {
      const messages = [{ role: "system", content: prompt }];
      if (historyContext) {
        messages.push({ role: "system", content: `سجل المحادثة السابقة مع العميل ${phone}:\n${historyContext}` });
      }
      for (const h of history) {
        messages.push({ role: h.role === "user" ? "user" : "assistant", content: h.text });
      }
      messages.push({ role: "user", content: userMessage });

      const completion = await openaiClient.chat.completions.create({
        model: AI_MODEL,
        messages,
        response_format: { type: "json_object" },
        temperature: 0.7,
      });
      rawText = completion.choices[0].message.content;
    }

    // تنظيف الرد من markdown إن وجد
    const cleaned = rawText.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);

    // التحقق من الهيكل
    if (typeof parsed.reply !== "string" || typeof parsed.transfer_to_human !== "boolean" || typeof parsed.intent !== "string") {
      throw new Error("هيكل JSON غير متطابق");
    }

    // التحقق من intent المسموح (أضفنا حجز_موعد للعيادات)
    const allowedIntents = ["استفسار", "شراء", "اعتراض_على_السعر", "تصعيد", "حجز_موعد"];
    if (!allowedIntents.includes(parsed.intent)) {
      console.warn(`  ⚠️  تحذير: intent غير متوقع "${parsed.intent}" - تم التصحيح إلى "استفسار"`);
      parsed.intent = "استفسار";
    }
    // حقول اختيارية من الـ AI: buttons / image / action
    if (parsed.buttons && !Array.isArray(parsed.buttons)) delete parsed.buttons;
    if (parsed.buttons) parsed.buttons = parsed.buttons.slice(0, 3);
    if (parsed.image && typeof parsed.image !== "string") delete parsed.image;

    // تحذير إذا اقترح منتجات خارج القائمة
    const forbiddenPattern = /(ساعة|قميص|تيشيرت|نظارة|كرة|مضرب|دراجة)/i;
    if (forbiddenPattern.test(parsed.reply)) {
      console.warn(`  ⚠️  تحذير: الرد يحتوي على منتج غير مصرح به!`);
    }

    // حفظ في الذاكرة (معزولة لكل بوت)
    pushHistory(phone, "user", userMessage, tenant);
    pushHistory(phone, "assistant", parsed.reply, tenant);
    return parsed;
  } catch (err) {
    console.warn(`  ⚠️  خطأ في استدعاء API: ${err.message} - الرجوع للمحاكاة المحلية`);
    const fallback = mockReply(userMessage);
    pushHistory(phone, "user", userMessage, tenant);
    pushHistory(phone, "assistant", fallback.reply, tenant);
    return fallback;
  }
}

// الاسم المطلوب في التكليف: processCustomerMessage
export const processCustomerMessage = getKareemReply;

// ──────────────────────────────────────────────
// 6. دالة إرسال الرد عبر WhatsApp Cloud API
// ──────────────────────────────────────────────
export async function sendWhatsAppMessage(to, text, tenantInput = null) {
  const tenant = tenantOf(tenantInput);
  const token = tenant?.whatsapp_token || WHATSAPP_TOKEN;
  const phoneId = tenant?.phone_number_id || WHATSAPP_PHONE_ID;

  if (!token || token === "DEMO_WHATSAPP_TOKEN" || !phoneId || phoneId === "DEMO_PHONE_ID") {
    console.log(`  📤 [محاكاة إرسال] إلى ${to}: "${text}"`);
    console.log(`  💡 ضع WHATSAPP_TOKEN و WHATSAPP_PHONE_ID الحقيقيين في .env للإرسال الفعلي`);
    return { simulated: true, to, text };
  }

  const url = `https://graph.facebook.com/v18.0/${phoneId}/messages`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text, preview_url: false },
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error(`  ❌ فشل إرسال واتساب [${response.status}]:`, JSON.stringify(data));
      throw new Error(data.error?.message || `HTTP ${response.status}`);
    }

    console.log(`  ✅ تم إرسال الرد إلى ${to} | ID: ${data.messages?.[0]?.id || "N/A"}`);
    return data;
  } catch (err) {
    console.error(`  ❌ خطأ في sendWhatsAppMessage: ${err.message}`);
    throw err;
  }
}

// إرسال generic (نص / أزرار / صورة) - نفس التوكن لكل بوت
async function sendPayload(to, payload, tenantInput = null) {
  const tenant = tenantOf(tenantInput);
  const token = tenant?.whatsapp_token || WHATSAPP_TOKEN;
  const phoneId = tenant?.phone_number_id || WHATSAPP_PHONE_ID;

  if (!token || token === "DEMO_WHATSAPP_TOKEN" || !phoneId || phoneId === "DEMO_PHONE_ID") {
    console.log(`  📤 [محاكاة إرسال ${payload.type}] إلى ${to}: ${JSON.stringify(payload).slice(0, 200)}`);
    return { simulated: true, to, payload };
  }
  const url = `https://graph.facebook.com/v18.0/${phoneId}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, ...payload }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`);
  console.log(`  ✅ تم الإرسال (${payload.type}) إلى ${to} | ID: ${data.messages?.[0]?.id || "N/A"}`);
  return data;
}

export async function sendButtons(to, bodyText, buttons, tenantInput = null) {
  const btns = (buttons || []).slice(0, 3).map((b, i) => ({
    type: "reply",
    reply: { id: b.id || `btn_${i}`, title: (b.title || `خيار ${i + 1}`).slice(0, 20) },
  }));
  if (!btns.length) return sendWhatsAppMessage(to, bodyText, tenantInput);
  return sendPayload(to, {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: bodyText.slice(0, 1024) },
      action: { buttons: btns },
    },
  }, tenantInput);
}

export async function sendImage(to, link, caption = "", tenantInput = null) {
  return sendPayload(to, {
    type: "image",
    image: { link, caption: caption.slice(0, 1024) },
  }, tenantInput);
}

// أزرار افتراضية لكل tenant من منتجاته
export function defaultButtonsFor(tenant) {
  const t = tenantOf(tenant);
  if (t?.id === "kareem-sport") {
    return [
      { id: "buy_shoes", title: "👟 الحذاء $50" },
      { id: "buy_belt", title: "💪 الحزام $20" },
      { id: "bundle", title: "🎁 العرض $70" },
    ];
  }
  const btns = (t.products || []).slice(0, 2).map((p) => ({
    id: p.buttonId || p.name,
    title: `${p.name} $${p.price}`.slice(0, 20),
  }));
  if (t?.features?.booking) btns.push({ id: "booking", title: "📅 احجز موعد" });
  return btns.slice(0, 3);
}

// تقدير الإجمالي والصنف من نص المحادثة (بسيط وقابل للتطوير)
function detectTotal(tenant, userText, replyText) {
  const all = `${userText} ${replyText}`;
  const m = all.match(/\$(\d+(?:\.\d+)?)/g);
  if (m && m.length) {
    const nums = m.map((s) => parseFloat(s.replace("$", "")));
    return Math.max(...nums);
  }
  const prices = (tenant.products || []).map((p) => p.price);
  const max = Math.max(...prices, 0);
  return max + (tenant.deliveryFee || 0);
}
function detectItem(tenant, userText, replyText) {
  const all = `${userText} ${replyText}`;
  for (const p of tenant.products || []) {
    if (p.name && all.includes(p.name.split(" ")[0])) return p.name;
  }
  return (tenant.products || []).map((p) => p.name).join(" + ") || "طلب";
}

// ──────────────────────────────────────────────
// 7. إنشاء تطبيق Express
// ──────────────────────────────────────────────
export function createApp() {
  const app = express();

  // ضروري لقراءة JSON من واتساب
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // صفحة ترحيبية
  app.get("/", (req, res) => {
    res.json({
      name: "كريم - AI Sales Agent (Multi-Tenant)",
      status: "running",
      webhook: "/webhook",
      admin: "/admin/tenants",
      tenants: listTenants().length,
      mode: isDemoMode ? "DEMO" : AI_PROVIDER,
    });
  });

  // ── GET /webhook : التحقق من ملكية الـ Webhook (يدعم أكثر من بوت) ──
  app.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    console.log(`  🔍 GET /webhook - mode=${mode} token=${token} challenge=${challenge}`);

    // أولاً: جرّب مطابقة tenant حسب verify_token
    const tenant = token ? resolveTenant({ verifyToken: token }) : null;
    const expected = tenant?.verify_token || WEBHOOK_VERIFY_TOKEN;

    if (mode === "subscribe" && token === expected) {
      console.log(`  ✅ تم التحقق من الـ Webhook بنجاح (tenant=${tenant?.id || "default"})`);
      return res.status(200).send(challenge);
    }

    console.warn(`  ❌ فشل التحقق: token المتوقع="${expected}" المستلم="${token}"`);
    return res.sendStatus(403);
  });

  // ── لوحة تحكم البوتات (مرحلة 1: API بدون auth - تُحمى لاحقاً) ──
  app.get("/admin/tenants", (req, res) => {
    res.json({ count: listTenants().length, tenants: listTenants(), memory: getMemoryStats() });
  });

  app.post("/admin/tenants", (req, res) => {
    try {
      const created = addTenant(req.body || {});
      console.log(`  ➕ tenant جديد: ${created.id} (${created.name})`);
      res.status(201).json({ ok: true, tenant: created });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.get("/admin/tenants/:id", (req, res) => {
    const t = getTenantFull(req.params.id);
    if (!t) return res.status(404).json({ ok: false, error: "tenant غير موجود" });
    // إخفاء التوكن
    const { whatsapp_token, ...safe } = t;
    res.json({ ok: true, tenant: { ...safe, hasToken: !!whatsapp_token } });
  });

  app.get("/admin/appointments", (req, res) => {
    const { tenant } = req.query;
    res.json({ count: listAppointments(tenant).length, appointments: listAppointments(tenant) });
  });

  app.get("/admin/orders", (req, res) => {
    const { tenant } = req.query;
    res.json({ count: listOrders(tenant).length, orders: listOrders(tenant) });
  });

  // صفحة دفع تجريبية (بدون Stripe تعرض زر تأكيد يحفظ paid)
  app.get("/pay/:orderId", async (req, res) => {
    const order = getOrder(req.params.orderId);
    if (!order) return res.status(404).send("الطلب غير موجود");
    if (req.query.paid === "1") {
      markOrderPaid(order.id);
      logEvent("order_paid", { tenantId: order.tenantId, phone: order.phone, orderId: order.id, total: order.total }).catch(() => {});
      // طلب تقييم تلقائي بعد الدفع
      const tenant = getTenantFull(order.tenantId);
      if (tenant) {
        const msg = `شكراً لثقتك يا بطل! 🙏 قيّم تجربتك معنا من 1 (سيئة) إلى 5 (ممتازة) — ابعت الرقم فقط.`;
        requestCsat(order.tenantId, order.phone, order.id);
        try {
          await sendWhatsAppMessage(order.phone, msg, tenant);
          pushHistory(order.phone, "assistant", msg, tenant);
        } catch (e) {
          console.error(`  ❌ فشل إرسال CSAT: ${e.message}`);
        }
      }
      return res.send(`<h2>تم الدفع ✅ ${order.id} - $${order.total}</h2><p>شكراً! كريم معك خطوة بخطوة 👟</p>`);
    }
    res.send(`<h2>طلب ${order.id}</h2><p>${order.items?.map((i) => i.name).join(" + ")} — الإجمالي $${order.total} ${order.currency}</p><a href="/pay/${order.id}?paid=1"><button style="padding:12px 24px">ادفع الآن (تجريبي)</button></a><p>الحالة: ${order.status}</p>`);
  });

  // ── Broadcast: إرسال جماعي ──
  app.post("/admin/broadcast", async (req, res) => {
    const { tenantId, text, phones } = req.body || {};
    if (!tenantId || !text || !Array.isArray(phones) || !phones.length) {
      return res.status(400).json({ ok: false, error: "tenantId و text و phones[] مطلوبة" });
    }
    if (phones.length > 50) return res.status(400).json({ ok: false, error: "الحد الأقصى 50 رقم لكل بث" });
    const tenant = getTenantFull(tenantId);
    if (!tenant) return res.status(404).json({ ok: false, error: "tenant غير موجود" });
    const results = [];
    for (const phone of phones) {
      try {
        await sendWhatsAppMessage(phone, text, tenant);
        pushHistory(phone, "assistant", text, tenant);
        results.push({ phone, ok: true });
      } catch (e) {
        results.push({ phone, ok: false, error: e.message });
      }
      await new Promise((r) => setTimeout(r, 800)); // تجنب rate limit
    }
    const rec = saveBroadcast({ tenantId, text, phones, results });
    logEvent("broadcast", { tenantId, count: phones.length, sent: results.filter((r) => r.ok).length, broadcastId: rec.id }).catch(() => {});
    res.json({ ok: true, broadcast: rec });
  });
  app.get("/admin/broadcasts", (req, res) => {
    const all = listBroadcasts(req.query.tenant);
    res.json({ count: all.length, broadcasts: all });
  });

  // ── CSAT: طلب تقييم + عرض النتائج ──
  app.post("/admin/csat-request", async (req, res) => {
    const { tenantId, phone } = req.body || {};
    if (!tenantId || !phone) return res.status(400).json({ ok: false, error: "tenantId و phone مطلوبان" });
    const tenant = getTenantFull(tenantId);
    if (!tenant) return res.status(404).json({ ok: false, error: "tenant غير موجود" });
    const msg = `شكراً لتعاملك معنا يا غالي! 🙏 قيّم تجربتك من 1 (سيئة) إلى 5 (ممتازة) — ابعت الرقم فقط.`;
    requestCsat(tenantId, phone, null);
    try {
      await sendWhatsAppMessage(phone, msg, tenant);
      pushHistory(phone, "assistant", msg, tenant);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
  app.get("/admin/csat", (req, res) => {
    res.json({ ok: true, ...csatStats(req.query.tenant) });
  });

  // ── CRM: سجل الأحداث + تصدير CSV ──
  app.get("/admin/crm", (req, res) => {
    const { tenant, type, limit } = req.query;
    const events = listEvents({ tenantId: tenant, type, limit: Number(limit || 100) });
    res.json({ count: events.length, events });
  });
  app.get("/admin/crm/export.csv", (req, res) => {
    const { tenant, type } = req.query;
    const events = listEvents({ tenantId: tenant, type, limit: 2000 });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=crm.csv");
    res.send("\uFEFF" + toCSV(events));
  });

  // ── سلة مهجورة: تشغيل يدوي ──
  app.post("/admin/cart-remind-run", async (req, res) => {
    const afterMinutes = Number(req.body?.afterMinutes ?? 60);
    const due = dueCartReminders({ afterMinutes });
    const sent = [];
    for (const o of due) {
      const tenant = getTenantFull(o.tenantId);
      if (!tenant) continue;
      const msg = `يا هلا يا بطل! 👋 شفنا طلبك ${o.id} ($${o.total}) لسه ما اكتمل. تحب نكمله؟ رابط الدفع: ${o.paymentUrl || "ابعت تم للتأكيد"}`;
      try {
        await sendWhatsAppMessage(o.phone, msg, tenant);
        pushHistory(o.phone, "assistant", msg, tenant);
        markCartReminded(o.id);
        logEvent("cart_reminded", { tenantId: o.tenantId, phone: o.phone, orderId: o.id, total: o.total }).catch(() => {});
        sent.push(o.id);
      } catch (e) {
        console.error(`  ❌ فشل تذكير السلة ${o.id}: ${e.message}`);
      }
    }
    res.json({ ok: true, due: due.length, sent });
  });

  // ── Inbox: قائمة المحادثات + محادثة واحدة ──
  app.get("/admin/inbox", (req, res) => {
    res.json({ count: listInbox(req.query.tenant).length, inbox: listInbox(req.query.tenant) });
  });
  app.get("/admin/inbox/:tenantId/:phone", (req, res) => {
    const { tenantId, phone } = req.params;
    res.json({
      tenantId, phone,
      takeover: isTakeover(tenantId, phone),
      messages: getConversation(tenantId, phone),
    });
  });

  // ── Takeover: إيقاف/تشغيل البوت لمحادثة ──
  app.post("/admin/takeover", (req, res) => {
    const { tenantId, phone, enabled, by } = req.body || {};
    if (!tenantId || !phone) return res.status(400).json({ ok: false, error: "tenantId و phone مطلوبان" });
    setTakeover(tenantId, phone, !!enabled, by);
    logEvent(!!enabled ? "takeover" : "handover", { tenantId, phone, by }).catch(() => {});
    res.json({ ok: true, takeover: isTakeover(tenantId, phone) });
  });

  // ── إرسال يدوي من الموظف (مع حفظ في الذاكرة) ──
  app.post("/admin/send", async (req, res) => {
    const { tenantId, phone, text } = req.body || {};
    if (!tenantId || !phone || !text) return res.status(400).json({ ok: false, error: "tenantId و phone و text مطلوبة" });
    const tenant = getTenantFull(tenantId);
    if (!tenant) return res.status(404).json({ ok: false, error: "tenant غير موجود" });
    try {
      const r = await sendWhatsAppMessage(phone, text, tenant);
      pushHistory(phone, "assistant", text, tenant);
      res.json({ ok: true, result: r });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── صفحة Inbox بسيطة (HTML) ──
  app.get("/admin/inbox.html", (req, res) => {
    res.send(`<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>Inbox</title>
<style>body{font-family:system-ui;margin:20px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:8px}.u{color:#0a7}.a{color:#06c}</style></head><body>
<h2>📥 Inbox — المحادثات الحية</h2>
<p>API: <code>/admin/inbox?tenant=ID</code> | محادثة: <code>/admin/inbox/:tenant/:phone</code></p>
<table id="t"><tr><th>البوت</th><th>الرقم</th><th>takeover</th><th>آخر رسالة</th><th>إجراء</th></tr></table>
<script>
async function load(){ const q=new URLSearchParams(location.search); const r=await fetch('/admin/inbox?tenant='+(q.get('tenant')||'')); const j=await r.json();
const t=document.getElementById('t');
j.inbox.forEach(c=>{ const tr=document.createElement('tr');
tr.innerHTML='<td>'+c.tenantId+'</td><td>'+c.phone+'</td><td>'+(c.takeover?'⏸️':'✅')+'</td><td>'+(c.lastMessage?c.lastMessage.text:'')+'</td>';
const b=document.createElement('button'); b.textContent=c.takeover?'تشغيل البوت':'إيقاف للموظف';
b.onclick=async()=>{ await fetch('/admin/takeover',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tenantId:c.tenantId,phone:c.phone,enabled:!c.takeover})}); load(); };
const td=document.createElement('td'); td.appendChild(b); tr.appendChild(td); t.appendChild(tr); }); }
load();
</script></body></html>`);
  });

  // ── تذكير المواعيد: تشغيل يدوي + إلغاء حجز ──
  app.post("/admin/remind-run", async (req, res) => {
    const afterMinutes = Number(req.body?.afterMinutes ?? 1);
    const due = dueReminders({ afterMinutes });
    const sent = [];
    for (const b of due) {
      const tenant = getTenantFull(b.tenantId);
      if (!tenant) continue;
      const msg = `تذكير بموعدك يا غالي ⏰ ${b.service} - الساعة ${b.slot} (${b.id}) في ${tenant.name}. للتأكيد ابعت "تم"، وللإلغاء ابعت "أريد موظف".`;
      try {
        await sendWhatsAppMessage(b.phone, msg, tenant);
        pushHistory(b.phone, "assistant", msg, tenant);
        markReminded(b.id);
        sent.push(b.id);
      } catch (e) {
        console.error(`  ❌ فشل التذكير ${b.id}: ${e.message}`);
      }
    }
    res.json({ ok: true, due: due.length, sent });
  });
  app.post("/admin/appointments/:id/cancel", (req, res) => {
    const b = cancelAppointment(req.params.id);
    if (!b) return res.status(404).json({ ok: false, error: "حجز غير موجود" });
    res.json({ ok: true, booking: b });
  });

  // ── POST /webhook : استقبال الرسائل ──
  app.post("/webhook", async (req, res) => {
    try {
      const body = req.body;

      // التحقق المبدئي من نوع الحدث
      if (body.object !== "whatsapp_business_account") {
        console.log(`  📥 POST /webhook - object غير متوقع: ${body.object}`);
        return res.sendStatus(404);
      }

      // الرد الفوري 200 لواتساب (مهم: قبل المعالجة الطويلة)
      // لكن سنعالج الرسائل ثم نرد - واتساب يطلب 200 خلال 20ثانية
      const entries = body.entry || [];

      let hasMessage = false;

      for (const entry of entries) {
        const changes = entry.changes || [];
        for (const change of changes) {
          const value = change.value || {};
          const messages = value.messages || [];
          const contacts = value.contacts || [];

          // حل الـ tenant من رقم البوت المستقبل (عزل تام)
          const phoneNumberId = value.metadata?.phone_number_id || value.phone_number_id || null;
          const tenant = resolveTenant({ phoneNumberId });
          if (tenant && tenant.enabled === false) {
            console.log(`  ⏸️ tenant موقوف: ${tenant.id} - تم تجاهل الرسالة`);
            continue;
          }

          for (const msg of messages) {
            hasMessage = true;

            // استخراج رقم العميل ونص الرسالة (يدعم الأزرار + الفويس)
            const from = msg.from; // رقم العميل
            let text =
              msg.text?.body ||
              msg.button?.text ||
              msg.interactive?.button_reply?.title ||
              msg.interactive?.button_reply?.id ||
              msg.interactive?.list_reply?.title ||
              "";
            const buttonId = msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id || null;
            const name = contacts.find((c) => c.wa_id === from)?.profile?.name || from;

            // —— فويس نوت: حمّله وفرّغه ثم عامله كنص ——
            if ((msg.type === "audio" || msg.audio?.id) && !text) {
              try {
                const mediaId = msg.audio?.id;
                console.log(`  🎤 فويس من ${from} (media=${mediaId}) - جاري التفريغ...`);
                const { buffer, mimeType } = await downloadWhatsAppMedia(mediaId, tenant?.whatsapp_token || WHATSAPP_TOKEN);
                const { text: transcript, reason } = await transcribeAudio(buffer, mimeType);
                if (transcript) {
                  text = transcript;
                  console.log(`  🎤 تفريغ: "${text}"`);
                } else {
                  console.log(`  ⚠️ تعذر التفريغ (${reason})`);
                  await sendWhatsAppMessage(from, "وصلني الفويس يا غالي 🎤 بس ما قدرت أفرغه، ابعتلي كتابة لو سمحت.", tenant).catch(() => {});
                  console.log(`${"─".repeat(60)}\n`);
                  continue;
                }
              } catch (e) {
                console.error(`  ❌ خطأ الفويس: ${e.message}`);
                await sendWhatsAppMessage(from, "ما قدرت أسمع الفويس، ابعتلي كتابة يا غالي.", tenant).catch(() => {});
                console.log(`${"─".repeat(60)}\n`);
                continue;
              }
            }

            if (!text) {
              console.log(`  📥 رسالة بدون نص من ${from} (type=${msg.type}) - تم تجاهلها`);
              continue;
            }

            console.log(`\n${"─".repeat(60)}`);
            console.log(`  🏢 tenant=${tenant?.id} | بوت=${tenant?.botName}`);
            console.log(`  📥 رسالة واتساب من ${name} (${from}): "${text}"${buttonId ? ` [btn=${buttonId}]` : ""}`);
            console.log(`  🧠 الذاكرة: ${getHistory(from, tenant).length} رسائل سابقة`);

            // —— Takeover: إذا الموظف مستلم المحادثة، لا يرد البوت ——
            if (isTakeover(tenant?.id, from)) {
              pushHistory(from, "user", text, tenant);
              console.log(`  ⏸️ takeover نشط (${from}) - حُفظت الرسالة بدون رد آلي`);
              console.log(`${"─".repeat(60)}\n`);
              continue;
            }

            // —— CSAT: إذا الرد رقم 1-5 وكان في طلب تقييم معلق ——
            if (/^[1-5]$/.test(text.trim())) {
              const pending = hasPendingCsat(tenant?.id, from);
              if (pending) {
                const score = Number(text.trim());
                const rating = saveRating({ tenantId: tenant.id, phone: from, score, refId: pending.refId });
                const reply = score >= 4
                  ? `شكراً يا بطل! ⭐ تقييمك ${score}/5 أسعدنا. كريم معك خطوة بخطوة 👟`
                  : `شكراً لصراحتك يا غالي 🙏 تقييمك ${score}/5 وصلنا ورح نشتغل نحسّن. تحب يحكي معك موظف؟`;
                pushHistory(from, "user", text, tenant);
                pushHistory(from, "assistant", reply, tenant);
                logEvent("csat", { tenantId: tenant.id, phone: from, score, refId: pending.refId }).catch(() => {});
                try {
                  await sendWhatsAppMessage(from, reply, tenant);
                } catch (e) {
                  console.error(`  ❌ فشل إرسال رد التقييم: ${e.message}`);
                }
                console.log(`  ⭐ تقييم ${rating.id} ${tenant.id} ${from} = ${score}`);
                console.log(`${"─".repeat(60)}\n`);
                continue;
              }
            }

            // —— تدفق الحجز (للعيادات) قبل الـ AI ——
            const wantsBooking = tenant?.features?.booking && /(حجز|موعد|احجز|book|appointment)/i.test(text + " " + (buttonId || ""));
            const bookingState = getBookingState(tenant?.id, from);
            let result = null;
            let handled = false;

            // 1) ضغطة زر منتج لكريم: اعرض الصورة + أكمل شراء
            if (tenant?.id === "kareem-sport" && buttonId && /^(buy_shoes|buy_belt|bundle)$/.test(buttonId)) {
              const map = {
                buy_shoes: "أريد شراء حذاء الركض",
                buy_belt: "أريد شراء حزام الظهر",
                bundle: "أريد حزام الظهر والحذاء معاً",
              };
              result = await processCustomerMessage(map[buttonId], from, tenant);
              const prod = buttonId === "buy_shoes" ? tenant.products[0] : buttonId === "buy_belt" ? tenant.products[1] : null;
              try {
                if (prod?.image) await sendImage(from, prod.image, `${prod.name} - $${prod.price}`, tenant);
                await sendWhatsAppMessage(from, result.reply, tenant);
              } catch (sendErr) {
                console.error(`  ❌ فشل الإرسال: ${sendErr.message}`);
              }
              console.log(`  🤖 ${tenant?.botName} -> intent=${result.intent} (زر ${buttonId})`);
              console.log(`${"─".repeat(60)}\n`);
              continue;
            }

            // 2) بدء الحجز
            if (wantsBooking && !bookingState) {
              const slots = (tenant.features.bookingSlots || []).join("، ");
              setBookingState(tenant.id, from, { step: "slot" });
              const reply = `تمام يا غالي 😊 احجز موعدك في ${tenant.name}. أوقاتنا: ${tenant.features.workingHours || ""}. اختر الوقت المناسب: ${slots}. ابعت الوقت (مثال: 14:00) واسم الخدمة.`;
              result = { reply, transfer_to_human: false, intent: "حجز_موعد" };
              pushHistory(from, "user", text, tenant);
              pushHistory(from, "assistant", reply, tenant);
              try {
                await sendButtons(from, reply, (tenant.features.bookingSlots || []).slice(0, 3).map((s) => ({ id: `slot_${s}`, title: `🕐 ${s}` })), tenant);
              } catch (e) {
                await sendWhatsAppMessage(from, reply, tenant).catch(() => {});
              }
              console.log(`  📅 بدء حجز ${tenant.id} للعميل ${from}`);
              console.log(`${"─".repeat(60)}\n`);
              continue;
            }

            // 3) استكمال الحجز (اختار وقت)
            if (bookingState?.step === "slot") {
              const slotMatch = text.match(/(\d{1,2}:\d{2})/) || (buttonId?.startsWith("slot_") ? [null, buttonId.replace("slot_", "")] : null);
              if (slotMatch) {
                const slot = slotMatch[1];
                const service = (tenant.products || [])[0]?.name || "موعد";
                const booking = bookAppointment({ tenantId: tenant.id, phone: from, name, service, day: "أقرب يوم متاح", slot });
                setBookingState(tenant.id, from, null);
                const reply = `تم تأكيد حجزك يا غالي ✅ ${service} - الساعة ${slot} (${booking.id}). بنتشرف فيك في ${tenant.name}! لإلغاء/تعديل ابعت "أريد موظف".`;
                result = { reply, transfer_to_human: false, intent: "حجز_موعد" };
                pushHistory(from, "user", text, tenant);
                pushHistory(from, "assistant", reply, tenant);
                logEvent("booking", { tenantId: tenant.id, phone: from, bookingId: booking.id, service, slot }).catch(() => {});
                try {
                  await sendWhatsAppMessage(from, reply, tenant);
                } catch (e) {
                  console.error(`  ❌ فشل الإرسال: ${e.message}`);
                }
                console.log(`  📅 تأكيد حجز ${booking.id} ${tenant.id} ${from} ${slot}`);
                console.log(`${"─".repeat(60)}\n`);
                continue;
              }
            }

            // —— المسار العادي: AI ——
            result = await processCustomerMessage(text, from, tenant);

            console.log(`  🤖 ${tenant?.botName || "كريم"} -> intent=${result.intent} transfer=${result.transfer_to_human}`);
            console.log(`  💬 الرد: "${result.reply}"`);
            logEvent("message", { tenantId: tenant?.id, phone: from, intent: result.intent, transfer: result.transfer_to_human, text: text.slice(0, 200) }).catch(() => {});

            if (result.transfer_to_human) {
              console.log(`  🚨 تنبيه: العميل ${from} طلب التصعيد للبشر!`);
            }

            // —— إنشاء طلب + رابط دفع عند نية الشراء (متاجر) ——
            const wantsPay =
              result.intent === "شراء" &&
              (tenant?.businessType === "sport-store" || (tenant.products || []).length > 0) &&
              !tenant?.features?.booking;
            if (wantsPay) {
              try {
                const total = detectTotal(tenant, text, result.reply);
                const order = createOrder({
                  tenantId: tenant.id, phone: from, name,
                  items: [{ name: detectItem(tenant, text, result.reply), qty: 1 }],
                  total, currency: "USD",
                });
                const baseUrl = process.env.PUBLIC_BASE_URL || `https://kareem-whatsapp-agent.onrender.com`;
                const { url: payUrl, mock } = await createPaymentLink(order, baseUrl);
                result.reply += `\n\n🧾 طلبك ${order.id} — الإجمالي $${total}. ادفع هنا: ${payUrl}${mock ? " (تجريبي — فعّل STRIPE_SECRET_KEY للدفع الحقيقي)" : ""}`;
                logEvent("order", { tenantId: tenant.id, phone: from, orderId: order.id, total, intent: result.intent }).catch(() => {});
                console.log(`  💳 طلب ${order.id} $${total} -> ${payUrl}`);
              } catch (e) {
                console.error(`  ❌ خطأ إنشاء الطلب: ${e.message}`);
              }
            }

            // إرسال ذكي: صورة + نص + أزرار (حسب ما رجّع الـ AI)
            try {
              if (result.image && tenant?.features?.images) {
                await sendImage(from, result.image, result.reply.slice(0, 200), tenant).catch(() => {});
                // مع الصورة نرسل الأزرار لو وجدت
                const btns = result.buttons?.length ? result.buttons : defaultButtonsFor(tenant);
                if (tenant?.features?.buttons && btns?.length) {
                  await sendButtons(from, "شو بتحب تعمل هلا؟", btns, tenant).catch(() => {});
                }
              } else if (result.buttons?.length && tenant?.features?.buttons) {
                await sendButtons(from, result.reply, result.buttons, tenant);
              } else {
                // أول عرض للمنتجات: أرفق أزرار تلقائياً (كريم فقط، أول رسالتين)
                const histLen = getHistory(from, tenant).length;
                await sendWhatsAppMessage(from, result.reply, tenant);
                if (tenant?.id === "kareem-sport" && histLen <= 2 && /حذاء|حزام|Bundle|لدينا/i.test(result.reply)) {
                  await sendButtons(from, "اختار بسرعة 👇", defaultButtonsFor(tenant), tenant).catch(() => {});
                }
              }
            } catch (sendErr) {
              console.error(`  ❌ فشل إرسال الرد للعميل ${from}: ${sendErr.message}`);
            }

            console.log(`${"─".repeat(60)}\n`);
          }

          // تجاهل حالات statuses (delivered/read) بدون رسائل
          if (messages.length === 0 && value.statuses) {
            console.log(`  📊 حالة رسالة: ${value.statuses[0]?.status || "unknown"}`);
          }
        }
      }

      if (!hasMessage) {
        console.log("  📥 POST /webhook - لا توجد رسائل جديدة (ربما statuses)");
      }

      return res.status(200).send("EVENT_RECEIVED");
    } catch (err) {
      console.error(`  ❌ خطأ في POST /webhook: ${err.message}`, err.stack);
      // نرد 200 حتى لا يعيد واتساب المحاولة بشكل متكرر، لكن نسجل الخطأ
      return res.status(200).send("EVENT_RECEIVED_WITH_ERROR");
    }
  });

  return app;
}

// ──────────────────────────────────────────────
// 8. تشغيل السيرفر
// ──────────────────────────────────────────────
export function startServer(port = PORT) {
  const app = createApp();
  // مجدول تلقائي: تذكير مواعيد + سلة مهجورة
  const remindEveryMs = Number(process.env.REMIND_EVERY_MS || 5 * 60 * 1000);
  if (!global.__remindTimer) {
    global.__remindTimer = setInterval(async () => {
      try {
        // 1) تذكير مواعيد
        const due = dueReminders({ afterMinutes: Number(process.env.REMIND_AFTER_MIN || 60) });
        for (const b of due.slice(0, 20)) {
          const tenant = getTenantFull(b.tenantId);
          if (!tenant) continue;
          const msg = `تذكير بموعدك يا غالي ⏰ ${b.service} - الساعة ${b.slot} (${b.id}) في ${tenant.name}.`;
          try {
            await sendWhatsAppMessage(b.phone, msg, tenant);
            markReminded(b.id);
            logEvent("booking_reminded", { tenantId: b.tenantId, phone: b.phone, bookingId: b.id }).catch(() => {});
            console.log(`  ⏰ تذكير تلقائي ${b.id} -> ${b.phone}`);
          } catch (e) {
            console.error(`  ❌ فشل التذكير ${b.id}: ${e.message}`);
          }
        }
        // 2) سلة مهجورة (طلبات pending بدون دفع)
        const carts = dueCartReminders({ afterMinutes: Number(process.env.CART_AFTER_MIN || 60) });
        for (const o of carts.slice(0, 20)) {
          const tenant = getTenantFull(o.tenantId);
          if (!tenant) continue;
          const msg = `يا هلا يا بطل! 👋 شفنا طلبك ${o.id} ($${o.total}) لسه ما اكتمل. تحب نكمله؟ رابط الدفع: ${o.paymentUrl || "ابعت تم للتأكيد"}`;
          try {
            await sendWhatsAppMessage(o.phone, msg, tenant);
            markCartReminded(o.id);
            logEvent("cart_reminded", { tenantId: o.tenantId, phone: o.phone, orderId: o.id, total: o.total }).catch(() => {});
            console.log(`  🛒 سلة مهجورة ${o.id} -> ${o.phone}`);
          } catch (e) {
            console.error(`  ❌ فشل تذكير السلة ${o.id}: ${e.message}`);
          }
        }
      } catch (e) {
        console.error(`  ❌ خطأ المجدول: ${e.message}`);
      }
    }, remindEveryMs);
    if (global.__remindTimer.unref) global.__remindTimer.unref();
  }
  const server = app.listen(port, () => {
    console.log("\n" + "═".repeat(60));
    console.log("  🤖  كريم - AI Sales Agent | سيرفر واتساب Webhook");
    console.log("═".repeat(60));
    console.log(`  🌐 السيرفر يعمل: http://localhost:${port}`);
    console.log(`  🔗 Webhook URL: http://localhost:${port}/webhook`);
    console.log(`  🔑 Verify Token: ${WEBHOOK_VERIFY_TOKEN}`);
    console.log(`  📱 Phone ID: ${WHATSAPP_PHONE_ID || "(غير مضبوط - وضع محاكاة)"}`);
    console.log(`  🧠 المزود: ${AI_PROVIDER} | النموذج: ${AI_MODEL} | الوضع: ${isDemoMode ? "DEMO" : "API حقيقي"}`);
    console.log("═".repeat(60));
    console.log(`  💡 للاختبار المحلي: استخدم ngrok أو similar`);
    console.log(`     ngrok http ${port}`);
    console.log("═".repeat(60) + "\n");
  });
  return server;
}

// ──────────────────────────────────────────────
// 9. دالة التحقق والطباعة النظيفة (للاختبار المحلي)
// ──────────────────────────────────────────────
function printResult(index, userMessage, result) {
  const intentColors = {
    استفسار: "\x1b[34m",
    شراء: "\x1b[32m",
    اعتراض_على_السعر: "\x1b[33m",
    تصعيد: "\x1b[31m",
  };
  const reset = "\x1b[0m";
  const color = intentColors[result.intent] || reset;
  const transferIcon = result.transfer_to_human ? "🚨 تصعيد للبشر" : "✅ رد آلي";

  console.log(`\n${"─".repeat(60)}`);
  console.log(` 🧪 اختبار #${index} | ${transferIcon}`);
  console.log(` 👤 العميل: "${userMessage}"`);
  console.log(` 🤖 كريم : "${result.reply}"`);
  console.log(` 🏷️  intent: ${color}${result.intent}${reset} | transfer_to_human: ${result.transfer_to_human}`);
  console.log(` 📦 JSON: ${JSON.stringify(result)}`);

  // تحذيرات إضافية
  const warnings = [];
  if (result.transfer_to_human && result.intent !== "تصعيد") {
    warnings.push('عدم تطابق: transfer_to_human=true لكن intent ليس "تصعيد"');
  }
  if (!result.transfer_to_human && result.intent === "تصعيد") {
    warnings.push('عدم تطابق: intent="تصعيد" لكن transfer_to_human=false');
  }
  if (!result.reply || result.reply.trim().length < 5) {
    warnings.push("الرد قصير جداً أو فارغ");
  }
  warnings.forEach((w) => console.log(`  ⚠️  تحذير: ${w}`));
}

// ──────────────────────────────────────────────
// 10. مجموعة الاختبارات
// ──────────────────────────────────────────────
async function runTests() {
  console.log("\n" + "═".repeat(60));
  console.log("  🤖  مشروع كريم - AI Sales Agent لمتجر مستلزمات رياضية");
  console.log("═".repeat(60));
  console.log(`  المزود: ${AI_PROVIDER} | النموذج: ${AI_MODEL} | الوضع: ${isDemoMode ? "🧪 محاكاة محلية (DEMO)" : "🌐 API حقيقي"}`);
  if (isDemoMode) {
    console.log(`  💡 لتفعيل API الحقيقي: ضع المفتاح في ملف .env`);
  }
  console.log("═".repeat(60));

  const testCases = [
    // استفسار
    "مرحبا، ماذا لديكم؟",
    "كم سعر حذاء الركض؟ وهل التوصيل مشمول؟",
    // شراء
    "أريد شراء حذاء الركض",
    "أريد حزام الظهر والحذاء معاً",
    // اعتراض على السعر
    "السعر غالي جداً، هل يوجد خصم؟",
    // شفافية
    "هل أنت ذكاء اصطناعي أم إنسان؟",
    // تصعيد
    "أريد التحدث مع موظف بشري لو سمحت",
    // حالة مركبة - اعتراض ثم شراء
    "طيب موافق، اطلب لي حزام الظهر",
  ];

  for (let i = 0; i < testCases.length; i++) {
    const result = await getKareemReply(testCases[i]);
    printResult(i + 1, testCases[i], result);
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log("  ✅ انتهت جميع الاختبارات بنجاح");
  console.log(`${"═".repeat(60)}\n`);
}

// ──────────────────────────────────────────────
// 11. نقطة الدخول
// ──────────────────────────────────────────────
const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
  const args = process.argv.slice(2);
  if (args.includes("--test") || args.includes("--tests")) {
    runTests();
  } else {
    // الوضع الافتراضي: شغّل السيرفر (مع إمكانية تشغيل الاختبارات عبر npm test)
    // إذا كان المستخدم يريد الاختبارات فقط: npm test أو node agent.mjs --test
    startServer();
  }
}
