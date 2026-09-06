import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { tenantDb, systemDb } from "./src/security/tenantGuard.mjs";

function secret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET غير مضبوط في البيئة");
  return s;
}

// —— حسابات العملاء (يستدعيها السوبر أدمن فقط) ——
export async function createClientUser({ tenantId, name, phone, password }) {
  if (!tenantId || !phone || !password) throw new Error("tenantId و phone و password مطلوبة");
  if (String(password).length < 6) throw new Error("كلمة السر 6 أحرف على الأقل");
  const passwordHash = await bcrypt.hash(String(password), 10);
  return tenantDb(tenantId).tenantUser.upsert({
    where: { tenantId_phone: { tenantId, phone } },
    update: { name: name || undefined, passwordHash },
    create: {
      id: `usr_${Date.now().toString(36)}`,
      phone, name: name || phone, passwordHash,
    },
  });
}

export async function verifyClientUser(tenantId, phone, password) {
  if (!tenantId || !phone) return null;
  const u = await tenantDb(tenantId).tenantUser.findUnique({
    where: { tenantId_phone: { tenantId, phone } },
    include: { tenant: true },
  });
  if (!u) return null;
  if (u.tenant && u.tenant.enabled === false) return { disabled: true };
  const ok = await bcrypt.compare(String(password), u.passwordHash);
  if (!ok) return null;
  return u;
}

export function signClientToken(user) {
  return jwt.sign(
    { sub: user.id, tenantId: user.tenantId, phone: user.phone, role: "client" },
    secret(),
    { expiresIn: "30d" }
  );
}

export function verifyClientToken(token) {
  try {
    const p = jwt.verify(token, secret());
    if (p.role !== "client" || !p.tenantId) return null;
    return p;
  } catch {
    return null;
  }
}

// —— نسيت كلمة السر: كود من 6 أرقام عبر واتساب ——
export async function startPasswordReset(tenantId, phone, sendFn) {
  if (!tenantId || !phone) return { ok: false };
  const u = await tenantDb(tenantId).tenantUser.findUnique({
    where: { tenantId_phone: { tenantId, phone } },
  });
  if (!u) return { ok: false }; // لا نكشف وجود الحساب
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const codeHash = await bcrypt.hash(code, 8);
  await tenantDb(tenantId).tenantUser.update({
    where: { id: u.id },
    data: { resetCode: codeHash, resetExpires: new Date(Date.now() + 15 * 60 * 1000) },
  });
  await sendFn(`رمز إعادة تعيين كلمة السر: ${code}\nصالح 15 دقيقة. لا تشاركه مع أحد.`);
  return { ok: true };
}

export async function finishPasswordReset(tenantId, phone, code, newPassword) {
  if (!tenantId || !phone) throw new Error("بيانات ناقصة");
  if (!newPassword || String(newPassword).length < 6) throw new Error("كلمة السر 6 أحرف على الأقل");
  const u = await tenantDb(tenantId).tenantUser.findUnique({
    where: { tenantId_phone: { tenantId, phone } },
  });
  if (!u || !u.resetCode || !u.resetExpires || u.resetExpires < new Date()) {
    throw new Error("الرمز غير صالح أو منتهي");
  }
  const ok = await bcrypt.compare(String(code), u.resetCode);
  if (!ok) throw new Error("الرمز غير صحيح");
  await tenantDb(tenantId).tenantUser.update({
    where: { id: u.id },
    data: { passwordHash: await bcrypt.hash(String(newPassword), 10), resetCode: null, resetExpires: null },
  });
  return true;
}

// قائمة المستخدمين — سوبر أدمن فقط (مسار معلن)
export async function listClientUsers(tenantId) {
  const T = tenantId ? tenantDb(tenantId) : systemDb("portal:users");
  return T.tenantUser.findMany({
    where: {},
    select: { id: true, tenantId: true, name: true, phone: true, createdAt: true },
    take: 200,
  });
}
