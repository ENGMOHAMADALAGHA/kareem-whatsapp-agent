@echo off
REM ============================================================
REM  One-Click Desktop Launcher (Windows) - Kareem Command Center
REM  Double-click: boots the backend + opens the DESKTOP APP window
REM  (no browser). For browser mode use: npm run dev:ui
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

if not exist "node_modules\electron" (
  echo [INFO] Electron missing - installing desktop shell...
  call npm install --save-dev electron
  echo.
)

echo [INFO] Launching Kareem Command Center (desktop app)...
call npx electron .
pause
