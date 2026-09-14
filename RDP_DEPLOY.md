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
git clone https://github.com/ENGMOHAMADALAGHA/wasl-command-center.git C:\bots\wasl
cd C:\bots\wasl
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
> **قاعدة قائمة (Neon الحالي):** التخطي — الجداول موجودة. لا تشغّل `db:init` فوقها
> (لا تغيير، لكن لا داعي للخطر أيضاً).
> **تغيير مستقبلي بالـ schema.prisma:** نُنشئ migration حقيقي ولا نعدّل schema.sql يدوياً
> (مبدئياً: `prisma migrate diff --from-empty --to-schema ...` للحصول على أساس، مع مراجعة يدوية).

### 2ج) تجربة
```powershell
node --check *.mjs
npm test       # اختبارات الوحدات (node:test): تشفير/توقيت/طلبات/طابور/CSRF
npm run test:ai  # اختياري: دخان AI (يستهلك API) — 8 سيناريوهات
pm2 start ecosystem.config.cjs   # الاسم والحدود من الملف (wasl)
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
cd C:\bots\wasl
git pull origin main
pm2 restart wasl
```

## 6. إضافة بوت جديد (عيادة/متجر) بدون سيرفر جديد — رقم واحد لكل بوت
```powershell
# 1) أنشئ البوت (مصادقة السوبر إجبارية + رقم غير مستخدم + توكن خاص):
curl.exe -u admin:ADMIN_PASS -X POST http://localhost:3000/admin/tenants -H "Content-Type: application/json" -d '{\"id\":\"agha-dental\",\"name\":\"عيادة ...\",\"botName\":\"ليان\",\"businessType\":\"dental\",\"phoneNumberId\":\"PHONE_ID\",\"verifyToken\":\"RANDOM_TOKEN\",\"products\":[{\"name\":\"تنظيف\",\"price\":30}],\"deliveryFee\":0}'
# يرجع 201 -> 2) افحص الربط: POST /admin/tenants/:id/test-link -> linked:true
# 3) أنشئ دعوة عميل: POST /admin/invites {tenantId, phone} -> tempPassword
# 4) أعطِ العميل: رابط البوابة + رقمه + كلمته المؤقتة
```

## 7. نسخ احتياطي
- البيانات في **PostgreSQL (Neon)** — شغّل `npm run backup` (تدوير 7 نسخ) + فعّل PITR من لوحة Neon.
- لـ RDP المحلي: جدولة `npm run backup` يومياً عبر Task Scheduler (تستخدم `BACKUP_DIR/BACKUP_KEEP`).
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

## 10. الفرق عن Render
| | Render Free | RDP خاص |
|---|---|---|
| النوم | ينام بعد 15د (يحتاج keep-alive) | شغال 24/7 |
| HTTPS | جاهز | أنت تجهزه (Cloudflare) |
| التحديث | Auto-Deploy من GitHub | `git pull + pm2 restart` |
| التكلفة | $0 | سعر الـ VPS |
