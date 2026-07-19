// Целевой сбор: Аликанте и округа (провинции Alicante/Valencia/Castellón + юг до Мурсии).
// Страницы провинций + веб-поиск. Запуск: node src/harvest-alicante.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Anthropic = require('@anthropic-ai/sdk');
const store = require('./store');
const { exportWeb } = require('./export-web');

const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGES = [
  ['Provincia de Alicante', 'https://www.concentracionesdemotos.com/alicante/'],
  ['Provincia de Valencia', 'https://www.concentracionesdemotos.com/valencia/'],
  ['Provincia de Castellón', 'https://www.concentracionesdemotos.com/castellon/'],
  ['Región de Murcia', 'https://www.concentracionesdemotos.com/murcia/'],
];

function stripHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(br|p|div|li|tr|h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

async function fetchPage(url) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 20000);
  try {
    const r = await fetch(url, {
      signal: c.signal, redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36', 'Accept-Language': 'es-ES' },
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return stripHtml(await r.text()).slice(0, 30000);
  } finally { clearTimeout(t); }
}

function extractJson(text) {
  const fence = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : text;
  const s = candidate.indexOf('{'), e = candidate.lastIndexOf('}');
  if (s === -1 || e === -1) throw new Error('JSON not found');
  return JSON.parse(candidate.slice(s, e + 1));
}

const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(new Date());

const SCHEMA = `Верни СТРОГО один JSON-блок в fence \`\`\`json ... \`\`\`:
{
  "events": [
    {
      "title": "оригинальное название",
      "date": "YYYY-MM-DD",
      "end_date": "YYYY-MM-DD или null",
      "city": "город",
      "region": "провинция",
      "venue": "площадка/адрес если указаны, иначе null",
      "url": "ссылка записи или страницы-источника",
      "short_ru": "одна строка по-русски: что это",
      "announce_ru": "пост для Telegram на русском, 300–600 символов: эмодзи + <b>заголовок</b>, пустая строка, 1–2 коротких абзаца (дата по-русски, город, что будет), последняя строка «📍 <b>Локация:</b> ...». БЕЗ ссылок и URL. Только теги <b> <i>."
    }
  ]
}`;

async function run() {
  const client = new Anthropic.Anthropic();
  const db = store.load();
  const known = () => db.events
    .filter((e) => (store.daysUntil(e.date) ?? -1) >= 0)
    .map((e) => `- ${e.title} (${e.date}, ${e.city})`).join('\n') || '(пусто)';

  // Фаза 1: провинциальные календари
  let digest = '';
  for (const [name, url] of PAGES) {
    try {
      const content = await fetchPage(url);
      digest += `=== ${name} — ${url} ===\n${content}\n\n`;
      console.log('OK  ', name, content.length, 'симв.');
    } catch (e) { console.log('FAIL', name, e.message); }
    await sleep(1400);
  }

  const p1 = `Сегодня ${today()}. Собираем календарь мото-событий для русскоязычных мотоциклистов, живущих в ПРОВИНЦИИ АЛИКАНТЕ и рядом (Коста-Бланка, юг Валенсии, север Мурсии).

Из дайджеста провинциальных календарей ниже извлеки ВСЕ мото-события ближайших 90 дней: concentraciones, motoalmuerzos, matinales, quedadas, ярмарки, track days. Даже маленькие локальные — для местной аудитории они самые ценные. Только события с конкретной датой, явно присутствующие в дайджесте.

УЖЕ В БАЗЕ (не включай повторно):
${known()}

${SCHEMA}

ДАЙДЖЕСТ:
${digest}`;

  try {
    const r = await client.messages.stream({ model: MODEL, max_tokens: 50000, thinking: { type: 'adaptive' }, messages: [{ role: 'user', content: p1 }] }).finalMessage();
    const data = extractJson(r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'));
    const added = store.addEvents(db, data.events || []);
    console.log(`Провинции: извлечено ${(data.events || []).length}, новых ${added}. Токены in=${r.usage.input_tokens} out=${r.usage.output_tokens}`);
    store.save(db);
  } catch (e) { console.error('Ошибка фазы провинций:', e.message); }

  // Фаза 2: веб-поиск по Аликанте
  const p2 = `Сегодня ${today()}. Найди через веб-поиск мото-события в ПРОВИНЦИИ АЛИКАНТЕ и округе на ближайшие 90 дней: Alicante, Benidorm, Torrevieja, Elche, Orihuela, Santa Pola, Calpe, Dénia, Altea, La Vila Joiosa, Alcoy, Elda, Petrer, Guardamar, Pilar de la Horadada + север Мурсии (San Javier, San Pedro del Pinatar).

Ищи по-испански: "concentración motera Alicante 2026", "quedada motera Benidorm", "motoalmuerzo Torrevieja", "eventos moteros Costa Blanca agosto septiembre", афиши аюнтамьенто, мото-клубы, Facebook-анонсы. Нужно МАКСИМУМ событий с конкретными датами — маленькие локальные тоже годятся.

УЖЕ В БАЗЕ (не включай повторно):
${known()}

${SCHEMA}`;

  try {
    const tools = [{ type: 'web_search_20260209', name: 'web_search', max_uses: 10, user_location: { type: 'approximate', country: 'ES', city: 'Alicante', timezone: 'Europe/Madrid' } }];
    let messages = [{ role: 'user', content: p2 }];
    let r;
    for (let i = 0; i < 6; i++) {
      r = await client.messages.stream({ model: MODEL, max_tokens: 40000, thinking: { type: 'adaptive' }, tools, messages }).finalMessage();
      if (r.stop_reason !== 'pause_turn') break;
      messages = [...messages, { role: 'assistant', content: r.content }];
    }
    const data = extractJson(r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'));
    const added = store.addEvents(db, data.events || []);
    console.log(`Веб-поиск: извлечено ${(data.events || []).length}, новых ${added}. Токены in=${r.usage.input_tokens} out=${r.usage.output_tokens}`);
    store.save(db);
  } catch (e) { console.error('Ошибка фазы поиска:', e.message); }

  store.save(db);
  exportWeb(db);
  const ali = db.events.filter((e) => /alicante|benidorm|torrevieja|elche|orihuela|santa pola|calpe|denia|dénia|altea|vila joiosa|villajoyosa|alcoy|elda|petrer|guardamar|pilar de la horadada|formentera del segura/i.test((e.region || '') + ' ' + (e.city || '')));
  console.log(`ГОТОВО. По Аликанте и округе теперь: ${ali.length} событий. Всего в базе: ${db.events.length}`);
  ali.sort((a, b) => a.date.localeCompare(b.date)).forEach((e) => console.log(' -', e.date, e.title.slice(0, 55), '|', e.city));
}

run();
