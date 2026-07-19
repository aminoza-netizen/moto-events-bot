@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === Настройка .env для moto-events-bot ===
echo.
set /p BOT_TOKEN="Токен Telegram-бота (от @BotFather): "
set /p CHANNEL="ID канала (@имяканала или -100...): "
set /p GROUP="ID группы для пересылки (Enter = пропустить): "
set /p ANTHROPIC="Ключ Anthropic API (sk-ant-...): "
set /p ADMIN="Твой chat_id для сообщений админу (Enter = пропустить): "

(
echo TELEGRAM_BOT_TOKEN=%BOT_TOKEN%
echo CHANNEL_ID=%CHANNEL%
echo GROUP_ID=%GROUP%
echo ANTHROPIC_API_KEY=%ANTHROPIC%
echo CLAUDE_MODEL=claude-sonnet-5
echo COLLECT_HOUR=9
echo POST_HOURS=10,12,14,16,18,20
echo WORK_START=9
echo WORK_END=21
echo POST_INTERVAL_SEC=45
echo MAX_FORWARDS=2
echo ADMIN_CHAT_ID=%ADMIN%
echo WEBAPP_URL=https://aminoza-netizen.github.io/moto-events-bot/
echo APP_DIRECT_LINK=https://t.me/spainmotonews_bot/afisha
) > .env

echo.
echo .env создан!
echo Проверка: npm run test-post  (пришлёт тестовый пост в канал)
pause
