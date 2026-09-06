@echo off
REM ============================================================
REM  One-Click Launcher (Windows) - whatsapp-ai-agent
REM  Double-click this file: boots the server + opens Admin UI
REM ============================================================
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed or not in PATH.
  echo         Download it from https://nodejs.org/
  pause
  exit /b 1
)

if not exist ".env" (
  echo [WARN] .env not found - running with defaults.
  echo        Copy .env.example to .env and fill in keys for production.
  echo.
)

if not exist "node_modules" (
  echo [INFO] node_modules missing - running npm install first...
  call npm install
  echo.
)

echo [INFO] Starting server + opening Admin UI...
node scripts\dev-ui.mjs
pause
