@echo off
REM Wasl hidden launcher helper - called by Wasl-Desktop.vbs (windowStyle 0)
cd /d "%~dp0.."
if not exist "node_modules\electron" (
  echo [%date% %time%] installing electron...
  call npm install --save-dev electron
)
echo [%date% %time%] starting electron...
call npx electron .
echo [%date% %time%] electron exited code=%errorlevel%
