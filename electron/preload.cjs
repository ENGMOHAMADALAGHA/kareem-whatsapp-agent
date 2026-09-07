// Preload: expose a minimal desktop flag (no Node access in renderer).
const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  isDesktop: true,
  platform: process.platform,
  versions: {
    electron: process.versions.electron || "",
    chrome: process.versions.chrome || "",
  },
});
