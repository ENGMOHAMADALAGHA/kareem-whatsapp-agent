// محوّل انستغرام — هيكل جاهز، التنفيذ عند تفعيل المنتج من Meta.
// المطلوب من Meta قبل التفعيل:
//  1) منتج Instagram على نفس التطبيق + حساب تجاري/منشئ محتوى مربوط بصفحة.
//  2) صلاحية instagram_manage_messages عبر App Review.
//  3) اشتراك Webhook بحقل messaging + Verify Token.
// السياسة: نافذة 24h + وسوم (tags) خارجها — تُطبق في compliance لاحقاً.
import { notReady } from "./registry.mjs";

export const instagramChannel = {
  id: "instagram",
  supportsMedia: true,
  receiverId() {
    return notReady("instagram", "اربط منتج Instagram وحساب العميل أولاً");
  },
  extractText() {
    return notReady("instagram", "استقبال انستغرام غير مفعّل بعد");
  },
  extractMedia() {
    return notReady("instagram", "وسائط انستغرام غير مفعّلة بعد");
  },
  normalizeSender(igsid) {
    return `ig:${igsid}`;
  },
  sendText() {
    return notReady("instagram", "إرسال انستغرام غير مفعّل بعد");
  },
  sendButtons() {
    return notReady("instagram", "أزرار انستغرام غير مفعّلة بعد");
  },
  sendImage() {
    return notReady("instagram", "صور انستغرام غير مفعّلة بعد");
  },
};
