// ──────────────────────────────────────────────
// القاعدة الذهبية: كل الوصول للداتا يمر من هنا.
// - tenantId إجباري: مستحيل استعلام بدون نطاق.
// - القراءة تُفلتر تلقائياً، والكتابة تُجبر على نفس الـ tenant.
// - findUnique/update/delete تتحقق بعد الجلب (لأن المفتاح الفريد لا يقبل حقن tenantId).
// ──────────────────────────────────────────────
import { db } from "../../db.mjs";

const TENANT_MODELS = new Set([
  "message",
  "order",
  "appointment",
  "rating",
  "broadcast",
  "event",
  "tenantUser",
]);

function scopedWhere(tenantId, where) {
  return { ...(where || {}), tenantId };
}

function scopedData(tenantId, data) {
  if (Array.isArray(data)) return data.map((d) => ({ ...d, tenantId }));
  return { ...(data || {}), tenantId };
}

function checkRow(tenantId, row) {
  if (!row) return null;
  if (row.tenantId !== tenantId) return null; // تسرب مرفوض
  return row;
}

function wrapModel(delegate, model, tenantId) {
  return new Proxy(delegate, {
    get(target, op) {
      const fn = target[op];
      if (typeof fn !== "function") return fn;

      // قراءة جماعية: حقن تلقائي
      if (["findMany", "findFirst", "count", "aggregate", "groupBy"].includes(op)) {
        return (args = {}) => fn.call(target, { ...args, where: scopedWhere(tenantId, args.where) });
      }
      if (["updateMany", "deleteMany"].includes(op)) {
        return (args = {}) => fn.call(target, { ...args, where: scopedWhere(tenantId, args.where) });
      }
      // إنشاء: فرض النطاق
      if (op === "create") {
        return (args = {}) => fn.call(target, { ...args, data: scopedData(tenantId, args.data) });
      }
      if (op === "createMany") {
        return (args = {}) => fn.call(target, { ...args, data: scopedData(tenantId, args.data) });
      }
      // قراءة مفردة: تحقق بعد الجلب
      if (op === "findUnique") {
        return async (args = {}) => checkRow(tenantId, await fn.call(target, args));
      }
      // تحديث/حذف مفرد: تحقق ثم نفّذ (حماية من TOCTOU بالحد الأدنى المقبول)
      if (op === "update") {
        return async (args = {}) => {
          const existing = await target.findUnique({ where: args.where, select: { tenantId: true } }).catch(() => null);
          if (!existing || existing.tenantId !== tenantId) {
            const e = new Error("السجل غير موجود في نطاقك");
            e.code = "TENANT_DENIED";
            throw e;
          }
          return fn.call(target, args);
        };
      }
      if (op === "delete") {
        return async (args = {}) => {
          const existing = await target.findUnique({ where: args.where, select: { tenantId: true } }).catch(() => null);
          if (!existing || existing.tenantId !== tenantId) {
            const e = new Error("السجل غير موجود في نطاقك");
            e.code = "TENANT_DENIED";
            throw e;
          }
          return fn.call(target, args);
        };
      }
      if (op === "upsert") {
        return async (args = {}) => {
          const existing = await target.findUnique({ where: args.where }).catch(() => null);
          if (existing && existing.tenantId !== tenantId) {
            const e = new Error("السجل غير موجود في نطاقك");
            e.code = "TENANT_DENIED";
            throw e;
          }
          return fn.call(target, {
            ...args,
            create: scopedData(tenantId, args.create),
          });
        };
      }
      // raw queries ممنوعة عبر النطاق
      if (op === "$queryRaw" || op === "$executeRaw") {
        return () => {
          throw new Error("الاستعلام الخام ممنوع عبر tenantDb — استخدم عمليات Prisma");
        };
      }
      return (...args) => fn.apply(target, args);
    },
  });
}

export function tenantDb(tenantId) {
  if (!tenantId || typeof tenantId !== "string") {
    throw new Error("tenantId مطلوب — ممنوع الوصول للداتا بدون نطاق");
  }
  const client = db();
  return new Proxy(
    {},
    {
      get(_, model) {
        if (!TENANT_MODELS.has(model)) {
          throw new Error(`النموذج "${model}" خارج العزل — الوصول المباشر ممنوع`);
        }
        return wrapModel(client[model], model, tenantId);
      },
    }
  );
}

// فحص سريع: هل هذا السجل يخص هذا الـ tenant؟
export function assertTenant(tenantId, row) {
  if (!row || row.tenantId !== tenantId) {
    const e = new Error("السجل غير موجود في نطاقك");
    e.code = "TENANT_DENIED";
    throw e;
  }
  return row;
}
