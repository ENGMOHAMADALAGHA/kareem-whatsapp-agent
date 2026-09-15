// ──────────────────────────────────────────────
// طبقة القنوات لمنصة وصل: واتساب + ماسنجر + انستغرام.
// العقد الموحد: كل قناة تحول حدثها لرسالة عالمية (UniversalMessage)
// وتُرسل عبر نفس الواجهة — المنصة (AI/حجز/طلبات) لا تعرف القناة.
// ──────────────────────────────────────────────
//
// UniversalMessage = {
//   channel: "whatsapp" | "messenger" | "instagram",
//   msgId: string|null,        // wamid / mid للـ dedup
//   from: string,              // مرسل موحد (E.164 لواتساب، PSID/IGSID لغيره)
//   to: string|null,           // معرف البوت المستقبل (phone_number_id / page_id)
//   name: string,              // اسم العرض
//   text: string,              // نص (بعد تفريغ الفويس إن وجد)
//   buttonId: string|null,
//   media: { kind: "audio"|"image"|"document"|null, id: string|null, mimeType: string|null, caption: string } | null,
//   raw: object,               // الحدث الأصلي للاحتياط
// }
//
// واجهة القناة:
//   id, supportsMedia, extractText(raw)->{text,buttonId,name},
//   extractMedia(raw)->media|null, senderId(raw)->string|null,
//   sendText(to,text,tenant), sendButtons(...), sendImage(...)
