@echo off
title Claude Multi-Agent Orchestrator

echo.
echo  Claude Multi-Agent Orchestrator
echo  ================================
echo.

cd /d "%~dp0"

:: Check Node.js
node --version >nul 2>&1
if errorlevel 1 (
  echo  [FEHLER] Node.js nicht gefunden.
  echo  Installiere Node.js von: https://nodejs.org
  pause
  exit /b 1
)

:: Check Claude Code CLI
claude --version >nul 2>&1
if errorlevel 1 (
  echo  [FEHLER] Claude Code CLI nicht gefunden.
  echo  Installiere mit: npm install -g @anthropic-ai/claude-code
  echo  Dann einloggen mit: claude login
  pause
  exit /b 1
)

:: Install dependencies if needed
if not exist node_modules (
  echo  Installiere Abhaengigkeiten...
  npm install
  echo.
)

:: Create projects folder
if not exist projects mkdir projects

:: Start server
echo  Server startet...
echo  Oeffne Browser: http://localhost:3131
echo.
echo  [Strg+C] zum Beenden
echo.

start "" "http://localhost:3131"
node server.js

pause
