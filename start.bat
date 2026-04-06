@echo off
title Claude Multi-Agent Orchestrator
cd /d "%~dp0"

echo.
echo   Claude Multi-Agent Orchestrator v2
echo   ====================================
echo.

node --version >nul 2>&1
if errorlevel 1 (
    echo   [FEHLER] Node.js nicht gefunden!
    echo   Installiere Node.js: https://nodejs.org
    pause
    exit /b 1
)

claude --version >nul 2>&1
if errorlevel 1 (
    echo   [WARNUNG] Claude CLI nicht gefunden.
    echo   Installiere: npm install -g @anthropic-ai/claude-code
    echo   Dann: claude login
    echo.
)

if not exist node_modules (
    echo   Installiere Dependencies...
    call npm install
    echo.
)

if not exist projects mkdir projects

echo   Server startet auf http://localhost:3131
echo   Druecke Strg+C zum Beenden
echo.

start "" "http://localhost:3131"
node server.js

pause
