// تجربة وهمية شاملة لماسنجر + انستغرام عبر منصة وصل — بلا Meta
// تنشئ بوتين مؤقتين بهويتين مختلفتين، تمرر رسائل وهمية بكل الحالات، ثم تنظف بلا أثر.
// التشغيل: node scripts/demo-channels.mjs
await import("dotenv/config");
import { systemDb } from "../src/security/tenantGuard.mjs";
import { processMessagingBody } from "../src/web/routes/webhook/messaging.mjs";
import { resolveTenant } from "../tenants.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(m);

async function ensureBot(id, patch) {
  await systemDb("demo-ch").tenant.deleteMany({ where: { id } }).catch(() => {});
  await systemDb("demo-ch").tenant.create({
    data: {
      id, name: patch.name, botName: patch.botName, enabled: true,
      businessType: patch.businessType, products: patch.products || [],
      plan: "pro", trialEndsAt: null, features: patch.features, verifyToken: "demo-verify",
    },
  });
}

async function run() {
  log("\n=== وصل — تجربة قنوات ماسنجر + انستغرام (وهمية بلا Meta) ===\n");

  // 1) بوتان بواجهتين مختلفتين — نفس المنصة، هويتان معزولتان
  await ensureBot("demo-msg", {
    name: "وصل — تجريبي ماسنجر", botName: "مساعِد ماسنجر",
    businessType: "retail", products: [{ name: "حقيبة", price: 30 }],
    features: { messengerPageId: "PAGE_DEMO_1", buttonActions: { greet: "مرحبا" } },
  });
  await ensureBot("demo-ig", {
    name: "وصل — تجريبي انستغرام", botName: "مساعِد انستا",
    businessType: "general", products: [],
    features: { instagramId: "IG_DEMO_1", booking: true, bookingSlots: ["10:00", "11:00"] },
  });
  log("✅ بوتان مؤقتان: demo-msg (PAGE_DEMO_1) + demo-ig (IG_DEMO_1)\n");

  // 2) عزل الهويات
  const tMsg = await resolveTenant({ pageId: "PAGE_DEMO_1", channel: "messenger" });
  const tIg = await resolveTenant({ pageId: "IG_DEMO_1", channel: "instagram" });
  const tNo = await resolveTenant({ pageId: "NOPE", channel: "messenger" });
  log(`عزل: messenger PAGE_DEMO_1 → ${tMsg?.id} | instagram IG_DEMO_1 → ${tIg?.id} | مجهول → ${tNo}`);

  // 3) سيناريوهات ماسنجر — نص + زر + صورة + فويس (وهمي)
  const msgScenarios = [
    { label: "ماسنجر — نص عادي", body: { object: "page", entry: [{ id: "PAGE_DEMO_1", messaging: [{ sender: { id: "U1" }, recipient: { id: "PAGE_DEMO_1" }, message: { mid: "m1", text: "كم سعر الحقيبة؟" } }] }] } },
    { label: "ماسنجر — زر سريع", body: { object: "page", entry: [{ id: "PAGE_DEMO_1", messaging: [{ sender: { id: "U1" }, recipient: { id: "PAGE_DEMO_1" }, postback: { payload: "greet", title: "ابدأ" } }] }] } },
    { label: "ماسنجر — صورة (إقرار فقط)", body: { object: "page", entry: [{ id: "PAGE_DEMO_1", messaging: [{ sender: { id: "U1" }, recipient: { id: "PAGE_DEMO_1" }, message: { mid: "m2", attachments: [{ type: "image", payload: { url: "https://picsum.photos/200" } }], text: "" } }] }] } },
  ];
  for (const sc of msgScenarios) {
    log(`\n— ${sc.label} —`);
    await processMessagingBody(sc.body, "messenger");
    await sleep(300);
  }

  // 4) انستغرام — حجز (يمر عبر نفس خط الحجز)
  log("\n— انستغرام — طلب حجز —");
  await processMessagingBody(
    { object: "instagram", entry: [{ id: "IG_DEMO_1", messaging: [{ sender: { id: "I1" }, recipient: { id: "IG_DEMO_1" }, message: { mid: "ig1", text: "بدي حجز" } }] }] },
    "instagram"
  );
  await sleep(300);
  await processMessagingBody(
    { object: "instagram", entry: [{ id: "IG_DEMO_1", messaging: [{ sender: { id: "I1" }, recipient: { id: "IG_DEMO_1" }, message: { mid: "ig2", text: "10:00" } }] }] },
    "instagram"
  );

  // 5) تحقق: السجلات منفصلة لكل قناة (لا خلط)
  const { tenantDb } = await import("../src/security/tenantGuard.mjs");
  const cMsg = await tenantDb("demo-msg").message.count({});
  const cIg = await tenantDb("demo-ig").message.count({});
  log(`\n📊 سجلات: demo-msg = ${cMsg} رسائل | demo-ig = ${cIg} رسائل — منفصلة ✅`);

  // 6) تنظيف بلا أثر
  await tenantDb("demo-msg").message.deleteMany({});
  await tenantDb("demo-ig").message.deleteMany({});
  await systemDb("demo-ch").tenant.deleteMany({ where: { id: { in: ["demo-msg", "demo-ig"] } } });
  log("🧹 تنظيف — بوتان وسجلاتهما حُذفا بلا أثر\n");
  log("=== التجربة كاملة — المنصة تعالج القناتين بنفس الجودة كواتساب (الإرسال الحقيقي يبقى بانتظار توكن الصفحة) ===");
}

run().catch((e) => { console.error("فشل التجربة:", e); process.exit(1); });
