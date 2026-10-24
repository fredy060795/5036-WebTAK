@echo off
rem Helm Camera Streams - Test auf dem Windows-PC
rem Startet den Server auf http://localhost:5036 und oeffnet das Admin-Fenster.
rem Fenster offen lassen, solange getestet wird. Beenden: Fenster schliessen oder Strg+C.
setlocal
title Helm Camera Streams (Port 5036)
cd /d "%~dp0"

set PORT=5036
set DATA_DIR=%~dp0data
set URL=http://localhost:%PORT%

echo.
echo   Helm Camera Streams - Test am PC
echo   ================================
echo.

rem ---- Node.js vorhanden? ------------------------------------------------
where node >nul 2>nul
if not errorlevel 1 goto node_ok
echo Node.js ist nicht installiert.
where winget >nul 2>nul
if errorlevel 1 goto node_manual
choice /c JN /m "Node.js jetzt mit winget installieren"
if errorlevel 2 goto node_manual
winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
echo.
echo Node.js wurde installiert. Bitte dieses Fenster schliessen und start.bat erneut starten.
pause
exit /b 0
:node_manual
echo Bitte Node.js LTS von https://nodejs.org installieren und start.bat erneut starten.
pause
exit /b 1
:node_ok
for /f "delims=" %%v in ('node --version') do echo Node.js %%v gefunden.

rem ---- Pakete beim ersten Start installieren ------------------------------
if exist "node_modules\ws\package.json" goto deps_ok
echo Pakete werden installiert (einmalig, braucht Internet) ...
call npm ci --omit=dev --no-audit --no-fund
if errorlevel 1 (
  echo Installation fehlgeschlagen. Internetverbindung pruefen.
  pause
  exit /b 1
)
:deps_ok

rem ---- ffmpeg (optional, fuer HLS und MPEG-TS) ----------------------------
where ffmpeg >nul 2>nul
if not errorlevel 1 goto ffmpeg_ok
if exist "%~dp0tools\ffmpeg\bin\ffmpeg.exe" (
  set "FFMPEG_PATH=%~dp0tools\ffmpeg\bin\ffmpeg.exe"
  goto ffmpeg_ok
)
echo Hinweis: ffmpeg nicht gefunden - nur der MJPEG-Link funktioniert.
echo          Fuer HLS/MPEG-TS: "winget install Gyan.FFmpeg" oder ffmpeg nach tools\ffmpeg\bin\ legen.
:ffmpeg_ok

echo.
echo   Admin:     %URL%/admin/      (erster Login: admin / admin123)
echo   Daten:     %DATA_DIR%
echo.
echo   Test ohne Handy: im Admin einen Stream anlegen, "QR / Links" oeffnen und den
echo   Link "Handy-App" hier am PC in Chrome oder Edge oeffnen. Mit Bluetooth am PC
echo   kann die Kamera direkt verbunden werden (Bluetooth geht nur ueber localhost
echo   oder HTTPS - fuer echte Handys den Server mit HTTPS betreiben).
echo.

rem Browser kurz nach dem Serverstart oeffnen
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process '%URL%/admin/'"
node server.js
echo.
echo Server beendet.
pause
