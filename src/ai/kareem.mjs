import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import {
  AI_PROVIDER,
  GOOGLE_API_KEY,
  OPENAI_API_KEY,
  AI_MODEL,
} from "../config/env.mjs";
import { resolveTenantInput, buildSystemPrompt } from "../../tenants.mjs";
import { getHistory, pushHistory } from "../memory/conversations.mjs";

let googleClient = null;
let openaiClient = null;

if (AI_PROVIDER === "google" && GOOGLE_API_KEY && GOOGLE_API_KEY !== "DEMO_KEY") {
  googleClient = new GoogleGenAI({ apiKey: GOOGLE_API_KEY });
}
if (AI_PROVIDER === "openai" && OPENAI_API_KEY && OPENAI_API_KEY !== "DEMO_KEY") {
  openaiClient = new OpenAI({ apiKey: OPENAI_API_KEY });
}

export const isDemoMode = !googleClient && !openaiClient;

// ──────────────────────────────────────────────
// 2. System Prompt - شخصية كريم
// ──────────────────────────────────────────────
export const SYSTEM_PROMPT = `
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
// 6. الدالة الأساسية: getKareemReply (مع ذاكرة)
// ──────────────────────────────────────────────
export async function getKareemReply(userMessage, phone = "default", tenantInput = null) {
  const tenant = await resolveTenantInput(tenantInput);
  // كريم الحالي يبقى كما هو؛ أي tenant جديد يستخدم prompt مبني من إعداداته
  const prompt = tenant?.id === "kareem-sport" ? SYSTEM_PROMPT : buildSystemPrompt(tenant);
  const botLabel = tenant?.botName || "كريم";

  // وضع DEMO بدون استهلاك API - مع ذاكرة بسيطة
  if (isDemoMode) {
    await new Promise((r) => setTimeout(r, 300));
    const result = mockReply(userMessage);
    // حفظ في الذاكرة حتى في وضع DEMO (معزولة لكل بوت)
    await pushHistory(phone, "user", userMessage, tenant);
    await pushHistory(phone, "assistant", result.reply, tenant);
    return result;
  }

  try {
    let rawText = "";
    const history = await getHistory(phone, tenant);
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
    await pushHistory(phone, "user", userMessage, tenant);
    await pushHistory(phone, "assistant", parsed.reply, tenant);
    return parsed;
  } catch (err) {
    console.warn(`  ⚠️  خطأ في استدعاء API: ${err.message} - الرجوع للمحاكاة المحلية`);
    const fallback = mockReply(userMessage);
    await pushHistory(phone, "user", userMessage, tenant);
    await pushHistory(phone, "assistant", fallback.reply, tenant);
    return fallback;
  }
}

// الاسم المطلوب في التكليف: processCustomerMessage
export const processCustomerMessage = getKareemReply;
