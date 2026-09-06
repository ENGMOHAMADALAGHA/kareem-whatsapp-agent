#!/usr/bin/env bash
# ============================================================
#  One-Click Launcher (macOS/Linux) - whatsapp-ai-agent
#  Run: ./start-dev.sh  (or: npm run dev:ui)
#  Boots the server + opens the Admin UI in the browser
# ============================================================
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js is not installed or not in PATH."
  echo "        Download it from https://nodejs.org/"
  exit 1
fi

if [ ! -f ".env" ]; then
  echo "[WARN] .env not found - running with defaults."
  echo "       Copy .env.example to .env and fill in keys for production."
  echo
fi

if [ ! -d "node_modules" ]; then
  echo "[INFO] node_modules missing - running npm install first..."
  npm install
  echo
fi

echo "[INFO] Starting server + opening Admin UI..."
exec node scripts/dev-ui.mjs
