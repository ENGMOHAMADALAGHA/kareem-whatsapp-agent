// ──────────────────────────────────────────────
// تشفير أسرار البوتات (توكن واتساب لكل tenant) — AES-256-GCM
// - TOKEN_ENC_KEY مهيأ → تشفير حقيقي بصيغة enc:v1:<iv>:<ct>:<tag> (base64).
// - بدونه → تخزين plaintext مع تحذير (تطوير محلي فقط)، والقراءة شفافة.
// ──────────────────────────────────────────────
import crypto from "node:crypto";
import { TOKEN_ENC_KEY } from "../config/env.mjs";

const PREFIX = "enc:v1:";
let warned = false;

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
    if (!warned) {
      console.warn("  ⚠️ TOKEN_ENC_KEY غير مضبوط — تُخزن أسرار البوتات plaintext (للتطوير فقط)");
      warned = true;
    }
    return String(plain);
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", k, iv);
  const ct = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}:${ct.toString("base64")}:${tag.toString("base64")}`;
}

export function decryptSecret(stored) {
  if (!stored) return null;
  if (!String(stored).startsWith(PREFIX)) return String(stored); // plaintext قديم/تطوير
  const k = key();
  if (!k) {
    console.error("  ❌ سر مشفر موجود لكن TOKEN_ENC_KEY مفقود — تعذر الفك");
    return null;
  }
  try {
    const [, ivB, ctB, tagB] = String(stored).split(":");
    const decipher = crypto.createDecipheriv("aes-256-gcm", k, Buffer.from(ivB, "base64"));
    decipher.setAuthTag(Buffer.from(tagB, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ctB, "base64")), decipher.final()]).toString("utf8");
  } catch (e) {
    console.error(`  ❌ فشل فك سر: ${e.message}`);
    return null;
  }
}
