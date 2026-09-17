@echo off
title VAMPJRO - Installa Avvio Automatico
echo.
echo  VAMPJRO Remote Control Center
echo  ==============================
echo  Installazione avvio automatico
echo.

:: Check admin
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo  [!] Richiesti privilegi di amministratore.
    echo  Clicca destro su questo file e seleziona "Esegui come amministratore".
    echo.
    pause
    exit /b 1
)

set "INSTALL_DIR=%~dp0.."
set "NODE_PATH=node"

:: Verify node exists
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  [!] Node.js non trovato. Installare Node.js prima di continuare.
    pause
    exit /b 1
)

:: Create scheduled task
echo  Creazione task pianificato...
schtasks /create /tn "VAMPJRO Remote Control Center" /tr "cmd /c cd /d \"%INSTALL_DIR%\" && node --max-old-space-size=128 src/server/index.js" /sc onlogon /rl highest /f >nul 2>&1

if %errorlevel% equ 0 (
    echo.
    echo  [OK] Avvio automatico installato!
    echo  VAMPJRO si avviera' automaticamente al login.
    echo.
    echo  Per rimuoverlo: eseguire remove-autostart.bat
) else (
    echo  [!] Errore nella creazione del task pianificato.
)

echo.
pause
