// سجل القنوات: نقطة الوصول الوحيدة للقناة حسب المعرف
import { whatsappChannel } from "./whatsapp.mjs";
import { messengerChannel } from "./messenger.mjs";
import { instagramChannel } from "./instagram.mjs";

const CHANNELS = {
  whatsapp: () => whatsappChannel,
  messenger: () => messengerChannel,
  instagram: () => instagramChannel,
};

export function channelError(channelId, reason) {
  const e = new Error(`قناة ${channelId} غير جاهزة: ${reason}`);
  e.code = "CHANNEL_NOT_READY";
  return e;
}

export function notReady(channelId, reason) {
  throw channelError(channelId, reason);
}

export function getChannel(channelId = "whatsapp") {
  const make = CHANNELS[channelId];
  if (!make) throw channelError(channelId, "معرف قناة غير معروف");
  return make();
}

export function channelIds() {
  return Object.keys(CHANNELS);
}

// نوع الحدث الوارد ← القناة (للموزع): واتساب object ثابت، ماسنجر/انستغرام messaging
export function channelForWebhookObject(object) {
  if (object === "whatsapp_business_account") return "whatsapp";
  if (object === "page" || object === "instagram") return object === "page" ? "messenger" : "instagram";
  return null;
}
