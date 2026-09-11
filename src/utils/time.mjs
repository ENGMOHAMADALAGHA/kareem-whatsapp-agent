// تاريخ الأعمال في المنطقة الأردنية (Asia/Amman) — الحجوزات والتذكيرات
// وتسميات "اليوم/غداً" تُحسب بعمق المنطقة لا بـ UTC (يدعم الأردن +3).
export function ammanDateStr(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Amman",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}