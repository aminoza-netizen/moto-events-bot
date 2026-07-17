@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === Обновление moto-events-bot ===
git pull
call npm install
call pm2 restart moto-events-bot
echo Готово!
pause
