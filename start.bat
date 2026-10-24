@echo off
rem Helm Camera Streams - test on a Windows PC.
rem Starts the server on port 5036 and opens the admin window with this PC's IP.
title Helm Camera Streams (Port 5036)
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\start-server.ps1"
echo.
echo Press any key to close the window. Errors are also in start.log.
pause >nul
