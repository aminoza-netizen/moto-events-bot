require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const cron = require('node-cron');
const store = require('./store');
const { collect } = require('./collect');
const { publish, sendToChannel } = require('./post');

const MAX_ANNOUNCES_PER_RUN = 4;
const MAX_NEWS_PER_RUN = 2;
const ANNOUNCE_WINDOW_DAYS = 35; // анонсируем примерно за месяц

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtDateRu(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  if (!y || !m || !d) return dateStr;
  return `${d} ${months[m - 1]}`;
}

function weekReminder(ev) {
  const link = ev.url ? `\n\n<a href="${esc(ev.url)}">Подробнее</a>` : '';
  return `⏰ <b>Уже через неделю!</b>\n\n🏍 <b>${esc(ev.title)}</b>\n📅 ${fmtDateRu(ev.date)} · 📍 ${esc(ev.city)}\n\n${esc(ev.short_ru)}${link}`;
}

function dayReminder(ev) {
  const link = ev.url ? `\n\n<a href="${esc(ev.url)}">Подробнее</a>` : '';
  return `🔥 <b>Сегодня!</b>\n\n🏍 <b>${esc(ev.title)}</b>\n📍 ${esc(ev.city)}\n\n${esc(ev.short_ru)}\n\nКто едет — увидимся там! 😎${link}`;
}

async function runDaily() {
  console.log(`[${new Date().toISOString()}] Ежедневный запуск...`);
  const db = store.load();
  store.cleanup(db);

  // 1. Сбор новых событий и новостей
  try {
    const upcoming = db.events.filter((e) => (store.daysUntil(e.date) ?? -1) >= 0);
    const result = await collect(upcoming.map((e) => ({ title: e.title, date: e.date, city: e.city })));
    const addedEv = store.addEvents(db, result.events);
    const addedNews = store.addNews(db, result.news);
    console.log(`Сбор: найдено ${result.events.length} событий (новых ${addedEv}), новостей ${result.news.length} (новых ${addedNews})`);
    if (result.usage) console.log(`Токены: in=${result.usage.input_tokens} out=${result.usage.output_tokens}`);
    store.save(db);
  } catch (e) {
    console.error('Ошибка сбора (постим из того, что уже есть):', e.message);
  }

  const now = new Date().toISOString();
  let posted = 0;

  // 2. Анонсы новых событий (за ~месяц до даты)
  const toAnnounce = db.events
    .filter((e) => !e.posted.announce && e.announce_ru)
    .filter((e) => {
      const d = store.daysUntil(e.date);
      return d !== null && d >= 0 && d <= ANNOUNCE_WINDOW_DAYS;
    })
    .sort((a, b) => (store.daysUntil(a.date) ?? 999) - (store.daysUntil(b.date) ?? 999))
    .slice(0, MAX_ANNOUNCES_PER_RUN);

  for (const ev of toAnnounce) {
    try {
      await publish(ev.announce_ru);
      ev.posted.announce = now;
      posted++;
      store.save(db);
      console.log(`Анонс: ${ev.title} (${ev.date})`);
    } catch (e) {
      console.error(`Не удалось запостить анонс "${ev.title}":`, e.message);
    }
  }

  // 3. Напоминания "через неделю" (7..5 дней — на случай пропуска запуска)
  for (const ev of db.events) {
    const d = store.daysUntil(ev.date);
    if (d === null || d > 7 || d < 5) continue;
    if (ev.posted.week || !ev.posted.announce) continue;
    // не дублируем, если анонс был меньше 2 дней назад
    if (Date.now() - new Date(ev.posted.announce).getTime() < 2 * 86400000) continue;
    try {
      await publish(weekReminder(ev));
      ev.posted.week = now;
      posted++;
      store.save(db);
      console.log(`Напоминание (неделя): ${ev.title}`);
    } catch (e) {
      console.error(`Не удалось запостить напоминание "${ev.title}":`, e.message);
    }
  }

  // 4. "Сегодня!"
  for (const ev of db.events) {
    if (store.daysUntil(ev.date) !== 0 || ev.posted.day) continue;
    // не дублируем, если анонс или напоминание вышли сегодня же
    const lastPost = ev.posted.week || ev.posted.announce;
    if (lastPost && Date.now() - new Date(lastPost).getTime() < 20 * 3600000) continue;
    try {
      await publish(dayReminder(ev));
      ev.posted.day = now;
      posted++;
      store.save(db);
      console.log(`Сегодня: ${ev.title}`);
    } catch (e) {
      console.error(`Не удалось запостить "${ev.title}":`, e.message);
    }
  }

  // 5. Новости
  const freshNews = db.news.filter((n) => !n.posted).slice(0, MAX_NEWS_PER_RUN);
  for (const n of freshNews) {
    try {
      await publish(n.post_ru);
      n.posted = now;
      posted++;
      store.save(db);
      console.log(`Новость: ${n.title}`);
    } catch (e) {
      console.error(`Не удалось запостить новость "${n.title}":`, e.message);
    }
  }

  store.save(db);
  console.log(`Готово. Опубликовано постов: ${posted}. Событий в базе: ${db.events.length}, новостей: ${db.news.length}`);
}

function checkEnv() {
  const missing = ['TELEGRAM_BOT_TOKEN', 'CHANNEL_ID', 'ANTHROPIC_API_KEY'].filter((k) => !process.env[k]);
  if (missing.length) {
    console.error('В .env не заданы:', missing.join(', '));
    console.error('Скопируй .env.example в .env и заполни (или запусти make-env.bat).');
    process.exit(1);
  }
}

const mode = process.argv[2];

if (mode === 'test') {
  // Проверка связи: тестовый пост в канал
  checkEnv();
  sendToChannel('🏍 <b>Тест!</b> Бот мото-афиши подключён и готов к работе. 🇪🇸')
    .then((id) => console.log('Тестовый пост отправлен, message_id =', id))
    .catch((e) => { console.error('Ошибка:', e.message); process.exit(1); });
} else if (mode === 'run') {
  // Разовый запуск полного цикла (сбор + публикация)
  checkEnv();
  runDaily().catch((e) => { console.error('Ошибка:', e); process.exit(1); });
} else {
  // Режим демона: ежедневный запуск по расписанию
  checkEnv();
  const hour = Math.min(23, Math.max(0, parseInt(process.env.POST_HOUR || '10', 10) || 10));
  cron.schedule(`0 ${hour} * * *`, () => {
    runDaily().catch((e) => console.error('Ошибка ежедневного запуска:', e));
  }, { timezone: 'Europe/Madrid' });
  console.log(`Бот мото-афиши запущен. Ежедневный пост в ${hour}:00 по времени Испании (Europe/Madrid).`);
  console.log('Разовый запуск: node src/index.js run | Тест канала: node src/index.js test');
}
