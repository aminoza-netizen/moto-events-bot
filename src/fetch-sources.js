// Ежедневный обход списка источников из sources.json.
// Каждый URL качается напрямую; RSS/Atom распознаётся автоматически,
// остальное обрабатывается как HTML (текст без тегов).
// Сбой одного источника не влияет на остальные.
const fs = require('fs');
const path = require('path');

const SOURCES_FILE = path.join(__dirname, '..', 'sources.json');
const FETCH_TIMEOUT_MS = 20000;
const MAX_CHARS_PER_SOURCE = 2500;
const MAX_RSS_ITEMS = 12;

function loadSources() {
  const raw = JSON.parse(fs.readFileSync(SOURCES_FILE, 'utf8'));
  return Array.isArray(raw.sources) ? raw.sources : [];
}

function decodeEntities(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

function stripHtml(html) {
  return decodeEntities(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<(br|p|div|li|tr|h[1-6])\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

function pick(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? decodeEntities(m[1]).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
}

// RSS 2.0 (<item>) и Atom (<entry>)
function parseFeed(xml) {
  const items = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  for (const block of blocks.slice(0, MAX_RSS_ITEMS)) {
    const title = pick(block, 'title');
    let link = pick(block, 'link');
    if (!link) {
      const href = block.match(/<link[^>]*href="([^"]+)"/i);
      link = href ? href[1] : '';
    }
    const date = pick(block, 'pubDate') || pick(block, 'updated') || pick(block, 'published');
    const desc = (pick(block, 'description') || pick(block, 'summary')).slice(0, 300);
    if (title) items.push(`• ${title}${date ? ` [${date}]` : ''}${link ? `\n  ${link}` : ''}${desc ? `\n  ${desc}` : ''}`);
  }
  return items.join('\n');
}

async function fetchOne(source) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(source.url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.5',
      },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.text();

    const isFeed = /^\s*<\?xml/.test(body) || /<rss[\s>]/i.test(body) || /<feed[\s>]/i.test(body);
    let content = isFeed ? parseFeed(body) : stripHtml(body);
    if (!content) content = stripHtml(body); // фид не распарсился — берём как текст
    content = content.slice(0, MAX_CHARS_PER_SOURCE);
    return { name: source.name, url: source.url, region: source.region || '', topic: source.topic || 'events', content };
  } finally {
    clearTimeout(timer);
  }
}

// Обойти все источники параллельно. Возвращает { ok: [...], failed: [{name, error}] }
async function fetchAllSources() {
  const sources = loadSources();
  const results = await Promise.allSettled(sources.map(fetchOne));
  const ok = [];
  const failed = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value.content.length > 100) ok.push(r.value);
    else failed.push({ name: sources[i].name, error: r.status === 'rejected' ? r.reason.message : 'пустой ответ' });
  });
  return { ok, failed };
}

module.exports = { fetchAllSources, loadSources };
