@echo off
rem Helm Camera Streams - Test auf dem Windows-PC.
rem Startet den Server auf Port 5036 und oeffnet das Admin-Fenster mit der IP dieses PCs.
title Helm Camera Streams (Port 5036)
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\start-server.ps1"
echo.
echo Fenster schliessen mit einer beliebigen Taste. Fehler stehen auch in start.log.
pause >nul
