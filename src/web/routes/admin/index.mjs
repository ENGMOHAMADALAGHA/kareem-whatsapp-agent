// فهرس راوترات /admin — كل مجموعة في ملف مستقل بمسؤولية واحدة
// كان ملفاً واحداً (725 سطر / 40 راوت) — الآن 6 ملفات ~100-200 سطر لكل منها.
import { registerTenantRoutes } from "./tenants.mjs";
import { registerBookingRoutes } from "./bookings.mjs";
import { registerOrderRoutes } from "./orders.mjs";
import { registerEngageRoutes } from "./engage.mjs";
import { registerInboxRoutes } from "./inbox.mjs";
import { registerPageRoutes } from "./pages.mjs";

export function registerAdminRoutes(app) {
  registerTenantRoutes(app); // البوتات + المستخدمون + الدعوات + فحص الربط
  registerBookingRoutes(app); // الحجوزات + الانتظار + التذكير
  registerOrderRoutes(app); // الطلبات + الإيصالات + السلة المهجورة
  registerEngageRoutes(app); // البث + التقارير + التقييم + CRM
  registerInboxRoutes(app); // المحادثات الحية + takeover + إرسال
  registerPageRoutes(app); // صفحات HTML
}
