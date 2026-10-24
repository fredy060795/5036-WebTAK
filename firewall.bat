@echo off
rem Gibt Port 5036 und Node.js in der Windows-Firewall frei (fragt nach Administrator-Rechten).
title Helm Camera Streams - Firewall
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\firewall.ps1"
echo.
echo Ergebnis steht auch in firewall.log. Taste druecken zum Schliessen.
pause >nul
