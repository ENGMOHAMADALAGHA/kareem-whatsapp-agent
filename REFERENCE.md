# 📚 المكتبة المرجعية الموحدة — منصة وصل (Wasl Command Center)

> **هذه الوثيقة هي مصدر الحقيقة الوحيد.** أي معلومة تتعارض معها في ملف أقدم
> (`WORK_MAP.md` قبل 2026-09-10، `BOT_SUMMARY.md`) تُهمل لصالح هذه الوثيقة.
> آخر تحديث: 2026-09-10 — تشمل كل الشغل حتى كوميت `660f9bb`.

---

## 1. الهوية (محسومة نهائياً)

| البند | القيمة |
|---|---|
| اسم المنصة | **Wasl — وصل / Wasl Command Center** |
| `package.json` name | `wasl-command-center` |
| من هو كريم؟ | **مستأجر رقم 1 فقط** (`kareem-sport` — متجر رياضي تجريبي). ليس اسم المنصة |
| المستأجر الثاني | ليان (`agha-dental` — عيادة أسنان تجريبية) |
| السوق | الأردن (عيادات + محلات) — التوسع الخليجي لاحقاً |
| المستودع | `ENGMOHAMADALAGHA/kareem-whatsapp-agent` (الاسم التاريخي، لا يغيّر الهوية) |
| الإنتاج | `https://kareem-whatsapp-agent.onrender.com` (رابط تاريخي، يُبدّل عند النقل) |

---

## 2. سجل القرارات الملزمة (لا تُناقش من جديد بدون سبب)

| # | القرار | السبب | الكوميت |
|---|---|---|---|
| D1 | **الدينار (د.أ) عملة المنصة**، الدولار خيار لكل عميل عبر `features.currency` | السوق أردني | `8519ce1` |
| D2 | **بلا Stripe وبلا روابط دفع نهائياً** — محافظ/CliQ + إيصال فقط | لا سجل تجاري مطلوب، صاحب النشاط يتحقق | `6906caf` |
| D3 | **موعد واحد = عميل واحد** — `slotCapacity` ملغاة، القيد الفريد يحكم | طبيب/مزرعة/تجميل: مستحيل عميلان بنفس الوقت | `6906caf` |
| D4 | **لا تنحٍّ تلقائي عند التصعيد** — البوت يرد دائماً + تنبيه مخنوق (1/10د) | طلب المالك صراحة | `c66ab95` |
| D5 | **كل رقم باسم صاحبه وهويته فقط** — ممنوع خطوط باسمنا لأي عميل (قانون الاتصالات الأردني) | مسؤولية جنائية | قرار 2026-09-09 |
| D6 | العميل لا ينشئ حسابات Meta — **إحنا نستضيف**، هو يعطي OTP فقط | واقع السوق الأردني | 2026-09-09 |
| D7 | عقد الخدمة يتضمن: العميل مسؤول عن محتوى رسائله، وصل مزوّد تقني فقط | حماية قانونية | 2026-09-09 |
| D8 | النموذج التجاري: استضافة (150 د.أ) + لاحقاً مزوّد بمحافظ العملاء | سقف 20 رقم/محفظة | 2026-09-09 |
| D9 | اسم تجريبي + بيانات تجريبية تُنظف قبل أي عرض عميل | احترافية | دائم |

---

## 3. البنية والملفات

```
server.mjs            → دخول التشغيل (معالج unhandledRejection)
agent.mjs             → إعادة تصدير + harness التست (8 حالات)
tenants.mjs           → البوتات: حل + كاش + توكن مشفر + خطط + حذف + عزل
orders.mjs            → الطلبات + fmtMoney/tenantCurrency + detectTotal/Item (عربي)
bookings.mjs          → الحجوزات + قيد فريد + انتظار + سلة (capacity=1 دائماً)
portal.mjs            → حسابات العملاء + JWT + دعوات + معاينة
crm.mjs / engage.mjs  → الأحداث + بث + تقييم
store.mjs / db.mjs    → KV دائم + Prisma Singleton
voice.mjs             → فويس (فحص مسبق + مهلة تفريغ)
admin.html            → كونسول السوبر (8 تبويبات + Bots + Wizard + Link + Preview)
client.html           → بوابة العميل المستقلة (تُخدم على /portal/)
electron/             → غلاف الديسكتوب (main.cjs + preload.cjs، دخول تلقائي)
assets/               → icon.svg + tailwind.js (محلي — لا CDN خارجي)
scripts/              → dev-ui.mjs + launch-hidden.cmd
Wasl-Desktop.vbs      → إطلاق مخفي بلا CMD + سجل logs/desktop.log
start-dev.bat/.sh     → إطلاق بضغطة
prisma/schema.prisma  → 10 جداول (أدناه) + seed.mjs
src/
  web/app.mjs         → Express + 404/500 موحدة + تحذيرات إقلاع
  web/middleware.mjs  → adminAuth (fail-closed) + HMAC + scopeClient
  web/routes/admin.mjs    → كل مسارات الإدارة (~30)
  web/routes/webhook.mjs  → الاستقبال + كل التدفقات + FIFO لكل مرسل
  web/routes/portal.mjs   → login/forgot/reset
  web/routes/billing.mjs  → finalizePaidOrder الذري فقط
  ai/kareem.mjs       → Gemini (سياق مقلّم 6×500، مهلة 25ث) + mock
  memory/conversations.mjs → ذاكرة + dedup دائم (ذاكرة→Redis→DB)
  inbox/service.mjs   → takeover بلا expiry افتراضياً (يدوي فقط)
  whatsapp/sender.mjs → إرسال + retry ذكي + قوالب + WINDOW_CLOSED
  whatsapp/outbound.mjs → سياسة الإعادة + DLQ
  jobs/queue.mjs      → طوابير (webhook 5 / voice 2 / outbound 3) + FIFO + BullMQ اختياري
  jobs/schedulers.mjs → تذكير مواعيد + سلة (يتخطى الموقوفين)
  jobs/redisClient.mjs → عميل Redis الاختياري
  media/paymentProof.mjs → إيصال AI (JOD-aware + صياغة بشرية)
  compliance/messaging.mjs → opt-out/in + تنبيه طاقم/مالك + بديل النافذة
  security/ (tenantGuard, secrets AES-GCM, rateLimit) + config/env.mjs
```

### قاعدة البيانات (Supabase Postgres — pooler 6543)
`tenants` (توكن مشفر + plan + trialEndsAt) · `messages` · `orders` (currency!) ·
`appointments` (فريد tenant/day/slot + فهارس مسح) · `ratings` · `broadcasts` (+فهرس) ·
`events` · `tenant_users` · `kv_store`.
**ممنوع:** `prisma db push` يعلق على الـ pooler — التغييرات تُطبق SQL مباشر + `prisma generate`.

---

## 4. الـ API الكامل (38 مساراً)

```
GET  /                                   → هوية Wasl + حالة
GET  /webhook                            → تحقق Meta ( multi-tenant)
POST /webhook                            → استقبال (200 فوري + FIFO + dedup)
GET  /admin/tenants                      → قائمة (آمنة العرض)
POST /admin/tenants                      → إنشاء (plan/trial/توكن مشفر)
GET  /admin/tenants/:id                  → تفاصيل (بلا توكن + عزل عميل)
PATCH/DELETE /admin/tenants/:id          → تعديل/حذف (عزل عميل + حماية الأخير)
POST /admin/tenants/:id/test-link        → فحص Meta الحي (عزل عميل)
GET  /admin/preview/:tenantId            → رابط معاينة 10د (سوبر فقط)
POST /admin/invites                      → دعوة + كلمة مؤقتة + إرسال واتساب
POST/GET /admin/users                    → حسابات العملاء (مكرر → 409)
GET  /admin/orders | /orders/summary     → قائمة + ملخص KPI الخفيف
POST /admin/orders/:id/confirm           → تأكيد يدوي (ذري + بلا رسالتين)
POST /admin/broadcast | GET /broadcasts  → بث (50 + فلتر opt-out)
GET  /admin/report | /csat | /crm | /crm/export.csv | /csat-request
POST /admin/cart-remind-run | /admin/remind-run (مجدول: تذكير + سلة — remind-run مقيد ببوت العميل لبوابته)
GET  /admin/inbox | /admin/inbox/:t/:phone (عزل عميل) | /admin/inbox.html
POST /admin/takeover | /admin/send       → إسكات يدوي + إرسال يدوي
POST /admin/appointments/:id/cancel      → حذف + تحرير الموعد + تعبئة انتظار
PATCH /admin/appointments/:id            → تعديل أي حقل (تعارض → 409 + بدائل)
POST /admin/appointments                 → حجز يدوي (تعارض → 409 + بدائل)
POST /admin/appointments/:id/reschedule  → نقل موعد (تعارض → 409 + بدائل)
POST /admin/appointments/:id/remind      → تذكير يدوي فوري
GET  /admin/appointments/export.csv      → تصدير Excel (بوت + مدى تاريخ)
GET  /admin/waiting | /admin/queue
GET  /admin/  → admin.html (سوبر) | GET /portal/ → client.html (عميل)
POST /portal/login|forgot|reset          → دخول JWT 30 يوم + استعادة واتساب
```

---

## 5. متغيرات البيئة (كلها — القيم أسرار، الأسماء مرجع)

```
AI_PROVIDER, GOOGLE_API_KEY, OPENAI_API_KEY, AI_MODEL=gemini-flash-lite-latest
AI_TIMEOUT_MS=25000, AI_HISTORY_LIMIT=6, AI_HISTORY_CHARS=500
PORT=3000, WEBHOOK_VERIFY_TOKEN (ممنوع الافتراضي إنتاجياً!), WHATSAPP_TOKEN, WHATSAPP_PHONE_ID
PUBLIC_BASE_URL (لروابط الدعوات), CRM_WEBHOOK_URL (اختياري)
ADMIN_USER, ADMIN_PASS (قوية إجبارياً!), JWT_SECRET, TOKEN_ENC_KEY (إجباري إنتاجياً!)
META_APP_SECRET (إجباري — بدونه كل webhooks مرفوضة 403)
QUEUE_CONCURRENCY=5, QUEUE_RETRIES=2, QUEUE_TIMEOUT_MS=60000
VOICE_QUEUE_CONCURRENCY=2, VOICE_TIMEOUT_MS=15000, VOICE_MAX_MB=8, VOICE_TRANSCRIBE_TIMEOUT_MS=45000
OUTBOUND_MAX_RETRIES=3, OUTBOUND_BASE_DELAY_MS=1000, OUTBOUND_TIMEOUT_MS=15000
REDIS_URL (اختياري), USE_DURABLE_QUEUE, STAFF_PHONE (عام), WA_TEMPLATE_LANG=ar, WA_FOLLOWUP_TEMPLATE
RECEIPT_MIN_CONFIDENCE=0.7, RECEIPT_AMOUNT_TOLERANCE=1, RECEIPT_JOD_PER_USD=0.71
REMIND_EVERY_MS=300000, REMIND_AFTER_MIN=60, CART_AFTER_MIN=60
DATABASE_URL (pooler 6543 إجباري)
```

---

## 6. نموذج SaaS التجاري

- **الخطط:** trial (تجربة 14 يوم تلقائياً) / basic / clinic / pro — انتهاء التجربة يوقف (webhook + بوابة + بث).
- **الأسعار المقترحة:** تجريبي مجاني → عيادات 150 د.أ/شهر → لاحقاً: مستضاف 150 / بمحفظته 100.
- **التأهيل:** معالج 4 خطوات → فحص ربط → دعوة واتساب → بوابة → (معاينة 👁 للعروض).
- **السعات:** 20 رقم/محفظة موثقة → محفظة ثانية → نموذج مزوّد (Embedded Signup لاحقاً).
- **تكاليف Meta:** على بطاقة صاحب المحفظة (هللات بحجمنا) — تُراقب.

---

## 7. بروتوكولات ملزمة

1. **White-Face** (`CERTIFICATION.md` — 38/38 أخضر): لا "جاهز" بلا فحص حي لكل مسار وزر.
2. **Commit+Push تلقائي** بعد كل عملية (تعليمة دائمة من الشريك).
3. **بيانات التست تُنظف** قبل أي عرض (أرقام 96279xxxxxx الوهمية + `default`).
4. **أسرار لا تُطبع أبداً** بالشات أو السجلات — أسماء فقط.
5. **REMINDERS.md**: أوامر الطاقم `قف/شغّل` (مؤجلة بطلب الشريك).

---

## 8. المعلق (القادم)

- [ ] أول رقم حقيقي عبر Coexistence + أول عيادة دافعة (المعركة الحالية)
- [x] مزامنة Sheets لحظية عند كل حجز مؤكد (`syncBookingToGoogleSheets` — فشل آمن، `CRM_WEBHOOK_URL`)
- [x] جدول حجوزات إداري (أعمدة + إلغاء/تذكير يدوي/نقل + تصدير CSV + تحديث عند فتح التبويب)
- [x] توحيد الأرقام E.164 (`src/utils/phone.mjs`): `079/00962/+962` → `962…` عند كل مدخل + ترحيل القديم
- [ ] `قف/شغّل` أوامر واتساب للطاقم
- [ ] Embedded Signup + توثيق مزوّد Meta
- [ ] RAG معرفة + قوالب معتمدة + Redis فعلي + RDP/Pro
- [ ] JWT rotation + حذف ناعم + إدارة مستخدمين من الواجهة + ملخص صباحي واتساب
- [ ] خانة `features.currency` بالمعالج (USD عند الطلب)
- [ ] تنظيف أعمدة `paymentUrl`/`stripeSessionId` الخاملة + توثيق `/pay` المحذوف
