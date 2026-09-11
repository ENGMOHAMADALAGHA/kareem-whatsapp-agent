// ──────────────────────────────────────────────
// تشفير أسرار البوتات (توكن واتساب لكل tenant) — AES-256-GCM
// - TOKEN_ENC_KEY مهيأ → تشفير حقيقي بصيغة enc:v1:<iv>:<ct>:<tag> (base64).
// - بدونه → رفض التخزين صراحةً (لا plaintext إطلاقاً) مع قراءة شفافة لأي سجلات قديمة.
// ──────────────────────────────────────────────
import crypto from "node:crypto";
import { TOKEN_ENC_KEY } from "../config/env.mjs";

const PREFIX = "enc:v1:";

function key() {
  if (!TOKEN_ENC_KEY) return null;
  return crypto.createHash("sha256").update(String(TOKEN_ENC_KEY)).digest();
}

export function secretsConfigured() {
  return !!key();
}

export function encryptSecret(plain) {
  if (plain === null || plain === undefined || plain === "") return null;
  const k = key();
  if (!k) {
    // رفض قاطع: توكن بوت بلا تشفير أسوأ من لا توكن — يمنع سرقة توكنات Meta من DB
    throw new Error("TOKEN_ENC_KEY غير مضبوط — لا يمكن تخزين توكن بوت بدون تشفير. اضبط TOKEN_ENC_KEY في البيئة أولاً.");
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", k, iv);
  const ct = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}:${ct.toString("base64")}:${tag.toString("base64")}`;
}

export function decryptSecret(stored) {
  if (!stored) return null;
  // سجلات قديمة بلا بادئة (plaintext قبل فرض التشفير) — تُقرأ شفافاً حتى تُهاجر
  if (!String(stored).startsWith(PREFIX)) {
    console.warn("  ⚠️ سر بوت قديم مخزّن بلا تشفير — أعد حفظ التوكن بعد ضبط TOKEN_ENC_KEY لتدويره مشفّراً");
    return String(stored);
  }
  const k = key();
  if (!k) {
    console.error("  ❌ سر مشفر موجود لكن TOKEN_ENC_KEY مفقود — تعذر الفك");
    return null;
  }
  try {
    const [p0, p1, ivB, ctB, tagB] = String(stored).split(":");
    if (p0 !== "enc" || p1 !== "v1" || !ivB || !ctB || !tagB) throw new Error("صيغة غير متوقعة");
    const decipher = crypto.createDecipheriv("aes-256-gcm", k, Buffer.from(ivB, "base64"));
    decipher.setAuthTag(Buffer.from(tagB, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ctB, "base64")), decipher.final()]).toString("utf8");
  } catch (e) {
    console.error(`  ❌ فشل فك سر: ${e.message}`);
    return null;
  }
}
