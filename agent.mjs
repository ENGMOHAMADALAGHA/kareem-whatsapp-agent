import { fileURLToPath } from "node:url";

// ──────────────────────────────────────────────
// 2-4. الإعدادات والـ AI — نُقلت إلى src/config/env.mjs و src/ai/kareem.mjs
// ──────────────────────────────────────────────
import {
  AI_PROVIDER,
  AI_MODEL,
} from "./src/config/env.mjs";

// ──────────────────────────────────────────────
// 5. الذاكرة — نُقلت إلى src/memory/conversations.mjs (إعادة تصدير للتوافق)
// ──────────────────────────────────────────────
export {
  getHistory,
  pushHistory,
  clearMemory,
  getMemoryStats,
  isDuplicateMessage,
  isDuplicateMessageAsync,
} from "./src/memory/conversations.mjs";


// ──────────────────────────────────────────────
// Inbox/Takeover — نُقل إلى src/inbox/service.mjs (إعادة تصدير للتوافق)
// ──────────────────────────────────────────────
export {
  setTakeover,
  isTakeover,
  listInbox,
  getConversation,
} from "./src/inbox/service.mjs";

// ──────────────────────────────────────────────
// 6. الـ AI — نُقل إلى src/ai/kareem.mjs (إعادة تصدير للتوافق)
// ──────────────────────────────────────────────
export {
  getKareemReply,
  processCustomerMessage,
  isDemoMode,
} from "./src/ai/kareem.mjs";
import { getKareemReply, isDemoMode } from "./src/ai/kareem.mjs";

// ──────────────────────────────────────────────
// 6. الإرسال — نُقل إلى src/whatsapp/sender.mjs (إعادة تصدير للتوافق)
// ──────────────────────────────────────────────
export {
  sendWhatsAppMessage,
  sendButtons,
  sendImage,
  sendTemplate,
  defaultButtonsFor,
} from "./src/whatsapp/sender.mjs";


// ──────────────────────────────────────────────
// 7. الراوتات والـ Webhook — نُقلت إلى src/web/ (routes + middleware)
// ──────────────────────────────────────────────

// ──────────────────────────────────────────────
// 8. التشغيل — نُقل إلى src/web/app.mjs (إعادة تصدير للتوافق)
// ──────────────────────────────────────────────
export { createApp, startServer } from "./src/web/app.mjs";

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
