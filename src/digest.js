// Дайджесты по месяцам: один пост на месяц со списком всех событий из базы.
// Запуск: node src/digest.js  (уважает SILENT_POSTS; постит в канал + пересылка в группу)
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const store = require('./store');
const { publish } = require('./post');

const MONTH_NAMES = ['ЯНВАРЬ', 'ФЕВРАЛЬ', 'МАРТ', 'АПРЕЛЬ', 'МАЙ', 'ИЮНЬ', 'ИЮЛЬ', 'АВГУСТ', 'СЕНТЯБРЬ', 'ОКТЯБРЬ', 'НОЯБРЬ', 'ДЕКАБРЬ'];
const MAX_LEN = 3800; // лимит текста 4096, оставляем запас

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const APP_LINK = () => process.env.APP_DIRECT_LINK || 'https://t.me/spainmotonews_bot/afisha';

function lineFor(ev) {
  const [, m, d] = ev.date.split('-').map(Number);
  let dd = `${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}`;
  if (ev.end_date && ev.end_date !== ev.date) {
    const [, m2, d2] = ev.end_date.split('-').map(Number);
    dd += `–${String(d2).padStart(2, '0')}.${String(m2).padStart(2, '0')}`;
  }
  // ссылка ведёт в нашу афишу на карточку события (не на внешний сайт)
  const name = ev.id ? `<a href="${APP_LINK()}?startapp=ev_${ev.id}">${esc(ev.title)}</a>` : `<b>${esc(ev.title)}</b>`;
  const place = [ev.city, ev.region && ev.region !== ev.city ? ev.region : ''].filter(Boolean).join(', ');
  return `🔹 ${dd} — ${name}${place ? ' — ' + esc(place) : ''}`;
}

function buildDigests(db) {
  const upcoming = db.events
    .filter((e) => (store.daysUntil(e.date) ?? -1) >= 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  const byMonth = new Map();
  for (const ev of upcoming) {
    const key = ev.date.slice(0, 7); // YYYY-MM
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(ev);
  }

  const posts = [];
  for (const [key, evs] of byMonth) {
    const [y, m] = key.split('-').map(Number);
    const header = `📅 <b>МОТО-СОБЫТИЯ ИСПАНИИ — ${MONTH_NAMES[m - 1]} ${y}</b>\n\n`;
    const footer = `\n\nПолный календарь с фильтрами по городам — кнопка ниже 👇`;
    let body = '';
    let part = 1;
    const flush = (isLast) => {
      if (!body) return;
      const h = part > 1 ? header.replace('</b>', ` (часть ${part})</b>`) : header;
      posts.push(h + body.trimEnd() + (isLast ? footer : ''));
      body = '';
      part++;
    };
    for (const ev of evs) {
      const line = lineFor(ev) + '\n';
      if (header.length + body.length + line.length + footer.length > MAX_LEN) flush(false);
      body += line;
    }
    flush(true);
  }
  return posts;
}

(async () => {
  const db = store.load();
  const posts = buildDigests(db);
  console.log(`Дайджестов к публикации: ${posts.length}`);
  if (process.argv[2] === 'preview') {
    for (const p of posts) console.log('\n──────────\n' + p);
    return;
  }
  let n = 0;
  for (const p of posts) {
    if (n > 0) await sleep(15000);
    try {
      await publish(p, null, { noPreview: true });
      n++;
      console.log(`Опубликован дайджест ${n}/${posts.length} (${p.slice(4, 50).replace(/<[^>]+>/g, '')}...)`);
    } catch (e) {
      console.error('Ошибка дайджеста:', e.message);
    }
  }
  console.log('Готово.');
})();
