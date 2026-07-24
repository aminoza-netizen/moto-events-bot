// JSON-хранилище событий и новостей: data/events.json
// Атомарная запись (tmp + rename), авто-создание файла.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'events.json');

function load() {
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const db = JSON.parse(raw);
    if (!Array.isArray(db.events)) db.events = [];
    if (!Array.isArray(db.news)) db.news = [];
    for (const e of db.events) if (!e.id) e.id = evId(e); // миграция старых записей
    return db;
  } catch (e) {
    return { events: [], news: [] };
  }
}

function save(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
}

// Нормализация названия для дедупликации: нижний регистр, без диакритики и пунктуации
function normTitle(title) {
  return String(title || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9а-яё]+/gi, ' ')
    .trim();
}

function eventKey(ev) {
  return `${normTitle(ev.title)}|${ev.date}`;
}

// Рядовые контролируемые тренировки федерации на закрытых трассах — держим в базе
// (для календаря), но не постим в канал/группу: не интересны широкой аудитории.
// Не путать с tandas/track days (открытые заезды для всех) — те постим как обычно.
const TRAINING_RE = /entrenamientos?\s+tutelados?/i;
function isTraining(ev) {
  return TRAINING_RE.test(ev.title || '');
}

// Стабильный короткий id события — для deep-link в мини-апп
function evId(ev) {
  return crypto.createHash('md5').update(eventKey(ev)).digest('hex').slice(0, 10);
}

// Дата "сегодня" в часовом поясе Испании, формат YYYY-MM-DD
function todayMadrid() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(new Date());
}

// Сколько дней до даты (YYYY-MM-DD) относительно сегодня по Мадриду
function daysUntil(dateStr) {
  const [y1, m1, d1] = todayMadrid().split('-').map(Number);
  const [y2, m2, d2] = String(dateStr).split('-').map(Number);
  if (!y2 || !m2 || !d2) return null;
  const a = Date.UTC(y1, m1 - 1, d1);
  const b = Date.UTC(y2, m2 - 1, d2);
  return Math.round((b - a) / 86400000);
}

// Добавить новые события с дедупликацией. Возвращает число добавленных.
function addEvents(db, incoming) {
  const known = new Set(db.events.map(eventKey));
  const knownTitles = db.events.map((e) => ({ t: normTitle(e.title), d: e.date }));
  let added = 0;
  for (const ev of incoming) {
    if (!ev || !ev.title || !ev.date || !/^\d{4}-\d{2}-\d{2}$/.test(ev.date)) continue;
    const key = eventKey(ev);
    if (known.has(key)) continue;
    // Нечёткий дубль: то же название, дата в пределах ±3 дней
    const nt = normTitle(ev.title);
    const fuzzy = knownTitles.some((k) => {
      if (k.t !== nt) return false;
      const diff = Math.abs((daysUntil(k.d) ?? 0) - (daysUntil(ev.date) ?? 0));
      return diff <= 3;
    });
    if (fuzzy) continue;
    db.events.push({
      id: evId(ev),
      title: ev.title,
      date: ev.date,
      end_date: ev.end_date || null,
      city: ev.city || '',
      region: ev.region || '',
      venue: ev.venue || '',
      url: ev.url || '',
      image_url: ev.image_url || null,
      short_ru: ev.short_ru || '',
      announce_ru: ev.announce_ru || '',
      created_at: new Date().toISOString(),
      posted: { announce: null, week: null, day: null },
      no_post: isTraining(ev) || undefined,
    });
    known.add(key);
    knownTitles.push({ t: nt, d: ev.date });
    added++;
  }
  return added;
}

function addNews(db, incoming) {
  const known = new Set(db.news.map((n) => normTitle(n.title)));
  let added = 0;
  for (const n of incoming) {
    if (!n || !n.title || !n.post_ru) continue;
    if (known.has(normTitle(n.title))) continue;
    db.news.push({
      title: n.title,
      url: n.url || '',
      image_url: n.image_url || null,
      post_ru: n.post_ru,
      created_at: new Date().toISOString(),
      posted: null,
    });
    known.add(normTitle(n.title));
    added++;
  }
  return added;
}

// Убрать события старше 7 дней после окончания и новости старше 60 дней
function cleanup(db) {
  db.events = db.events.filter((ev) => {
    const d = daysUntil(ev.end_date || ev.date);
    return d === null || d >= -7;
  });
  const cutoff = Date.now() - 60 * 86400000;
  db.news = db.news.filter((n) => new Date(n.created_at).getTime() > cutoff);
}

// ─── База пользователей бота (для рассылок): data/users.json ───
const USERS_FILE = path.join(DATA_DIR, 'users.json');

function loadUsers() {
  try {
    const db = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    if (!Array.isArray(db.users)) db.users = [];
    return db;
  } catch (e) {
    return { users: [] };
  }
}

function saveUsers(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = USERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, USERS_FILE);
}

// Добавить/обновить пользователя. Возвращает true, если новый.
function addUser(u) {
  if (!u || !u.id) return false;
  const db = loadUsers();
  const ex = db.users.find((x) => x.id === u.id);
  if (ex) {
    ex.username = u.username || ex.username;
    ex.blocked = false;
    saveUsers(db);
    return false;
  }
  db.users.push({
    id: u.id,
    first_name: u.first_name || '',
    username: u.username || '',
    first_seen: new Date().toISOString(),
    blocked: false,
  });
  saveUsers(db);
  return true;
}

function markBlocked(id) {
  const db = loadUsers();
  const u = db.users.find((x) => x.id === id);
  if (u) { u.blocked = true; saveUsers(db); }
}

// Счётчики за сегодня (анонсы/новости/пересылки в группу) — сбрасываются с новым днём
function todayMeta(db) {
  const today = todayMadrid();
  if (!db.meta || db.meta.date !== today) {
    db.meta = { date: today, announces: 0, news: 0, forwards: 0 };
  }
  return db.meta;
}

module.exports = { load, save, addEvents, addNews, cleanup, daysUntil, todayMadrid, todayMeta, loadUsers, addUser, markBlocked };
