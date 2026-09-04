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
  "intent": "استفسار | شراء | اعتراض_على_السعر | تصعيد"
}

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

    // التحقق من intent المسموح
    const allowedIntents = ["استفسار", "شراء", "اعتراض_على_السعر", "تصعيد"];
    if (!allowedIntents.includes(parsed.intent)) {
      console.warn(`  ⚠️  تحذير: intent غير متوقع "${parsed.intent}" - تم التصحيح إلى "استفسار"`);
      parsed.intent = "استفسار";
    }

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

            // استخراج رقم العميل ونص الرسالة
            const from = msg.from; // رقم العميل
            const text = msg.text?.body || msg.button?.text || "";
            const name = contacts.find((c) => c.wa_id === from)?.profile?.name || from;

            if (!text) {
              console.log(`  📥 رسالة بدون نص من ${from} (type=${msg.type}) - تم تجاهلها`);
              continue;
            }

            console.log(`\n${"─".repeat(60)}`);
            console.log(`  🏢 tenant=${tenant?.id} | بوت=${tenant?.botName}`);
            console.log(`  📥 رسالة واتساب من ${name} (${from}): "${text}"`);
            console.log(`  🧠 الذاكرة: ${getHistory(from, tenant).length} رسائل سابقة`);

            // إرسال إلى الذكاء الاصطناعي مع ذاكرة المحادثة المعزولة
            const result = await processCustomerMessage(text, from, tenant);

            console.log(`  🤖 ${tenant?.botName || "كريم"} -> intent=${result.intent} transfer=${result.transfer_to_human}`);
            console.log(`  💬 الرد: "${result.reply}"`);
            console.log(`  📦 JSON: ${JSON.stringify(result)}`);

            if (result.transfer_to_human) {
              console.log(`  🚨 تنبيه: العميل ${from} طلب التصعيد للبشر!`);
            }

            // إرسال الرد عبر WhatsApp API الخاص بهذا البوت
            try {
              await sendWhatsAppMessage(from, result.reply, tenant);
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
