# النشر على RDP خاص (Windows VPS) - لاحقاً

> الهدف: نفس الكود على GitHub يشتغل على سيرفرك الخاص بدل Render المجاني.

## 1. المتطلبات على الـ RDP
- Windows Server + Node.js 20+ (https://nodejs.org)
- Git (https://git-scm.com/download/win)
- منفذ مفتوح: 3000 (أو 80/443 عبر reverse proxy)
- PM2 لإبقاء السيرفر شغال: `npm i -g pm2`

## 2. أول تنصيب
```powershell
git clone https://github.com/ENGMOHAMADALAGHA/kareem-whatsapp-agent.git C:\bots\kareem
cd C:\bots\kareem
npm install
Copy-Item .env.example .env
notepad .env   # عبّي المفاتيح الحقيقية
npm test       # لازم 8 اختبارات ناجحة
pm2 start server.mjs --name kareem
pm2 startup
pm2 save
```

## 3. ملف .env على الـ RDP
```
AI_PROVIDER=google
GOOGLE_API_KEY=AIza... (مفتاحك)
AI_MODEL=gemini-flash-lite-latest
PORT=3000
WEBHOOK_VERIFY_TOKEN=my_secret_token
WHATSAPP_TOKEN=EAA... (من Meta)
WHATSAPP_PHONE_ID=1300758353117196
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
- `tenants.json` + `.env` + logs PM2 (`pm2 logs kareem`)
- لا ترفع `.env` على GitHub أبداً.

## 8. الفرق عن Render
| | Render Free | RDP خاص |
|---|---|---|
| النوم | ينام بعد 15د (يحتاج keep-alive) | شغال 24/7 |
| HTTPS | جاهز | أنت تجهزه (Cloudflare) |
| التحديث | Auto-Deploy من GitHub | `git pull + pm2 restart` |
| التكلفة | $0 | سعر الـ VPS |
