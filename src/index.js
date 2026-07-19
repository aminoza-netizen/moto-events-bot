require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const cron = require('node-cron');
const store = require('./store');
const { collectFromSources, collectFromSearch } = require('./collect');
const { publish, sendToChannel } = require('./post');
const { getPageImage } = require('./images');
const { exportWeb } = require('./export-web');
const { startAdminBridge } = require('./admin-bridge');

const MAX_ANNOUNCES_PER_RUN = () => parseInt(process.env.MAX_ANNOUNCES || '4', 10);
const MAX_NEWS_PER_RUN = () => parseInt(process.env.MAX_NEWS || '2', 10);
const ANNOUNCE_WINDOW_DAYS = () => parseInt(process.env.ANNOUNCE_WINDOW || '35', 10); // анонс примерно за месяц
const WORK_START = () => parseInt(process.env.WORK_START || '9', 10);
const WORK_END = () => parseInt(process.env.WORK_END || '21', 10);
const POST_INTERVAL_SEC = () => parseInt(process.env.POST_INTERVAL_SEC || '45', 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Текущий час в Испании
function madridHour() {
  return parseInt(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', hour: '2-digit', hourCycle: 'h23' }).format(new Date()),
    10
  );
}

function isWorkingHours() {
  const h = madridHour();
  return h >= WORK_START() && h < WORK_END();
}

// Картинка для поста: сначала та, что нашла модель, иначе og:image страницы источника.
// Найденное кэшируем в объекте, чтобы напоминания использовали ту же картинку.
async function resolveImage(item) {
  if (item.image_url) return item.image_url;
  const img = await getPageImage(item.url);
  if (img) item.image_url = img;
  return img;
}

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

function locationLine(ev) {
  const place = ev.venue ? `${ev.venue}${ev.city && !ev.venue.includes(ev.city) ? ', ' + ev.city : ''}` : ev.city;
  return place ? `\n📍 <b>Локация:</b> ${esc(place)}` : '';
}

function weekReminder(ev) {
  const link = ev.url ? `\n<a href="${esc(ev.url)}">Подробнее</a>` : '';
  return `⏰ <b>Уже через неделю!</b>\n\n🏍 <b>${esc(ev.title)}</b>\n📅 ${fmtDateRu(ev.date)}\n\n${esc(ev.short_ru)}\n${locationLine(ev)}${link}`;
}

function dayReminder(ev) {
  const link = ev.url ? `\n<a href="${esc(ev.url)}">Подробнее</a>` : '';
  return `🔥 <b>Сегодня!</b>\n\n🏍 <b>${esc(ev.title)}</b>\n\n${esc(ev.short_ru)}\n\nКто едет — увидимся там! 😎\n${locationLine(ev)}${link}`;
}

async function runDaily(skipCollect = false) {
  console.log(`[${new Date().toISOString()}] Ежедневный запуск...`);
  const db = store.load();
  store.cleanup(db);

  if (skipCollect) {
    console.log('Режим "только постинг": сбор пропущен, публикуем из базы.');
  } else {

  // 1. Сбор новых событий и новостей — две независимые фазы
  const upcomingKnown = () =>
    db.events
      .filter((e) => (store.daysUntil(e.date) ?? -1) >= 0)
      .map((e) => ({ title: e.title, date: e.date, city: e.city }));

  // Фаза 1: топ-30 постоянных источников (sources.json)
  try {
    const r1 = await collectFromSources(upcomingKnown());
    const addedEv = store.addEvents(db, r1.events);
    const addedNews = store.addNews(db, r1.news);
    console.log(`Источники: событий ${r1.events.length} (новых ${addedEv}), новостей ${r1.news.length} (новых ${addedNews})`);
    if (r1.usage) console.log(`Токены (источники): in=${r1.usage.input_tokens} out=${r1.usage.output_tokens}`);
    store.save(db);
  } catch (e) {
    console.error('Ошибка фазы источников:', e.message);
  }

  // Фаза 2: дополнительный веб-поиск (уже знает всё найденное фазой 1)
  try {
    const r2 = await collectFromSearch(upcomingKnown());
    const addedEv = store.addEvents(db, r2.events);
    const addedNews = store.addNews(db, r2.news);
    console.log(`Веб-поиск: событий ${r2.events.length} (новых ${addedEv}), новостей ${r2.news.length} (новых ${addedNews})`);
    if (r2.usage) console.log(`Токены (поиск): in=${r2.usage.input_tokens} out=${r2.usage.output_tokens}`);
    store.save(db);
  } catch (e) {
    console.error('Ошибка фазы веб-поиска (постим из того, что уже есть):', e.message);
  }
  } // конец сбора (skipCollect)

  // Постим только в рабочее время по Испании — канал испанский
  if (!isWorkingHours()) {
    store.save(db);
    console.log(`Сейчас ${madridHour()}:00 по Испании — вне рабочих часов (${WORK_START()}:00–${WORK_END()}:00). Сбор выполнен, посты отложены до следующего планового запуска.`);
    return;
  }

  const now = new Date().toISOString();
  let posted = 0;
  // Пауза между постами, чтобы не заваливать ленту
  const gap = async () => { if (posted > 0) await sleep(POST_INTERVAL_SEC() * 1000); };

  // 2. Анонсы новых событий (за ~месяц до даты)
  const toAnnounce = db.events
    .filter((e) => !e.posted.announce && e.announce_ru)
    .filter((e) => {
      const d = store.daysUntil(e.date);
      return d !== null && d >= 0 && d <= ANNOUNCE_WINDOW_DAYS();
    })
    .sort((a, b) => (store.daysUntil(a.date) ?? 999) - (store.daysUntil(b.date) ?? 999))
    .slice(0, MAX_ANNOUNCES_PER_RUN());

  for (const ev of toAnnounce) {
    try {
      await gap();
      await publish(ev.announce_ru, await resolveImage(ev));
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
      await gap();
      await publish(weekReminder(ev), await resolveImage(ev));
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
      await gap();
      await publish(dayReminder(ev), await resolveImage(ev));
      ev.posted.day = now;
      posted++;
      store.save(db);
      console.log(`Сегодня: ${ev.title}`);
    } catch (e) {
      console.error(`Не удалось запостить "${ev.title}":`, e.message);
    }
  }

  // 5. Новости
  const freshNews = db.news.filter((n) => !n.posted).slice(0, MAX_NEWS_PER_RUN());
  for (const n of freshNews) {
    try {
      await gap();
      await publish(n.post_ru, await resolveImage(n));
      n.posted = now;
      posted++;
      store.save(db);
      console.log(`Новость: ${n.title}`);
    } catch (e) {
      console.error(`Не удалось запостить новость "${n.title}":`, e.message);
    }
  }

  store.save(db);
  exportWeb(db); // обновить данные мини-аппа (календарь на GitHub Pages)
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

if (mode === 'sources') {
  // Проверка источников: что качается, что нет (без Claude и Telegram)
  const { fetchAllSources } = require('./fetch-sources');
  fetchAllSources().then(({ ok, failed }) => {
    for (const s of ok) console.log(`OK   ${s.name} — ${s.content.length} симв.`);
    for (const f of failed) console.log(`FAIL ${f.name} — ${f.error}`);
    console.log(`\nИтого: ${ok.length} доступно, ${failed.length} с ошибкой`);
  });
} else if (mode === 'test') {
  // Проверка связи: тестовый пост в канал
  checkEnv();
  sendToChannel('🏍 <b>Тест!</b> Бот мото-афиши подключён и готов к работе. 🇪🇸')
    .then((id) => console.log('Тестовый пост отправлен, message_id =', id))
    .catch((e) => { console.error('Ошибка:', e.message); process.exit(1); });
} else if (mode === 'run') {
  // Разовый запуск полного цикла (сбор + публикация)
  checkEnv();
  runDaily().catch((e) => { console.error('Ошибка:', e); process.exit(1); });
} else if (mode === 'export') {
  // Только пересобрать данные мини-аппа из базы
  const db = store.load();
  exportWeb(db);
} else if (mode === 'post') {
  // Только публикация того, что уже в базе (без сбора)
  checkEnv();
  runDaily(true).catch((e) => { console.error('Ошибка:', e); process.exit(1); });
} else {
  // Режим демона: ежедневный запуск по расписанию
  checkEnv();
  const hour = Math.min(23, Math.max(0, parseInt(process.env.POST_HOUR || '10', 10) || 10));
  if (hour < WORK_START() || hour >= WORK_END()) {
    console.warn(`Внимание: POST_HOUR=${hour} вне рабочих часов ${WORK_START()}–${WORK_END()} — посты будут откладываться. Поменяй POST_HOUR или WORK_START/WORK_END в .env.`);
  }
  cron.schedule(`0 ${hour} * * *`, () => {
    runDaily().catch((e) => console.error('Ошибка ежедневного запуска:', e));
  }, { timezone: 'Europe/Madrid' });
  console.log(`Бот мото-афиши запущен. Ежедневный пост в ${hour}:00 по времени Испании (Europe/Madrid).`);
  console.log('Разовый запуск: node src/index.js run | Тест канала: node src/index.js test');
  startAdminBridge(); // «написать админу»: пересылка личных сообщений бота
}
