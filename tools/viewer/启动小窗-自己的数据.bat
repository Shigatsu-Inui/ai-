@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 这个脚本读你自己导出的 state.json（放在同一目录）。
echo 没有的话先看 README.md 的「从你的程序里导出」。
echo.
node server.mjs --file "%~dp0state.json" --open
if errorlevel 1 pause