@echo off
chcp 65001 >nul
title PEPAGI — Instalace

echo.
echo  ╔══════════════════════════════════════╗
echo  ║       PEPAGI — Instalace          ║
echo  ╚══════════════════════════════════════╝
echo.

:: ─── Check Node.js ───────────────────────────────────────────

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  CHYBA: Node.js neni nainstalovan!
    echo.
    echo  Stahni z https://nodejs.org ^(verze 22 nebo novejsi^)
    echo.
    pause
    exit /b 1
)

for /f "tokens=1 delims=v" %%v in ('node -v 2^>^&1') do set NODE_VER=%%v
echo  OK: Node.js nalezen

where npm >nul 2>&1
if %errorlevel% neq 0 (
    echo  CHYBA: npm neni dostupny!
    pause
    exit /b 1
)
echo  OK: npm nalezen

:: ─── Install dependencies ─────────────────────────────────────

echo.
echo  Instaluji zavislosti...
call npm install
if %errorlevel% neq 0 (
    echo  CHYBA: npm install selhal!
    pause
    exit /b 1
)
echo  OK: Zavislosti nainstalovany

:: ─── Register pepagi command globally ──────────────────────────

echo.
echo  Registruji prikaz 'pepagi' globalne...
call npm link
if %errorlevel% equ 0 (
    echo  OK: Prikaz 'pepagi' je nyni dostupny globalne
) else (
    echo  UPOZORNENI: npm link selhal. Spust rucne: npm link
)

:: ─── Create data directories ──────────────────────────────────

if not exist "%USERPROFILE%\.pepagi\memory" mkdir "%USERPROFILE%\.pepagi\memory"
if not exist "%USERPROFILE%\.pepagi\logs" mkdir "%USERPROFILE%\.pepagi\logs"
if not exist "%USERPROFILE%\.pepagi\causal" mkdir "%USERPROFILE%\.pepagi\causal"
if not exist "%USERPROFILE%\.pepagi\skills" mkdir "%USERPROFILE%\.pepagi\skills"
echo  OK: Datove slozky vytvoreny: %USERPROFILE%\.pepagi

:: ─── Create .env ──────────────────────────────────────────────

if not exist ".env" (
    copy ".env.example" ".env" >nul
    echo  OK: .env soubor vytvoren
)

:: ─── Check Claude CLI ─────────────────────────────────────────

where claude >nul 2>&1
if %errorlevel% equ 0 (
    echo.
    echo  OK: Claude Code CLI nalezen - OAuth autentizace dostupna
    echo      ^(Nepotrebujes API klic pro Claude^)
) else (
    echo.
    echo  INFO: Claude Code CLI neni nainstalovany
    echo        Budes potrebovat Anthropic API klic.
    echo        Instalace: https://claude.ai/download
)

:: ─── Run setup wizard ─────────────────────────────────────────

echo.
echo  ════════════════════════════════════════
echo   Spoustim pruvodce nastavenim...
echo  ════════════════════════════════════════
echo.

call npm run setup

echo.
echo  ╔══════════════════════════════════════╗
echo  ║     PEPAGI je pripraven!          ║
echo  ╚══════════════════════════════════════╝
echo.
echo   Prikazy:
echo   npm start                         -- otevrit chat v terminalu
echo   npm run daemon                    -- spustit daemon v popredi
echo.
echo   Sprava daemona na pozadi:
echo   npx tsx src\cli.ts daemon start   -- spustit na pozadi
echo   npx tsx src\cli.ts daemon stop    -- zastavit
echo   npx tsx src\cli.ts daemon status  -- stav
echo   npx tsx src\cli.ts daemon install -- nainstalovat jako Windows sluzbu
echo.
pause
