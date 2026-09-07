// ──────────────────────────────────────────────
// Wasl Command Center — Electron desktop shell (native window, no browser UI)
// Boots the Express backend (server.mjs), waits for the port, opens /admin/.
// ──────────────────────────────────────────────
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const { app, BrowserWindow } = require("electron");
const { spawn } = require("node:child_process");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.PORT || 3000);
const ADMIN_URL = `http://localhost:${PORT}/admin/?desktop=1`;
let backend = null;
let win = null;

function waitForPort(port, timeoutMs = 45000) {
  const start = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: 2000 }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on("error", () => {
        if (Date.now() - start > timeoutMs) return resolve(false);
        setTimeout(tick, 500);
      });
      req.on("timeout", () => req.destroy());
    };
    tick();
  });
}

function startBackend() {
  backend = spawn(process.execPath, ["server.mjs"], {
    cwd: ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  backend.stdout.on("data", (d) => process.stdout.write(`[server] ${d}`));
  backend.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  backend.on("exit", (code) => console.log(`[shell] backend exited code=${code}`));
}

function createWindow() {  const iconPng = path.join(ROOT, "assets", "icon.png");
  win = new BrowserWindow({
    width: 1400,
    height: 920,
    minWidth: 1080,
    minHeight: 680,
    title: "Wasl Command Center — وصل",
    backgroundColor: "#0b1220",
    autoHideMenuBar: true,
    ...(fs.existsSync(iconPng) ? { icon: iconPng } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // حصر التنقل داخل الكونسول المحلي + منع النوافذ المنبثقة
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e, url) => {
    try {
      const u = new URL(url);
      const local = (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1") && Number(u.port) === PORT;
      if (!local) e.preventDefault();
    } catch {
      e.preventDefault();
    }
  });
  win.webContents.on("did-finish-load", async () => {
    console.log("[shell] WINDOW_READY " + ADMIN_URL);
    // تشخيص (SHELL_DEBUG=1 فقط): تأكيد rendering واجهة كاملة لا JSON خام
    if (process.env.SHELL_DEBUG) {
      try {
        const title = await win.webContents.executeJavaScript("document.title", true);
        const hasApp = await win.webContents.executeJavaScript("!!document.getElementById('tab-bots')", true);
        console.log(`[shell] DEBUG title=${JSON.stringify(title)} consoleUI=${hasApp}`);
      } catch (e) {
        console.log(`[shell] DEBUG probe failed: ${e.message}`);
      }
    }
  });
  win.on("closed", () => { win = null; });
  win.loadURL(ADMIN_URL);
}

// دخول تلقائي للوحة المدير (تطوير محلي فقط — loopback حصراً).
// يمنع نافذة الـ 401 JSON ويحقن Basic Auth من .env مباشرة.
function isLoopbackAdmin(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:") return false;
    if (!(u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1")) return false;
    if (Number(u.port) !== PORT) return false;
    return u.pathname === "/admin/" || u.pathname.startsWith("/admin/");
  } catch {
    return false;
  }
}
app.on("login", (event, webContents, details, authInfo, callback) => {
  if (!details || !isLoopbackAdmin(details.url || "")) return; // لا تحقن خارج كونسول localhost أبداً
  event.preventDefault();
  const user = process.env.ADMIN_USER || "admin";
  const pass = process.env.ADMIN_PASS || "admin123";
  console.log("[shell] auto-login injected for localhost admin console");
  callback(user, pass);
});

app.whenReady().then(async () => {
  // Single instance: focus existing window instead of a second backend.
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  startBackend();
  const up = await waitForPort(PORT);
  if (!up) {
    console.error("[shell] backend did not respond — opening window anyway (check logs).");
  }
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("second-instance", () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

app.on("window-all-closed", () => {
  try { backend && backend.kill("SIGINT"); } catch { /* noop */ }
  if (process.platform !== "darwin") app.quit();
});

app.on("quit", () => {
  try { backend && backend.kill("SIGINT"); } catch { /* noop */ }
});
