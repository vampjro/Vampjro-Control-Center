@echo off
title VAMPJRO Remote Control Center
cd /d "%~dp0.."
echo.
echo   VAMPJRO Remote Control Center
echo   =============================
echo.
start /min "VAMPJRO" node --max-old-space-size=128 src/server/index.js
echo   Server avviato in background (finestra minimizzata)
echo.
echo   Per fermarlo: chiudi la finestra "VAMPJRO" minimizzata
echo   oppure esegui:  taskkill /f /fi "WINDOWTITLE eq VAMPJRO"
echo.
pause
