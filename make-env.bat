@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === Настройка .env для moto-events-bot ===
echo.
set /p BOT_TOKEN="Токен Telegram-бота (от @BotFather): "
set /p CHANNEL="ID канала (@имяканала или -100...): "
set /p GROUP="ID группы для пересылки (Enter = пропустить): "
set /p ANTHROPIC="Ключ Anthropic API (sk-ant-...): "
set /p HOUR="Час ежедневного поста по Испании (Enter = 10): "
if "%HOUR%"=="" set HOUR=10

(
echo TELEGRAM_BOT_TOKEN=%BOT_TOKEN%
echo CHANNEL_ID=%CHANNEL%
echo GROUP_ID=%GROUP%
echo ANTHROPIC_API_KEY=%ANTHROPIC%
echo CLAUDE_MODEL=claude-sonnet-5
echo POST_HOUR=%HOUR%
) > .env

echo.
echo .env создан!
echo Проверка: npm run test-post  (пришлёт тестовый пост в канал)
pause
