@echo off
chcp 65001 >nul
title Azhar Natiga Checker
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed.
  echo Please install it from https://nodejs.org then run this file again.
  pause >nul
  exit /b 1
)

if not exist "node_modules" (
  echo First run: installing dependencies, please wait...
  call npm install
  echo.
)

node src\index.js %*

echo.
echo --- Done. Press any key to close this window. ---
pause >nul
