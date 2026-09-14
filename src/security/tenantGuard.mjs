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
      // تحديث/حذف مفرد: ذري مشروط بالنطاق — يستبعد التحقق-ثم-التنفيذ (لا TOCTOU).
      // updateMany/deleteMany مع where يتضمن tenantId تستبعد السجلات من نطاقات أخرى
      // في استعلام واحد، والعدّ يخبرنا إن كان السجل موجوداً ضمن النطاق أصلاً.
      if (op === "update") {
        return async (args = {}) => {
          const upd = await target
            .updateMany({ where: { ...args.where, tenantId }, data: args.data })
            .catch(() => ({ count: 0 }));
          if (!upd?.count) {
            const e = new Error("السجل غير موجود في نطاقك");
            e.code = "TENANT_DENIED";
            throw e;
          }
          return target.findUnique({ where: args.where }).catch(() => null);
        };
      }
      if (op === "delete") {
        return async (args = {}) => {
          // ذري: حذف مشروط واحد — بلا قراءة مسبقة (لا TOCTOU).
          // نعيد null عند عدم التطابق بدل كشف وجود سجل خارج النطاق.
          const del = await target
            .deleteMany({ where: { ...args.where, tenantId } })
            .catch(() => ({ count: 0 }));
          if (!del?.count) return null;
          return { deleted: true, count: del.count };
        };
      }
      if (op === "upsert") {
        return async (args = {}) => {
          // where يُمرَّر كما هو (Prisma يشترط unique نقي: {id} أو {tenantId_phone} —
          // أي حقن لـ tenantId بجانبه يرمي validation error).
          // الأمان عبر فحص مسبق: tenantId الصف لا يتغير أبداً، فلا نافذة سباق حقيقية —
          // سجل نطاق آخر يُرفض قبل أي كتابة، والإنشاء يُسكب بالنطاق.
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

// مخرج معلن للعمليات العامة فقط (مجدول/سوبر أدمن) — يُسجَّل تحذير دائماً.
// القاعدة: أي مسار يخص بوتاً معيناً ممنوع يستخدمه، لازم tenantDb.
export function systemDb(caller = "unknown") {
  console.warn(`  ⚠️ وصول عام بدون نطاق من: ${caller}`);
  return db();
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
