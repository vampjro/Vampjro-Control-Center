@echo off
title VAMPJRO - Rimuovi Avvio Automatico
echo.
echo  VAMPJRO Remote Control Center
echo  ==============================
echo  Rimozione avvio automatico
echo.

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo  [!] Richiesti privilegi di amministratore.
    echo  Clicca destro su questo file e seleziona "Esegui come amministratore".
    echo.
    pause
    exit /b 1
)

schtasks /delete /tn "VAMPJRO Remote Control Center" /f >nul 2>&1

if %errorlevel% equ 0 (
    echo  [OK] Avvio automatico rimosso.
) else (
    echo  [!] Task non trovato o gia' rimosso.
)

echo.
pause
