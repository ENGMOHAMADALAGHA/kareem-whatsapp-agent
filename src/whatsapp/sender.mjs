// ──────────────────────────────────────────────
// طبقة واتساب: الإرسال فقط (نص / أزرار / صورة)
// لا تعرف شيئاً عن AI أو المنطق — تستقبل tenant جاهزاً.
// ──────────────────────────────────────────────
import { resolveTenantInput } from "../../tenants.mjs";
import { WHATSAPP_TOKEN, WHATSAPP_PHONE_ID } from "../config/env.mjs";

async function creds(tenantInput) {
  const tenant = await resolveTenantInput(tenantInput);
  return {
    tenant,
    token: tenant?.whatsapp_token || WHATSAPP_TOKEN,
    phoneId: tenant?.phone_number_id || WHATSAPP_PHONE_ID,
  };
}

function isDemo(token, phoneId) {
  return !token || token === "DEMO_WHATSAPP_TOKEN" || !phoneId || phoneId === "DEMO_PHONE_ID";
}

export async function sendWhatsAppMessage(to, text, tenantInput = null) {
  const { token, phoneId } = await creds(tenantInput);

  if (isDemo(token, phoneId)) {
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

// إرسال generic (نص / أزرار / صورة) - نفس التوكن لكل بوت
async function sendPayload(to, payload, tenantInput = null) {
  const { token, phoneId } = await creds(tenantInput);

  if (isDemo(token, phoneId)) {
    console.log(`  📤 [محاكاة إرسال ${payload.type}] إلى ${to}: ${JSON.stringify(payload).slice(0, 200)}`);
    return { simulated: true, to, payload };
  }
  const url = `https://graph.facebook.com/v18.0/${phoneId}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, ...payload }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`);
  console.log(`  ✅ تم الإرسال (${payload.type}) إلى ${to} | ID: ${data.messages?.[0]?.id || "N/A"}`);
  return data;
}

export async function sendButtons(to, bodyText, buttons, tenantInput = null) {
  const btns = (buttons || []).slice(0, 3).map((b, i) => ({
    type: "reply",
    reply: { id: b.id || `btn_${i}`, title: (b.title || `خيار ${i + 1}`).slice(0, 20) },
  }));
  if (!btns.length) return sendWhatsAppMessage(to, bodyText, tenantInput);
  return sendPayload(to, {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: bodyText.slice(0, 1024) },
      action: { buttons: btns },
    },
  }, tenantInput);
}

export async function sendImage(to, link, caption = "", tenantInput = null) {
  return sendPayload(to, {
    type: "image",
    image: { link, caption: caption.slice(0, 1024) },
  }, tenantInput);
}

// أزرار افتراضية لكل tenant من منتجاته
export async function defaultButtonsFor(tenant) {
  const t = await resolveTenantInput(tenant);
  if (t?.id === "kareem-sport") {
    return [
      { id: "buy_shoes", title: "👟 الحذاء $50" },
      { id: "buy_belt", title: "💪 الحزام $20" },
      { id: "bundle", title: "🎁 العرض $70" },
    ];
  }
  const btns = (t.products || []).slice(0, 2).map((p) => ({
    id: p.buttonId || p.name,
    title: `${p.name} $${p.price}`.slice(0, 20),
  }));
  if (t?.features?.booking) btns.push({ id: "booking", title: "📅 احجز موعد" });
  return btns.slice(0, 3);
}
