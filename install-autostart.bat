@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === Установка moto-events-bot как фоновой службы (PM2) ===

if not exist .env (
  echo Сначала запусти make-env.bat и заполни настройки!
  pause
  exit /b 1
)

call npm install
where pm2 >nul 2>nul || call npm install -g pm2

call pm2 delete moto-events-bot >nul 2>nul
call pm2 start src\index.js --name moto-events-bot
call pm2 save

echo.
echo Готово! Бот работает в фоне и будет постить каждый день.
echo Логи:        pm2 logs moto-events-bot
echo Перезапуск:  pm2 restart moto-events-bot
echo.
echo Если PM2 ещё не в автозагрузке Windows — установи pm2-installer
echo (как для CRM) или добавь "pm2 resurrect" в планировщик задач.
pause
