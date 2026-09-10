// ──────────────────────────────────────────────
// توحيد أرقام الهواتف: كل الصيغ → E.164 أرقام فقط (الأردن 962 افتراضياً)
// 079... / 00962... / +962... / 962... → 962790362429
// غير الرقمي (مثل "default") يُترك كما هو.
// ──────────────────────────────────────────────
const DEFAULT_COUNTRY = "962";

export function normalizePhone(input, defaultCountry = DEFAULT_COUNTRY) {
  if (input === null || input === undefined) return input;
  let s = String(input).trim();
  if (!s) return s;
  const hasPlus = s.startsWith("+");
  const d = s.replace(/\D/g, "");
  if (!d) return s;
  if (hasPlus) return d;
  if (d.startsWith("00")) {
    const rest = d.slice(2);
    return rest || d;
  }
  if (d.startsWith(defaultCountry)) return d;
  // أردني محلي: 07XXXXXXXX (10 خانات) أو 7XXXXXXXX (9 خانات)
  if (/^07\d{8}$/.test(d)) return defaultCountry + d.slice(1);
  if (/^7\d{8}$/.test(d)) return defaultCountry + d;
  return d;
}

// مقارنة متسامحة (آخر 9 أرقام) لصيغ مختلفة لنفس الرقم
export function samePhone(a, b) {
  const da = String(a || "").replace(/\D/g, "");
  const db = String(b || "").replace(/\D/g, "");
  if (!da || !db) return false;
  if (da === db) return true;
  return da.slice(-9) === db.slice(-9) && da.slice(-9).length >= 9;
}
