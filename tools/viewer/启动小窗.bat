@echo off
chcp 65001 >nul
cd /d "%~dp0"
node server.mjs --file "%~dp0demo-state.json" --open
if errorlevel 1 pause