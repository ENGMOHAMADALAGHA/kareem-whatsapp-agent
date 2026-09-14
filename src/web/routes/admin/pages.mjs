// صفحات HTML: لوحة الإدارة + بوابة العميل
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// admin.html lives at repo root; this file is at src/web/routes/admin/ (4 مستويات للأعلى)
const ADMIN_HTML = path.join(__dirname, "..", "..", "..", "..", "admin.html");

export function registerPageRoutes(app) {
  app.get("/admin/", (req, res) => {
    res.sendFile(ADMIN_HTML);
  });
  app.get("/portal/", (req, res) => {
    res.sendFile(path.join(ADMIN_HTML, "..", "client.html"));
  });
}
