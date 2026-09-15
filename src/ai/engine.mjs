import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import {
  AI_PROVIDER,
  GOOGLE_API_KEY,
  OPENAI_API_KEY,
  AI_MODEL,
  AI_TIMEOUT_MS,
  AI_HISTORY_LIMIT,
  AI_HISTORY_CHARS,
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
1. حذاء ركض احترافي — 50 د.أ
2. حزام دعم الظهر — 20 د.أ
3. رسوم التوصيل ثابتة — 5 د.أ (تُضاف على أي طلب)
4. 🎁 عرض Bundle المميز: الحذاء + الحزام معاً = 70 د.أ شامل التوصيل (توفير 5 د.أ)! اذكر العرض بوضوح عند طلب الاثنين.

# العملة: دينار أردني (د.أ) دائماً — اكتب الأسعار مثل "50 د.أ" ولا تستخدم $ أبداً.

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
  "buttons": [{"id": "buy_shoes", "title": "👟 الحذاء 50 د.أ"}],
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
- عميل: "كم سعر الحذاء؟" -> {"reply": "حذاء الركض الاحترافي سعره 50 د.أ ورسوم التوصيل 5 د.أ، الإجمالي 55 د.أ. هل ترغب في تأكيد الطلب؟", "transfer_to_human": false, "intent": "استفسار"}
- عميل: "السعر غالي" -> {"reply": "أتفهمك تماماً، الحذاء مصمم بتقنيات احترافية لراحة القدم ودعمها لمسافات طويلة ويستحق الاستثمار. كبديل اقتصادي، حزام دعم الظهر متوفر بـ 20 د.أ فقط (+5 د.أ توصيل). هل تود تجربته؟", "transfer_to_human": false, "intent": "اعتراض_على_السعر"}
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
      reply: "يا هلا والله! نعم أنا كريم مساعد ذكي آلي لمتجر المستلزمات الرياضية 😊 وسعيد بمساعدتك! لدينا حذاء ركض احترافي بـ 50 د.أ وحزام دعم الظهر بـ 20 د.أ (+5 د.أ توصيل). كيف أساعدك يا بطل؟ كريم معك خطوة بخطوة 👟",
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
      reply: "بفهمك والله يا بطل 💪 الحذاء مصمم بخامات احترافية لراحة القدم لمسافات طويلة وبستاهل كل قرش. كخيار اقتصادي ممتاز، حزام دعم الظهر متوفر بـ 20 د.أ فقط (+5 د.أ توصيل = 25 د.أ). قلّي شو أكتر شي بهمك: الراحة بالركض ولا دعم الظهر؟ عشان أوجهك للأفضل 👟 كريم معك خطوة بخطوة",
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
        reply: "يا هلا يا بطل! 🎁 عرض Bundle المميز: حذاء الركض 50 د.أ + حزام الظهر 20 د.أ + التوصيل 5 د.أ = 75 د.أ، بس إلك عرض خاص 70 د.أ شامل التوصيل (توفير 5 د.أ)! هل أثبتلك الطلب؟ كريم معك خطوة بخطوة 👟",
        transfer_to_human: false,
        intent: "شراء",
      };
    }
    if (wantsBelt) {
      return {
        reply: "رائع يا بطل! حزام دعم الظهر سعره 20 د.أ + 5 د.أ توصيل = 25 د.أ. هل أثبتلك الطلب؟ كريم معك خطوة بخطوة 👟",
        transfer_to_human: false,
        intent: "شراء",
      };
    }
    return {
      reply: "ممتاز يا بطل! حذاء الركض الاحترافي سعره 50 د.أ + 5 د.أ توصيل = 55 د.أ. هل أثبتلك الطلب؟ كريم معك خطوة بخطوة 👟",
      transfer_to_human: false,
      intent: "شراء",
    };
  }
  // استفسار عام
  if (/(كم.*سعر|بكم|سعر.*حذاء|سعر.*حزام|توصيل|منتجات|عندكم ايش|وش عندكم|ماذا لديكم)/.test(msg)) {
    return {
      reply: "يا هلا والله يا بطل! 😊 لدينا حذاء ركض احترافي بـ 50 د.أ، وحزام دعم الظهر بـ 20 د.أ، ورسوم التوصيل 5 د.أ. وعندنا عرض Bundle المميز: الاثنين بـ 70 د.أ شامل التوصيل (توفير 5 د.أ)! أي منتج بتحب؟ كريم معك خطوة بخطوة 👟",
      transfer_to_human: false,
      intent: "استفسار",
    };
  }
  // ترحيب أو رسالة عامة
  return {
    reply: "يا هلا والله يا بطل! 😊 أنا كريم، صاحبك الرياضي من متجر المستلزمات. لدينا حذاء ركض احترافي (50 د.أ) وحزام دعم الظهر (20 د.أ) مع توصيل 5 د.أ، وعرض Bundle المميز: الاثنين بـ 70 د.أ شامل التوصيل 🎁 كيف أساعدك اليوم؟ كريم معك خطوة بخطوة 👟",
    transfer_to_human: false,
    intent: "استفسار",
  };
}

// رد بديل عام لكل بوتات المنصة — ذكي ومحايد، يبني رده من بيانات البوت فقط
// لا نُسرب كتالوج أي بوت لآخر، ولا لهجة بوت لآخر
function fallbackReplyFor(tenant, userMessage) {
  const msg = String(userMessage || "").toLowerCase();
  const name = tenant?.botName || tenant?.name || "فريقنا";
  const prods = tenant?.products || [];
  const prodsTxt = prods.map((p) => `${p.name} (${p.price} د.أ)`).join("، ");
  const fee = tenant?.deliveryFee ? `+ ${tenant.deliveryFee} د.أ توصيل` : "";
  const bookingOn = !!tenant?.features?.booking;
  const tone = tenant?.tone || "ودود ومهني";

  // شفافية
  if (/(هل انت|هل أنت|بوت|روبوت|ذكاء اصطناعي|are you ai|are you bot)/.test(msg)) {
    return {
      reply: `يا هلا فيك 😊 نعم أنا ${name} مساعد ذكي آلي هنا لخدمتك — ${tone}. كيف أساعدك اليوم؟`,
      transfer_to_human: false,
      intent: "استفسار",
    };
  }
  // تصعيد
  if (/(اريد.*موظف|أريد.*موظف|اكلم.*موظف|أكلم.*موظف|انسان|إنسان|بشري|خدمة عملاء|موظف)/.test(msg)) {
    return {
      reply: `أكيد، بلغت فريق ${name} ورح يتواصل معك قريباً 🙏 شكراً لصبرك.`,
      transfer_to_human: true,
      intent: "تصعيد",
    };
  }
  // اعتراض سعري — رد عام يبني من منتجات البوت نفسه
  if (/(غالي|كثير|سعر مرتفع|خصم|تخفيض|ما تقدر تنقص)/.test(msg)) {
    if (prods.length) {
      const cheapest = [...prods].sort((a, b) => a.price - b.price)[0];
      return {
        reply: `أتفهمك تماماً 🙏 كل منتجاتنا مختارة بعناية وقيمتها تستاهل. كخيار اقتصادي عندنا ${cheapest.name} بـ ${cheapest.price} د.أ ${fee}. تحب أثبته لك؟`,
        transfer_to_human: false,
        intent: "اعتراض_على_السعر",
      };
    }
    return {
      reply: `أتفهم ملاحظتك 🙏 خبرنا شو الميزانية المناسبة لك ونوجهك لأفضل خيار.`,
      transfer_to_human: false,
      intent: "اعتراض_على_السعر",
    };
  }
  // شراء — يلتقط اسم المنتج من كلام العميل
  if (/(اشتري|أشتري|اطلب|أطلب|اريد.*منتج|أريد.*منتج|بدي|احجز.*شراء|موافق.*اطلب|ثبت.*طلب)/.test(msg)) {
    const hit = prods.find((p) => p.name && msg.includes(p.name.split(" ")[0].toLowerCase()));
    if (hit) {
      const total = hit.price + (tenant?.deliveryFee || 0);
      return {
        reply: `ممتاز — ${hit.name} سعره ${hit.price} د.أ ${fee} = الإجمالي ${total} د.أ. أثبت لك الطلب؟`,
        transfer_to_human: false,
        intent: "شراء",
      };
    }
    if (bookingOn) {
      return {
        reply: `تمام 🌸 احجز موعدك بكلمة "حجز" واختر الوقت المناسب.`,
        transfer_to_human: false,
        intent: "حجز_موعد",
      };
    }
    return {
      reply: prods.length
        ? `تكرم — عنا: ${prodsTxt} ${fee}. أي منتج بتحب أثبته؟`
        : `تكرم — كيف أساعدك بالطلب؟ اذكر اسم المنتج.`,
      transfer_to_human: false,
      intent: "شراء",
    };
  }
  if (bookingOn && /موعد|حجز|احجز|book|appointment/.test(msg)) {
    return {
      reply: `يا هلا فيك 🌸 أهلاً بك في ${name}. احجز موعدك بكلمة "حجز" أو انضم لقائمتنا بـ"انتظار".`,
      transfer_to_human: false,
      intent: "حجز_موعد",
    };
  }
  // استفسار عام
  if (prods.length) {
    return {
      reply: `يا هلا فيك 😊 ${bookingOn ? `نخدمك في ${name} — ` : ""}عنا: ${prodsTxt} ${fee}. كيف أساعدك؟ ابعت "أريد موظف" لأي استفسار خاص.`,
      transfer_to_human: false,
      intent: "استفسار",
    };
  }
  return {
    reply: `يا هلا فيك 🌸 بنخدمك في ${name} 😊 احجز موعدك بكلمة "حجز"، أو ابعت "أريد موظف" للتواصل المباشر.`,
    transfer_to_human: false,
    intent: "استفسار",
  };
}
// ──────────────────────────────────────────────
// 6. الدالة الأساسية: getKareemReply (مع ذاكرة)
// ──────────────────────────────────────────────
// ───────────────
// 7. الدالة الأساسية: getKareemReply (مع ذاكرة)
// ───────────────
export async function getKareemReply(userMessage, phone = "default", tenantInput = null) {
  const tenant = await resolveTenantInput(tenantInput);
  // شخصية المحرك: legacyPrompt اختيارية لكل بوت من features (بوت كريم مفعّلها ببياناته) —
  // أي بوت جديد يستخدم prompt مبني من إعداداته افتراضياً، ولا أفضلية لأي id.
  const prompt = tenant?.features?.legacyPrompt === true ? SYSTEM_PROMPT : buildSystemPrompt(tenant);

  // وضع DEMO بدون استهلاك API - مع ذاكرة بسيطة
  if (isDemoMode) {
    await new Promise((r) => setTimeout(r, 300));
    const result = tenant?.features?.legacyPrompt === true ? mockReply(userMessage) : fallbackReplyFor(tenant, userMessage);
    // حفظ في الذاكرة حتى في وضع DEMO (معزولة لكل بوت)
    await Promise.all([
      pushHistory(phone, "user", userMessage, tenant),
      pushHistory(phone, "assistant", result.reply, tenant),
    ]);
    return result;
  }

  try {
    let rawText = "";
    // التوازي: تحميل السجل + حفظ رسالة العميل (مستقلان) — توفير ~200ms
    const [history] = await Promise.all([
      getHistory(phone, tenant),
      pushHistory(phone, "user", userMessage, tenant),
    ]);
    // تقليم السياق المرسل للنموذج: آخر N رسائل فقط، مقصوصة الطول
    // (السجل الكامل يبقى في DB/الذاكرة — هذا فقط ما يُدفع ثمنه زمناً وتوكنز)
    const ctx = history.slice(-AI_HISTORY_LIMIT).map((m) => ({
      role: m.role,
      text: m.text && m.text.length > AI_HISTORY_CHARS ? m.text.slice(0, AI_HISTORY_CHARS) + "…" : (m.text || ""),
    }));

    if (AI_PROVIDER === "google") {
      // السجل يُمرر مرة واحدة فقط كمصفوفة contents (لا تكرار نصي في systemInstruction)
      const fullContents = [];
      for (const h of ctx) {
        fullContents.push({ role: h.role === "user" ? "user" : "model", parts: [{ text: h.text }] });
      }
      fullContents.push({ role: "user", parts: [{ text: userMessage }] });

      const response = await withAiTimeout((signal) =>
        fetchGeminiREST(fullContents, prompt, signal)
      );
      rawText = response.text;
    } else {
      const messages = [{ role: "system", content: prompt }];
      for (const h of ctx) {
        messages.push({ role: h.role === "user" ? "user" : "assistant", content: h.text });
      }
      messages.push({ role: "user", content: userMessage });

      const completion = await withAiTimeout((signal) =>
        openaiClient.chat.completions.create(
          {
            model: AI_MODEL,
            messages,
            response_format: { type: "json_object" },
            temperature: 0.7,
          },
          { signal }
        )
      );
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

    // حفظ رد المساعد فقط (رسالة العميل حُفظت مسبقاً بالتوازي مع التحميل)
    await pushHistory(phone, "assistant", parsed.reply, tenant);
    return parsed;
  } catch (err) {
    console.warn(`  ⚠️  خطأ في استدعاء API: ${err.message} - الرجوع للمحاكاة المحلية`);
    const fallback = tenant?.features?.legacyPrompt === true ? mockReply(userMessage) : fallbackReplyFor(tenant, userMessage);
    await pushHistory(phone, "assistant", fallback.reply, tenant);
    return fallback;
  }
}

// مهلة صارمة مع إلغاء حقيقي: نعطي المتصل AbortSignal وبموجبه تُقطع الشبكة
// (لا تركة عمل تستمر باستهلاك API بعد أن سلمنا بالرفض). أسوأ حالة محدودة بدل تعليق العامل.
function withAiTimeout(makePromise) {
  const ctrl = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new Error(`AI timeout ${AI_TIMEOUT_MS}ms`));
    }, AI_TIMEOUT_MS);
  });
  return Promise.race([makePromise(ctrl.signal), timeout]).finally(() => clearTimeout(timer));
}

// استدعاء Gemini عبر REST-endpoint مباشرة (fetch + AbortController):
// الـ SDK الرسمي لا يقبل إلغاء — هذا يمنح مهلة تحليلية حقيقية بدل سباق بلا قطع.
async function fetchGeminiREST(contents, prompt, signal) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${AI_MODEL}:generateContent`,
    {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json", "x-goog-api-key": GOOGLE_API_KEY },
      body: JSON.stringify({
        contents,
        systemInstruction: { parts: [{ text: prompt }] },
        generationConfig: { responseMimeType: "application/json", temperature: 0.7 },
      }),
    }
  );
  if (!res.ok) {
    const errBody = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`Gemini HTTP ${res.status}: ${errBody}`);
  }
  const data = await res.json();
  const text =
    data?.candidates?.[0]?.content?.parts
      ?.filter((p) => p?.text)
      .map((p) => p.text)
      .join("") || "";
  if (!text) throw new Error("Gemini رد فارغ");
  return { text };
}

// الاسم المطلوب في التكليف: processCustomerMessage
export const processCustomerMessage = getKareemReply;
