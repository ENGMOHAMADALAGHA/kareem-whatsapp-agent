# النشر على RDP خاص (Windows VPS) - لاحقاً

> الهدف: نفس الكود على GitHub يشتغل على سيرفرك الخاص بدل Render المجاني.

## 1. المتطلبات على الـ RDP
- Windows Server + Node.js 20+ (https://nodejs.org)
- Git (https://git-scm.com/download/win)
- منفذ مفتوح: 3000 (أو 80/443 عبر reverse proxy)
- PM2 لإبقاء السيرفر شغال: `npm i -g pm2`
- قاعدة البيانات: PostgreSQL (Supabase أو محلي) مع `DATABASE_URL` جاهز

## 2. أول تنصيب
```powershell
git clone https://github.com/ENGMOHAMADALAGHA/kareem-whatsapp-agent.git C:\bots\kareem
cd C:\bots\kareem
Copy-Item .env.example .env
notepad .env   # عبّي المفاتيح الحقيقية (لازم DATABASE_URL أولاً)
npm install
```

### 2ب) إنشاء/تهيئة قاعدة البيانات (خطوة حرجة)
> **قاعدة فارغة على Postgres جديد:**
> ```powershell
> npm run db:sql   # يعيد توليد prisma/schema.sql من schema.prisma (رفيف)
> npm run db:init  # يطبّق المخطط فقط على قاعدة لا تحتوي tenants — آمن
> ```
> **قاعدة قائمة (Supabase الحالي):** التخطي — الجداول موجودة. لا تشغّل `db:init` فوقها
> (لا تغيير، لكن لا داعي للخطر أيضاً).
> **تغيير مستقبلي بالـ schema.prisma:** نُنشئ migration حقيقي ولا نعدّل schema.sql يدوياً
> (مبدئياً: `prisma migrate diff --from-empty --to-schema ...` للحصول على أساس، مع مراجعة يدوية).

### 2ج) تجربة
```powershell
node --check *.mjs
npm test       # اختبارات الوحدات (node:test): تشفير/توقيت/طلبات/طابور/CSRF
npm run test:ai  # اختياري: دخان AI (يستهلك API) — 8 سيناريوهات
pm2 start server.mjs --name kareem
pm2 startup
pm2 save
# فحص البقاء:
curl http://localhost:3000/healthz   # → {"ok":true,...}
```

## 3. ملف .env على الـ RDP
```
AI_PROVIDER=google
GOOGLE_API_KEY=AIza... (مفتاحك)
AI_MODEL=gemini-flash-lite-latest
PORT=3000
WEBHOOK_VERIFY_TOKEN=<توكين قوي عشوائي — الافتراضي my_secret_token مرفوض إنتاجياً>
WHATSAPP_TOKEN=EAA... (من Meta)
WHATSAPP_PHONE_ID=1300758353117196
TOKEN_ENC_KEY=<نص عشوائي عريض 32+ حرف>   # إجباري: يحفظ توكن كل بوت من /admin مشفّراً (AES-256-GCM) — بدونه يُرفض الحفظ
# لبوتات إضافية لاحقاً: WHATSAPP_TOKEN_<TENANT> أو عبر /admin/tenants
```

## 4. ربط دومين + HTTPS (مطلوب لواتساب)
- واتساب يطلب `https://` — خيار 1: Cloudflare Tunnel (مجاني):
```powershell
cloudflared tunnel --url http://localhost:3000
# يعطيك https://xxxx.trycloudflare.com -> حطه في Meta كـ Webhook URL
```
- خيار 2: دومين + IIS/Nginx reverse proxy + Let's Encrypt.

## 5. تحديث الكود لاحقاً
```powershell
cd C:\bots\kareem
git pull origin main
pm2 restart kareem
```

## 6. إضافة بوت جديد (عيادة/متجر) بدون سيرفر جديد
```powershell
curl -X POST http://localhost:3000/admin/tenants -H "Content-Type: application/json" -d "{\"id\":\"agha-dental\",\"name\":\"عيادة ...\",\"botName\":\"ليان\",\"businessType\":\"dental\",\"products\":[{\"name\":\"تنظيف\",\"price\":30}],\"deliveryFee\":0}"
# يرجع 201 -> أعطِ العميل: Webhook URL + Verify Token الخاص فيه
```

## 7. نسخ احتياطي
- البيانات في **PostgreSQL** (Supabase يوفّر PITR/PGBackups تلقائياً — فعّلها من لوحته).
- لـ RDP المحلي: جدولة `pg_dump` يومية:
  ```powershell
  # مهمة مجدولة يومياً:
  pg_dump "$env:DATABASE_URL" --format=custom -f "C:\bots\backups\wasl_$(Get-Date -Format yyyyMMdd).dump"
  ```
- `tenants.json` كان للنسخة القديمة قبل Postgres — أُزيل من الالتزام. لا ترفع `.env` على GitHub أبداً.

## 8. قالب Meta للمتابعة خارج نافذة 24 ساعة ⏰
> البوت لا يستطيع إرسال رسالة عادية بعد 24 ساعة من آخر رسالة العميل؛ يُرسل قالباً معتمداً
> بدل ذلك، أو يُشعر الموظف (سلوك مجرب — لا رسائل مفقودة بصمت).
1. Meta Business Suite ← **Account Tools ← Message Templates** (تظهر باللوحة من رابط الحساب).
2. أنشئ قالباً بصنف **"Follow up / خدمة عملاء"** — مثال بالعربية:
   `مرحباً {1} 👋 خدمة الترحيب غير تعمل؟ سنعود للرد قريباً.`
3. راجع/اعتمد القالب (عادة دقائق).
4. ضع اسمه كاملاً بصيغة **الاسم@اللغة** في `.env`:
   `WA_FOLLOWUP_TEMPLATE=wasl_followup@ar`
5. يمكنك تخصيصه لكل بوت عبر `tenant.features.followupTemplate`.

## 9. إيقاف بوت (مستوى التنان فقط)
- إيقاف/تشغيل يتم على **مستوى التنان** (زر في لوحة الأدمن `/admin`) — يُفعَّل عبر `tenant.enabled`.
- **لا يوجد إيقاف لمستخدم مفرد** في بوابة العميل (لا حقول معطلة) — أي لوحة تتظاهر بذلك غير موجودة
  في النظام. لعزل عميل مفرد: تواصل مع الإدارة أو اغلق بوت التنن كله.

## 8. الفرق عن Render
| | Render Free | RDP خاص |
|---|---|---|
| النوم | ينام بعد 15د (يحتاج keep-alive) | شغال 24/7 |
| HTTPS | جاهز | أنت تجهزه (Cloudflare) |
| التحديث | Auto-Deploy من GitHub | `git pull + pm2 restart` |
| التكلفة | $0 | سعر الـ VPS |
