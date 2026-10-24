@echo off
rem Opens port 5036 and Node.js in the Windows firewall (asks for administrator rights).
title Helm Camera Streams - Firewall
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\firewall.ps1"
echo.
echo The result is also in firewall.log. Press any key to close.
pause >nul
