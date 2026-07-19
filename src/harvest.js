// Массовый разовый сбор событий на 90 дней вперёд: обходит календарные страницы
// по всем регионам Испании (последовательно — сайты режут параллельные запросы),
// скармливает Claude кусками и складывает всё в базу. Запуск: node src/harvest.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Anthropic = require('@anthropic-ai/sdk');
const store = require('./store');
const { exportWeb } = require('./export-web');

const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5';
const CHARS_PER_PAGE = parseInt(process.env.HARVEST_CHARS || '12000', 10);
const CHUNK_CHARS = 65000;

const PAGES = [
  ['Вся Испания', 'https://www.concentracionesdemotos.com/concentraciones/'],
  ['Comunidad Valenciana', 'https://www.concentracionesdemotos.com/comunidad-valenciana/'],
  ['Murcia', 'https://www.concentracionesdemotos.com/murcia/'],
  ['Andalucía', 'https://www.concentracionesdemotos.com/andalucia/'],
  ['Cataluña', 'https://www.concentracionesdemotos.com/cataluna/'],
  ['Madrid', 'https://www.concentracionesdemotos.com/madrid/'],
  ['Aragón', 'https://www.concentracionesdemotos.com/aragon/'],
  ['Asturias', 'https://www.concentracionesdemotos.com/asturias/'],
  ['Cantabria', 'https://www.concentracionesdemotos.com/cantabria/'],
  ['Castilla-La Mancha', 'https://www.concentracionesdemotos.com/castilla-la-mancha/'],
  ['Extremadura', 'https://www.concentracionesdemotos.com/extremadura/'],
  ['Galicia', 'https://www.concentracionesdemotos.com/galicia/'],
  ['La Rioja', 'https://www.concentracionesdemotos.com/la-rioja/'],
  ['Navarra', 'https://www.concentracionesdemotos.com/navarra/'],
  ['EventoMotor 2026', 'https://www.eventomotor.com/concentraciones-moteras-2026'],
  ['Moto-Ocasión 2026', 'https://www.moto-ocasion.com/magazine/concentraciones/concentraciones-moteras-2026-en-espana/'],
  ['MotoClub Motrix — агенда', 'https://www.motoclubmotrix.org/eventos.php?ob=0'],
  ['MotoClub Motrix — концентрации', 'https://www.motoclubmotrix.org/concentraciones.php'],
  ['PiezasDeMotos', 'https://piezasdemotos.com/eventos-moteros/'],
  ['Railroader', 'https://www.railroader.es/calendario/'],
  ['Todocircuito — тандас', 'https://www.todocircuito.com/tandas'],
  ['Racing100', 'https://www.racing100.com/'],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stripHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(br|p|div|li|tr|h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

async function fetchPage(name, url) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 20000);
  try {
    const r = await fetch(url, {
      signal: c.signal, redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        'Accept-Language': 'es-ES,es;q=0.9',
      },
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return stripHtml(await r.text()).slice(0, CHARS_PER_PAGE);
  } finally { clearTimeout(t); }
}

function extractJson(text) {
  const fence = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('JSON not found');
  return JSON.parse(candidate.slice(start, end + 1));
}

const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(new Date());

async function extractChunk(client, digest, known) {
  const knownList = known.length ? known.map((e) => `- ${e.title} (${e.date})`).join('\n') : '(пусто)';
  const prompt = `Сегодня ${today()}. Ты собираешь БАЗУ мото-событий Испании для календаря русскоязычного сообщества мотоциклистов.

Из дайджеста календарных страниц ниже извлеки ВСЕ мото-события с датой начала в ближайшие 90 дней: concentraciones, motoalmuerzos, matinales, слёты, фестивали, выставки, track days / tandas, благотворительные заезды, гонки как зрительские события. Чем полнее — тем лучше: нужно максимум событий. Только события, явно присутствующие в дайджесте, с конкретной датой.

УЖЕ В БАЗЕ (не включай повторно, даже с чуть другим названием/датой):
${knownList}

Верни СТРОГО один JSON-блок в fence \`\`\`json ... \`\`\`:
{
  "events": [
    {
      "title": "оригинальное название",
      "date": "YYYY-MM-DD",
      "end_date": "YYYY-MM-DD или null",
      "city": "город",
      "region": "провинция/регион",
      "venue": "площадка/адрес если указаны, иначе null",
      "url": "ссылка записи или страницы-источника",
      "short_ru": "одна строка по-русски: что это",
      "announce_ru": "пост для Telegram на русском, 300–600 символов: эмодзи + <b>заголовок</b>, пустая строка, 1–2 коротких абзаца (дата по-русски, город, что будет), последняя строка «📍 <b>Локация:</b> ...». БЕЗ ссылок и URL. Только теги <b> <i>."
    }
  ]
}

ДАЙДЖЕСТ:
${digest}`;

  const response = await client.messages
    .stream({ model: MODEL, max_tokens: 50000, thinking: { type: 'adaptive' }, messages: [{ role: 'user', content: prompt }] })
    .finalMessage();
  if (response.stop_reason === 'refusal') throw new Error('refusal');
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const data = extractJson(text);
  return { events: Array.isArray(data.events) ? data.events : [], usage: response.usage };
}

(async () => {
  console.log('Массовый сбор: обхожу', PAGES.length, 'страниц...');
  const pages = [];
  for (const [name, url] of PAGES) {
    try {
      const content = await fetchPage(name, url);
      pages.push({ name, url, content });
      console.log('OK  ', name, '—', content.length, 'симв.');
    } catch (e) {
      console.log('FAIL', name, '—', e.message);
    }
    await sleep(1300);
  }

  // Чанки по ~65k символов
  const chunks = [];
  let cur = '';
  for (const p of pages) {
    const block = `=== ${p.name} — ${p.url} ===\n${p.content}\n\n`;
    if (cur.length + block.length > CHUNK_CHARS && cur) { chunks.push(cur); cur = ''; }
    cur += block;
  }
  if (cur) chunks.push(cur);
  console.log(`Чанков для Claude: ${chunks.length}`);

  const client = new Anthropic.Anthropic();
  const db = store.load();
  let totalIn = 0, totalOut = 0;

  for (let i = 0; i < chunks.length; i++) {
    const known = db.events
      .filter((e) => (store.daysUntil(e.date) ?? -1) >= 0)
      .map((e) => ({ title: e.title, date: e.date }));
    try {
      console.log(`Чанк ${i + 1}/${chunks.length} → Claude (${chunks[i].length} симв., известно ${known.length} событий)...`);
      const r = await extractChunk(client, chunks[i], known);
      const added = store.addEvents(db, r.events);
      totalIn += r.usage.input_tokens; totalOut += r.usage.output_tokens;
      console.log(`  извлечено ${r.events.length}, новых ${added}. В базе: ${db.events.length}`);
      store.save(db);
    } catch (e) {
      console.error(`  ошибка чанка ${i + 1}:`, e.message);
    }
  }

  store.save(db);
  exportWeb(db);
  console.log(`ГОТОВО. Событий в базе: ${db.events.length}. Токены: in=${totalIn} out=${totalOut}`);
})();
