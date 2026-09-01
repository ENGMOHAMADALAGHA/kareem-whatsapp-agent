# خريطة عمل مشروع كريم - AI Sales Agent

> وثيقة مرجعية شاملة لكل خطوة تم تنفيذها - من الصفر حتى التشغيل على Render

## 1. نظرة عامة
- **الاسم:** كريم - وكيل مبيعات ذكي لمتجر مستلزمات رياضية
- **المنتجات:** حذاء ركض $50 / حزام دعم ظهر $20 / توصيل $5
- **المنصة:** واتساب Cloud API (Meta) + Node.js + Express + Google Gemini
- **الاستضافة:** Render (https://kareem-whatsapp-agent.onrender.com)
- **المستودع:** https://github.com/ENGMOHAMADALAGHA/kareem-whatsapp-agent

---

## 2. هيكل المشروع

```
whatsapp-ai-agent/
├── agent.mjs          # منطق كريم + System Prompt + AI + Mock
├── server.mjs         # wrapper للسيرفر (يستدعي agent.mjs)
├── package.json       # type:module + dependencies
├── .env               # متغيرات بيئة (لا يُرفع)
├── .env.example       # قالب للمتغيرات
├── .gitignore
└── .github/workflows/keep-alive.yml  # يصحي Render كل 10د
```

### package.json
```json
{
  "type": "module",
  "scripts": { "start": "node server.mjs", "test": "node agent.mjs --test" },
  "dependencies": {
    "@google/genai": "^1.0.0",
    "openai": "^4.104.0",
    "dotenv": "^16.4.5",
    "express": "^5.2.1"
  }
}
```

---

## 3. متغيرات البيئة (.env)

```ini
AI_PROVIDER=google
GOOGLE_API_KEY=AIza... (من aistudio.google.com)
OPENAI_API_KEY=DEMO_KEY
AI_MODEL=gemini-flash-lite-latest

PORT=3000
WEBHOOK_VERIFY_TOKEN=my_secret_token
WHATSAPP_TOKEN=EAA... (من Meta Developers)
WHATSAPP_PHONE_ID=1300758353117196
```

- **Render:** نفس المتغيرات في Dashboard → Environment
- **محلي:** `.env` (مستثنى من Git)

---

## 4. منطق كريم (agent.mjs)

### System Prompt
- الاسم كريم، لبق مباشر مهني، عربي
- الشفافية: يقر أنه ذكاء اصطناعي إذا سُئل
- المنتجات فقط المذكورة، ممنوع اقتراح غيرها
- اعتراض على السعر → يوضح القيمة + يقترح المنتج المكمل
- تصعيد → `transfer_to_human:true` + يبلغ الفريق

### هيكل الرد (JSON Only)
```json
{
  "reply": "نص عربي",
  "transfer_to_human": false,
  "intent": "استفسار | شراء | اعتراض_على_السعر | تصعيد"
}
```

### الدوال الأساسية
- `mockReply(msg)` - محاكاة محلية بدون API (8 حالات)
- `getKareemReply(msg)` / `processCustomerMessage` - تستدعي GoogleGenAI أو OpenAI مع `responseMimeType: application/json` + fallback للمحاكاة
- `sendWhatsAppMessage(to, text)` - `POST https://graph.facebook.com/v18.0/{PHONE_NUMBER_ID}/messages` مع `Bearer WHATSAPP_TOKEN`، أو محاكاة إذا `DEMO`
- `createApp()` - Express app مع `express.json()`
  - `GET /` → health `{name, status, webhook, mode}`
  - `GET /webhook` → يتحقق `hub.mode=subscribe` و `hub.verify_token === WEBHOOK_VERIFY_TOKEN` ويرجع `hub.challenge` وإلا 403
  - `POST /webhook` → يستخرج `from` و `text.body` من `entry[0].changes[0].value.messages[0]`، يستدعي `processCustomerMessage`، يطبع `intent` ويرسل الرد عبر `sendWhatsAppMessage`
- `startServer(port)` - يشغل على `PORT`

### الاختبارات
- 8 حالات في `runTests()` + `printResult()` ملون
- التشغيل: `node agent.mjs --test` أو `npm test`

---

## 5. تسلسل الأحداث (Map)

```mermaid
graph TD
  A[1. npm install] --> B[2. .env + .env.example]
  B --> C[3. agent.mjs + System Prompt]
  C --> D[4. node agent.mjs --test → 8 اختبارات DEMO]
  D --> E[5. winget install ngrok.ngrok]
  E --> F[6. ngrok config add-authtoken + ngrok update 3.39.11]
  F --> G[7. node server.mjs + ngrok http 3000 → https://confident-cargo-elderly.ngrok-free.dev]
  G --> H[8. Meta App: Kareem Sport Store → Use case: التواصل عبر واتساب → AGha Gaming]
  H --> I[9. Phone Number ID 1300758353117196 + Token EAA...]
  I --> J[10. Webhook Verify: URL + my_secret_token → 200]
  J --> K[11. git init + push → github.com/ENGMOHAMADALAGHA/kareem-whatsapp-agent]
  K --> L[12. Render: New Web Service → Build npm install / Start npm start → env vars]
  L --> M[13. Render Live https://kareem-whatsapp-agent.onrender.com]
  M --> N[14. WABA subscribe: POST /1329892032314692/subscribed_apps → success]
  N --> O[15. Google AI Studio → Gemini API Key AIza... → model gemini-flash-lite-latest]
  O --> P[16. تحديث Render env + redeploy → mode: google (live)]
  P --> Q[17. keep-alive.yml كل 10د]
  Q --> R[18. واتساب اختبار: +1 555 667-6129 ↔ +962790362429]
```

---

## 6. إعداد Meta (Facebook Developers)

1. https://developers.facebook.com → Create App → **Kareem Sport Store** (بدون كلمة whatsapp)
2. Use Case → **التواصل مع العملاء عبر واتساب** ✓
3. Business Portfolio → **AGha Gaming**
4. **الخطوة 1. جرّب:** يظهر `Phone Number ID 1300758353117196` و `+1 555 667-6129` والتوكن `EAA...` (إنشاء رمز)
5. **الخطوة 2. إعداد التشغيل → تكوين Webhooks:**
   - **Callback URL:** `https://kareem-whatsapp-agent.onrender.com/webhook`
   - **Verify Token:** `my_secret_token`
   - **Fields:** `messages` = **مشترك** (أزرق)، `phone_number_quality_update` مشترك، `security` مشترك
   - **Subscribe WABA:** `POST /1329892032314692/subscribed_apps` → ظهر `Kareem Sport Store` في القائمة
6. **إضافة مستلم تجريبي:** في **إرسال رسالة → المستلم** → أضف `+962790362429` ووثقه عبر واتساب

---

## 7. النشر

### GitHub
```bash
git init
git add .
git commit -m "feat: kareem whatsapp webhook agent"
git remote add origin https://github.com/ENGMOHAMADALAGHA/kareem-whatsapp-agent.git
git branch -M main
git push -u origin main
```

### Render
- Dashboard → New + → Web Service → Connect `kareem-whatsapp-agent`
- Build: `npm install`, Start: `npm start`, Region Oregon, Plan Free
- Env Vars: 6 متغيرات كما فوق
- Auto-Deploy: **yes** (بعد Rollback كان no وتم تفعيله عبر API)
- URL: `https://kareem-whatsapp-agent.onrender.com`
- Logs: `Your service is live`, `GET /webhook → نجاح`, `📥 رسالة واتساب من ...`

### keep-alive
- `.github/workflows/keep-alive.yml` كل `*/10 * * * *` يعمل `curl` للسيرفر + `cron-job.org` كبديل
- Render Free ينام بعد 15د، الـ ping يبقيه صاحي

### ngrok (مرحلة انتقالية)
- `winget install ngrok.ngrok` → `3.3.1` → `ngrok update` → `3.39.11` (احتاج استثناء Antivirus)
- `ngrok config add-authtoken 3Ii7CzxTb...` → `ngrok http 3000` → `https://confident-cargo-elderly.ngrok-free.dev`
- تم الاستغناء عنه بعد Render

---

## 8. اختبارات واتساب

- **الرقم التجريبي:** `+1 (555) 667-6129` (Meta)
- **رقم الاختبار:** `+962-7-9036-2429`
- **اختبارات ناجحة في Render Logs:**
  - `11:41:59 "مرحبا" → intent:استفسار → ✅ تم الإرسال wamid.HBg...`
  - `11:48:05 "مرحبا" → ✅`
  - `12:11:29 Test "مرحبا" → ✅`
- **اختبار مباشر عبر API:**
```bash
curl -X POST https://graph.facebook.com/v18.0/1300758353117196/messages \
  -H "Authorization: Bearer EAA..." \
  -d '{"messaging_product":"whatsapp","to":"962790362429","type":"text","text":{"body":"اختبار"}}'
# → 200 {"messages":[{"id":"wamid..."}]}
```
- **اختبار webhook يدوي:**
```bash
curl -X POST https://kareem-whatsapp-agent.onrender.com/webhook \
  -H "Content-Type: application/json" \
  -d '{"object":"whatsapp_business_account","entry":[{"changes":[{"value":{"messaging_product":"whatsapp","messages":[{"from":"962790362429","type":"text","text":{"body":"السعر غالي"}}]},"field":"messages"}]}]}'
# → 200 EVENT_RECEIVED → يرد "أتفهم وجهة نظرك..."
```

---

## 9. الذكاء الاصطناعي

- **المزود:** `google` عبر `@google/genai`
- **المفتاح:** `AIza...` (من aistudio.google.com - لا يُحفظ في Git)
- **النموذج:** `gemini-flash-lite-latest` (الوحيد المتاح للمستخدمين الجدد، `gemini-2.0-flash` و `1.5` منتهية)
- **الاختبار المحلي:**
```bash
node --env-file=.env -e "import {getKareemReply} from './agent.mjs'; console.log(await getKareemReply('السعر غالي'))"
# → {"reply":"أتفهمك...","transfer_to_human":false,"intent":"اعتراض_على_السعر"}
```
- **Fallback:** عند `403` أو `503` يرجع لـ `mockReply` المحلي

---

## 10. مشاكل وحلول

| المشكلة | السبب | الحل |
|---------|-------|------|
| `ngrok 3.3.1 too old ERR_NGROK_121` | نسخة قديمة | `ngrok update` → `3.39.11` + استثناء Antivirus |
| `ERR_NGROK_4018 not authenticated` | بدون authtoken | `ngrok config add-authtoken ...` |
| `model gemini-2.0-flash not found` | موديل منتهي | غيّر إلى `gemini-flash-lite-latest` (ListModels) |
| `Webhook token undefined` | طلب بدون `hub.verify_token` | تأكد من `my_secret_token` في Meta و .env |
| `رسائل واتساب ما بتوصل` | `messages` مش مشترك أو WABA مش مشترك | `POST /1329892032314692/subscribed_apps` + تفعيل `messages` أزرق |
| `Render free spins down` | ينام بعد 15د | `keep-alive.yml` كل 10د + cron-job.org |
| `Auto-Deploy disabled after rollback` | Rollback عطّلها | PATCH `autoDeploy:yes` عبر Render API + redeploy |

---

## 11. أوامر سريعة

```bash
# محلي
npm install
node agent.mjs --test
node server.mjs
# ngrok (مرحلة قديمة)
ngrok http 3000
# Git
git add . && git commit -m "msg" && git push
# اختبار webhook محلي
curl "http://localhost:3000/webhook?hub.mode=subscribe&hub.verify_token=my_secret_token&hub.challenge=12345"
curl -X POST http://localhost:3000/webhook -H "Content-Type: application/json" -d '{"object":"whatsapp_business_account","entry":[{"changes":[{"value":{"messages":[{"from":"962790362429","text":{"body":"مرحبا"}}]},"field":"messages"}]}]}'
# Render
curl https://kareem-whatsapp-agent.onrender.com/
curl "https://kareem-whatsapp-agent.onrender.com/webhook?hub.mode=subscribe&hub.verify_token=my_secret_token&hub.challenge=123"
```

---

## 12. المراجع

- Meta Docs: https://developers.facebook.com/docs/whatsapp/cloud-api
- Render Docs: https://render.com/docs/web-services#port-binding (PORT 10000)
- Google AI Studio: https://aistudio.google.com/app/apikey
- ngrok: https://ngrok.com/download
- GitHub: https://github.com/ENGMOHAMADALAGHA/kareem-whatsapp-agent
- Render Service: https://dashboard.render.com/web/srv-dabjdru1egvs73b15050 (ID: srv-dabjdru1egvs73b15050)

---

*آخر تحديث: 2026-09-02 00:41 - Deploy 94bb2ea live*
