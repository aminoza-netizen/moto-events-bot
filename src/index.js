require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const cron = require('node-cron');
const store = require('./store');
const { collectFromSources, collectFromSearch } = require('./collect');
const { publish, sendToChannel } = require('./post');
const { getPageImage } = require('./images');
const { exportWeb } = require('./export-web');
const { startAdminBridge } = require('./admin-bridge');

// Лимиты и расписание (переопределяются в .env)
const MAX_ANNOUNCES = () => parseInt(process.env.MAX_ANNOUNCES || '4', 10);      // анонсов в день
const MAX_NEWS = () => parseInt(process.env.MAX_NEWS || '2', 10);                // новостей в день
const MAX_FORWARDS = () => parseInt(process.env.MAX_FORWARDS || '2', 10);        // пересылок в группу в день
const ANNOUNCE_WINDOW = () => parseInt(process.env.ANNOUNCE_WINDOW || '35', 10); // анонс примерно за месяц
const WORK_START = () => parseInt(process.env.WORK_START || '9', 10);
const WORK_END = () => parseInt(process.env.WORK_END || '21', 10);
const POST_INTERVAL_SEC = () => parseInt(process.env.POST_INTERVAL_SEC || '45', 10);
const COLLECT_HOUR = () => parseInt(process.env.COLLECT_HOUR || '9', 10);        // час сбора
const POST_HOURS = () => (process.env.POST_HOURS || '10,12,14,16,18,20');        // часы публикаций
// Дни веб-поиска (дорогая фаза; 1=пн...7=вс). Источники обходим ежедневно — они дёшевы.
const SEARCH_DAYS = () => (process.env.SEARCH_DAYS || '1,4').split(',').map((d) => parseInt(d.trim(), 10));

// Приоритет для пересылки в группу: наша аудитория
const PRIORITY_REGION = /alicante|valencia|castell|murcia|benidorm|torrevieja|elche|cheste/i;

// Ссылка «Подробнее» ведёт в НАШУ афишу на карточку события (весь трафик у нас;
// внешние ссылки на билеты/регистрацию живут внутри мини-аппа)
const APP_LINK = () => process.env.APP_DIRECT_LINK || 'https://t.me/spainmotonews_bot/afisha';
const appEventLink = (ev) => `${APP_LINK()}?startapp=ev_${ev.id}`;
// Убрать финальную внешнюю ссылку из старых текстов анонсов
function stripTrailingLink(html) {
  return String(html || '').replace(/\n*<a href="[^"]*">[^<]*<\/a>\s*$/i, '').trimEnd();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// Картинка для поста: от модели или og:image страницы источника (кэшируется в объекте)
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
  return `⏰ <b>Уже через неделю!</b>\n\n🏍 <b>${esc(ev.title)}</b>\n📅 ${fmtDateRu(ev.date)}\n\n${esc(ev.short_ru)}\n${locationLine(ev)}\n<a href="${appEventLink(ev)}">➡️ Подробнее в афише</a>`;
}

function dayReminder(ev) {
  return `🔥 <b>Сегодня!</b>\n\n🏍 <b>${esc(ev.title)}</b>\n\n${esc(ev.short_ru)}\n\nКто едет — увидимся там! 😎\n${locationLine(ev)}\n<a href="${appEventLink(ev)}">➡️ Подробнее в афише</a>`;
}

function announceHtml(ev) {
  return stripTrailingLink(ev.announce_ru) + `\n\n<a href="${appEventLink(ev)}">➡️ Подробнее в афише</a>`;
}

// ─── Пересылка в группу: максимум MAX_FORWARDS самых важных в день ───
function shouldForward(db, { isNews, ev }) {
  const meta = store.todayMeta(db);
  if (meta.forwards >= MAX_FORWARDS()) return false;
  if (isNews) return true; // законы/штрафы — всегда важно
  if (ev) {
    if (PRIORITY_REGION.test(`${ev.region || ''} ${ev.city || ''}`)) return true; // наша аудитория
    const d = store.daysUntil(ev.date);
    if (d !== null && d <= 1) return true; // сегодня/завтра
  }
  return false;
}

// ─── Публикация одного элемента ───
async function postEvent(db, ev, kind) {
  const html = kind === 'week' ? weekReminder(ev) : kind === 'day' ? dayReminder(ev) : announceHtml(ev);
  const fwd = shouldForward(db, { ev });
  const msgId = await publish(html, await resolveImage(ev), { forward: fwd });
  ev.channel_msg_id = msgId; // пригодится для редактирования/удаления
  const meta = store.todayMeta(db);
  ev.posted[kind === 'announce' ? 'announce' : kind] = new Date().toISOString();
  if (kind === 'announce') meta.announces++;
  if (fwd) meta.forwards++;
  store.save(db);
  const label = { announce: 'Анонс', week: 'Напоминание (неделя)', day: 'Сегодня' }[kind];
  console.log(`${label}: ${ev.title} (${ev.date})${fwd ? ' → переслано в группу' : ''}`);
}

async function postNews(db, n) {
  const fwd = shouldForward(db, { isNews: true });
  const msgId = await publish(n.post_ru, await resolveImage(n), { forward: fwd });
  n.channel_msg_id = msgId;
  const meta = store.todayMeta(db);
  n.posted = new Date().toISOString();
  meta.news++;
  if (fwd) meta.forwards++;
  store.save(db);
  console.log(`Новость: ${n.title}${fwd ? ' → переслано в группу' : ''}`);
}

// ─── Кандидаты на публикацию (в порядке приоритета) ───
function nextCandidate(db) {
  const meta = store.todayMeta(db);
  const fresh = (ts) => ts && Date.now() - new Date(ts).getTime() < 20 * 3600000;

  // 1. «Сегодня!» — день события
  for (const ev of db.events) {
    if (ev.no_post) continue; // напр. рядовые тренировки на закрытых трассах — не для канала
    if (store.daysUntil(ev.date) !== 0 || ev.posted.day) continue;
    if (fresh(ev.posted.week) || fresh(ev.posted.announce)) continue;
    return { type: 'event', kind: 'day', item: ev };
  }
  // 2. Напоминание за неделю
  for (const ev of db.events) {
    if (ev.no_post) continue;
    const d = store.daysUntil(ev.date);
    if (d === null || d > 7 || d < 5) continue;
    if (ev.posted.week || !ev.posted.announce) continue;
    if (Date.now() - new Date(ev.posted.announce).getTime() < 2 * 86400000) continue;
    return { type: 'event', kind: 'week', item: ev };
  }
  // 3. Новость (лимит в день)
  if (meta.news < MAX_NEWS()) {
    const n = db.news.find((x) => !x.posted && x.post_ru);
    if (n) return { type: 'news', item: n };
  }
  // 4. Анонс ближайшего события в окне (лимит в день)
  if (meta.announces < MAX_ANNOUNCES()) {
    const ev = db.events
      .filter((e) => !e.no_post && !e.posted.announce && e.announce_ru)
      .filter((e) => { const d = store.daysUntil(e.date); return d !== null && d >= 0 && d <= ANNOUNCE_WINDOW(); })
      .sort((a, b) => (store.daysUntil(a.date) ?? 999) - (store.daysUntil(b.date) ?? 999))[0];
    if (ev) return { type: 'event', kind: 'announce', item: ev };
  }
  return null;
}

// ─── Тик публикации: один пост (вызывается по расписанию несколько раз в день) ───
async function postTick() {
  if (!isWorkingHours()) return;
  const db = store.load();
  const cand = nextCandidate(db);
  if (!cand) { console.log(`[тик ${madridHour()}:00] публиковать нечего`); return; }
  try {
    if (cand.type === 'news') await postNews(db, cand.item);
    else await postEvent(db, cand.item, cand.kind);
  } catch (e) {
    console.error('Ошибка публикации:', e.message);
  }
}

// ─── Сбор (без постинга) ───
async function collectAll() {
  console.log(`[${new Date().toISOString()}] Сбор событий и новостей...`);
  const db = store.load();
  store.cleanup(db);
  const known = () =>
    db.events.filter((e) => (store.daysUntil(e.date) ?? -1) >= 0).map((e) => ({ title: e.title, date: e.date, city: e.city }));
  const knownNews = () => db.news.slice(-15).map((n) => n.title);

  try {
    const r1 = await collectFromSources(known(), knownNews());
    console.log(`Источники: событий ${r1.events.length} (новых ${store.addEvents(db, r1.events)}), новостей ${r1.news.length} (новых ${store.addNews(db, r1.news)})`);
    store.save(db);
  } catch (e) {
    console.error('Ошибка фазы источников:', e.message);
  }
  // Веб-поиск — только в заданные дни недели (по умолч. пн и чт): дорого, а новое приносят источники
  const dow = ((new Date(new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(new Date())).getUTCDay() + 6) % 7) + 1;
  if (SEARCH_DAYS().includes(dow)) {
    try {
      const r2 = await collectFromSearch(known(), knownNews());
      console.log(`Веб-поиск: событий ${r2.events.length} (новых ${store.addEvents(db, r2.events)}), новостей ${r2.news.length} (новых ${store.addNews(db, r2.news)})`);
      store.save(db);
    } catch (e) {
      console.error('Ошибка фазы веб-поиска:', e.message);
    }
  } else {
    console.log(`Веб-поиск сегодня пропущен (дни поиска: ${SEARCH_DAYS().join(',')} — пн/чт по умолчанию).`);
  }
  store.save(db);
  exportWeb(db); // обновить календарь мини-аппа
}

// ─── Разовый пакетный режим (run/post): сбор + публикация всего дневного лимита сразу ───
async function runDaily(skipCollect = false) {
  if (skipCollect) console.log('Режим "только постинг": сбор пропущен.');
  else await collectAll();

  if (!isWorkingHours()) {
    console.log(`Сейчас ${madridHour()}:00 по Испании — вне рабочих часов (${WORK_START()}–${WORK_END()}). Посты отложены.`);
    return;
  }
  const db = store.load();
  let posted = 0;
  while (true) {
    const cand = nextCandidate(db);
    if (!cand) break;
    if (posted > 0) await sleep(POST_INTERVAL_SEC() * 1000);
    try {
      if (cand.type === 'news') await postNews(db, cand.item);
      else await postEvent(db, cand.item, cand.kind);
      posted++;
    } catch (e) {
      console.error('Ошибка публикации:', e.message);
      break;
    }
  }
  exportWeb(db);
  console.log(`Готово. Опубликовано: ${posted}. Событий в базе: ${db.events.length}, новостей: ${db.news.length}`);
}

function checkEnv() {
  const missing = ['TELEGRAM_BOT_TOKEN', 'CHANNEL_ID', 'ANTHROPIC_API_KEY'].filter((k) => !process.env[k]);
  if (missing.length) {
    console.error('В .env не заданы:', missing.join(', '));
    process.exit(1);
  }
}

module.exports = { nextCandidate, shouldForward, postTick, collectAll, runDaily };
if (require.main !== module) return; // подключили как модуль (тесты) — режимы не запускаем

const mode = process.argv[2];

if (mode === 'sources') {
  const { fetchAllSources } = require('./fetch-sources');
  fetchAllSources().then(({ ok, failed }) => {
    for (const s of ok) console.log(`OK   ${s.name} — ${s.content.length} симв.`);
    for (const f of failed) console.log(`FAIL ${f.name} — ${f.error}`);
    console.log(`\nИтого: ${ok.length} доступно, ${failed.length} с ошибкой`);
  });
} else if (mode === 'export') {
  exportWeb(store.load());
} else if (mode === 'test') {
  checkEnv();
  sendToChannel('🏍 <b>Тест!</b> Бот мото-афиши подключён и готов к работе. 🇪🇸')
    .then((id) => console.log('Тестовый пост отправлен, message_id =', id))
    .catch((e) => { console.error('Ошибка:', e.message); process.exit(1); });
} else if (mode === 'run') {
  checkEnv();
  runDaily().catch((e) => { console.error('Ошибка:', e); process.exit(1); });
} else if (mode === 'post') {
  checkEnv();
  runDaily(true).catch((e) => { console.error('Ошибка:', e); process.exit(1); });
} else if (mode === 'collect') {
  checkEnv();
  collectAll().catch((e) => { console.error('Ошибка:', e); process.exit(1); });
} else if (mode === 'tick') {
  checkEnv();
  postTick().catch((e) => { console.error('Ошибка:', e); process.exit(1); });
} else {
  // Демон: сбор утром, публикации по одному посту в течение дня, мост «написать админу»
  checkEnv();
  const collectH = Math.min(23, Math.max(0, COLLECT_HOUR()));
  const hours = POST_HOURS().split(',').map((h) => parseInt(h.trim(), 10)).filter((h) => h >= 0 && h <= 23);
  cron.schedule(`0 ${collectH} * * *`, () => {
    collectAll().catch((e) => console.error('Ошибка сбора:', e));
  }, { timezone: 'Europe/Madrid' });
  cron.schedule(`0 ${hours.join(',')} * * *`, () => {
    postTick().catch((e) => console.error('Ошибка тика:', e));
  }, { timezone: 'Europe/Madrid' });
  console.log(`Бот мото-афиши запущен. Сбор в ${collectH}:00, посты в ${hours.map((h) => h + ':00').join(', ')} по Испании.`);
  console.log('Команды: run (сбор+посты) | post (только посты) | collect | tick | test | sources | export');
  startAdminBridge();
}
