// نطاق العملاء + رفض العام — مشترك لكل راوترات /admin الفرعية
// Fail-closed: عميل JWT يرى بوته فقط، والعام يتطلب سوبر أدمن.
export function resolveScope(req, explicitTenant) {
  if (req.clientTenant) return { tenant: req.clientTenant, global: false };
  const t = explicitTenant || req.query.tenant || req.body?.tenantId || req.body?.tenant || null;
  if (t) return { tenant: t, global: false };
  if (req.isSuperAdmin) return { tenant: null, global: true };
  return { tenant: null, global: false, denied: true };
}
export function denyGlobal(res) {
  return res.status(403).json({ ok: false, error: "غير مصرح — حدد tenant أو سجل كسوبر أدمن" });
}
