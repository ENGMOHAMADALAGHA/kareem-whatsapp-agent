// واجهة توافق: المنطق انتقل إلى ./admin/ (6 راوترات فرعية حسب المسؤولية)
// يُبقي كل الاستيرادات القديمة `from "./routes/admin.mjs"` شغالة بلا تغيير.
export { registerAdminRoutes } from "./admin/index.mjs";
