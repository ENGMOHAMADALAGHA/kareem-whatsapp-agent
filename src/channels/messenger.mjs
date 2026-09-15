// محوّل ماسنجر — هيكل جاهز، التنفيذ عند تفعيل المنتج من Meta.
// المطلوب من Meta قبل التفعيل:
//  1) منتج Messenger على نفس التطبيق + صفحة فيسبوك لكل عميل.
//  2) صلاحية pages_messaging عبر App Review.
//  3) اشتراك Webhook بحقل messaging + Verify Token لكل صفحة.
// السياسة: نافذة 24h + وسوم (tags) خارجها — تُطبق في compliance لاحقاً.
import { notReady } from "./registry.mjs";

export const messengerChannel = {
  id: "messenger",
  supportsMedia: true,
  receiverId() {
    return notReady("messenger", "اربط منتج Messenger وصفحة العميل أولاً");
  },
  extractText() {
    return notReady("messenger", "استقبال ماسنجر غير مفعّل بعد");
  },
  extractMedia() {
    return notReady("messenger", "وسائط ماسنجر غير مفعّلة بعد");
  },
  normalizeSender(psid) {
    return `msg:${psid}`;
  },
  sendText() {
    return notReady("messenger", "إرسال ماسنجر غير مفعّل بعد");
  },
  sendButtons() {
    return notReady("messenger", "أزرار ماسنجر غير مفعّلة بعد");
  },
  sendImage() {
    return notReady("messenger", "صور ماسنجر غير مفعّلة بعد");
  },
};
