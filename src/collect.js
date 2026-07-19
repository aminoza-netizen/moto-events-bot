// Сбор событий и новостей. Две фазы:
//  1) collectFromSources — Claude читает дайджест топ-30 источников (без веб-поиска, дёшево)
//  2) collectFromSearch  — Claude дополнительно ищет через встроенный веб-поиск
// Обе возвращают { events: [...], news: [...] } на русском языке.
const Anthropic = require('@anthropic-ai/sdk');
const { fetchAllSources } = require('./fetch-sources');

const MODEL = () => process.env.CLAUDE_MODEL || 'claude-sonnet-5';

function todayMadrid() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(new Date());
}

function knownList(knownEvents) {
  return knownEvents.length
    ? knownEvents.map((e) => `- ${e.title} (${e.date}, ${e.city})`).join('\n')
    : '(пока пусто)';
}

function knownNewsList(knownNews) {
  return knownNews && knownNews.length
    ? knownNews.map((t) => `- ${t}`).join('\n')
    : '(пока пусто)';
}

const JSON_SCHEMA_BLOCK = `Ответ верни СТРОГО в виде одного JSON-блока в fence \`\`\`json ... \`\`\` без другого текста после него:

{
  "events": [
    {
      "title": "оригинальное название события",
      "date": "YYYY-MM-DD",          // дата начала; если точная дата неизвестна — не включай событие
      "end_date": "YYYY-MM-DD",      // или null
      "city": "город",
      "region": "провинция/регион",
      "venue": "место проведения: площадка/адрес, если указаны в источнике (напр. 'Circuit Ricardo Tormo, Cheste' или 'Recinto ferial, Av. del Papa Luna'), иначе null",
      "url": "ссылка на источник",
      "image_url": "прямая ссылка на афишу/картинку события (jpg/png), если встретилась, иначе null",
      "short_ru": "одна строка по-русски: что это, для напоминаний",
      "announce_ru": "готовый пост для Telegram на русском"
    }
  ],
  "news": [
    { "title": "заголовок", "url": "ссылка", "image_url": "картинка или null", "post_ru": "готовый пост на русском" }
  ]
}

Требования к announce_ru и post_ru (это подпись к картинке в Telegram):
- НЕ дословный перевод. Перескажи своими словами: просто, коротко, по делу — как пишет живой админ канала для своих. Пост ПОЛНОСТЬЮ самодостаточен: всё важное внутри, читателю никуда не нужно переходить.
- Структура: эмодзи + цепляющий заголовок жирным → пустая строка → 2–3 коротких абзаца или строки-пункты.
- Для события обязательно: дата по-русски (напр. «15 августа»), город, что будет, для кого интересно; последняя строка: «📍 <b>Локация:</b> место/адрес, город».
- Для новости обязательно: что изменилось и ЧТО ЭТО ЗНАЧИТ для мотоциклиста в Испании — все цифры, суммы штрафов и даты точно, внутри поста. Если известна дата вступления в силу — укажи её явно («с 1 октября 2026»); не подавай будущее как уже действующее. Последняя строка новости: «Источник: Название» ОБЫЧНЫМ ТЕКСТОМ.
- НИКАКИХ внешних ссылок в тексте — ни <a>, ни голых URL (ссылку на нашу афишу бот добавит сам). Поле url в JSON заполняй как раньше — оно для календаря.
- Живой тон, 2–4 эмодзи. СТРОГО не длиннее 850 символов.
- Разрешён ТОЛЬКО такой HTML: <b>...</b>, <i>...</i>. Символы < > & в обычном тексте экранируй как &lt; &gt; &amp;.
- Ничего не выдумывай. Пустые массивы допустимы.`;

const AUDIENCE = `Ты редактор русскоязычного Telegram-канала для мотоциклистов, живущих в Испании.
Интересуют: мото-слёты (concentraciones moteras), фестивали, выставки, ярмарки, track days / tandas, благотворительные заезды, крупные rides, MotoGP и гонки как зрительские события.
ПРИОРИТЕТ: провинции Аликанте и Валенсия (Alicante, Benidorm, Torrevieja, Elche, Valencia, Gandía, Cheste и т.д.), затем Комунидад Валенсиана и Мурсия, затем крупные события всей Испании.
Также важны НОВОСТИ для мотоциклистов Испании: изменения законов DGT, штрафы, требования к экипировке, ITV для мото. Только свежие и значимые (0–3 штуки).`;

function extractJson(text) {
  const fence = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('JSON not found in model response');
  return JSON.parse(candidate.slice(start, end + 1));
}

function parseResult(response) {
  if (response.stop_reason === 'refusal') {
    throw new Error('Claude refused the request (safety classifiers)');
  }
  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  const data = extractJson(text);
  return {
    events: Array.isArray(data.events) ? data.events : [],
    news: Array.isArray(data.news) ? data.news : [],
    usage: response.usage,
  };
}

// ФАЗА 1: дайджест из sources.json → Claude извлекает события/новости (без веб-поиска)
async function collectFromSources(knownEvents, knownNews = []) {
  const { ok, failed } = await fetchAllSources();
  if (failed.length) {
    console.log(`Источники недоступны (${failed.length}): ${failed.map((f) => f.name).join(', ')}`);
  }
  if (!ok.length) throw new Error('Ни один источник не удалось загрузить');
  console.log(`Загружено источников: ${ok.length}/${ok.length + failed.length}`);

  const digest = ok
    .map((s) => `=== ИСТОЧНИК: ${s.name} (${s.region}) — ${s.url} ===\n${s.content}`)
    .join('\n\n');

  const prompt = `Сегодня ${todayMadrid()}. ${AUDIENCE}

Ниже — сегодняшний дайджест наших постоянных источников. Извлеки из него:
1. Мото-события с датой начала в ближайшие 90 дней (только те, что явно упомянуты в дайджесте, с датой и местом).
2. Важные новости для мотоциклистов (0–3).

Для url используй ссылку конкретной записи, если она есть в дайджесте, иначе адрес источника.

УЖЕ ИЗВЕСТНЫЕ события (НЕ включай повторно, даже с немного другим названием или датой):
${knownList(knownEvents)}

УЖЕ ОПУБЛИКОВАННЫЕ НОВОСТИ (НЕ включай ту же тему повторно, даже в другой формулировке — например, если про штраф за перчатки уже писали, вторая новость про перчатки НЕ нужна):
${knownNewsList(knownNews)}

${JSON_SCHEMA_BLOCK}

ДАЙДЖЕСТ:
${digest}`;

  const client = new Anthropic.Anthropic();
  const response = await client.messages
    .stream({
      model: MODEL(),
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      messages: [{ role: 'user', content: prompt }],
    })
    .finalMessage();

  return parseResult(response);
}

// ФАЗА 2: дополнительный веб-поиск (то, чего нет в постоянных источниках)
async function collectFromSearch(knownEvents, knownNews = []) {
  const prompt = `Сегодня ${todayMadrid()}. ${AUDIENCE}

Наши постоянные источники уже проверены. Найди через веб-поиск ДОПОЛНИТЕЛЬНО:
1. Мото-события в Испании на ближайшие 90 дней, которых нет в списке известных — особенно локальные события в провинциях Аликанте и Валенсия (афиши муниципалитетов, мото-клубы, соцсети).
2. Свежие важные новости для мотоциклистов Испании (0–2), если есть что-то значимое.

Ищи на испанском ("concentración motera", "eventos moteros Alicante", "quedada motera Valencia"), английском и русском.

УЖЕ ИЗВЕСТНЫЕ события (НЕ включай повторно, даже с немного другим названием или датой):
${knownList(knownEvents)}

УЖЕ ОПУБЛИКОВАННЫЕ НОВОСТИ (НЕ включай ту же тему повторно, даже в другой формулировке):
${knownNewsList(knownNews)}

${JSON_SCHEMA_BLOCK}`;

  const client = new Anthropic.Anthropic();
  const tools = [
    {
      type: 'web_search_20260209',
      name: 'web_search',
      max_uses: 6,
      user_location: { type: 'approximate', country: 'ES', timezone: 'Europe/Madrid' },
    },
  ];

  let messages = [{ role: 'user', content: prompt }];
  let response;

  // Серверный веб-поиск может вернуть pause_turn — продолжаем до конца хода
  for (let i = 0; i < 6; i++) {
    response = await client.messages
      .stream({
        model: MODEL(),
        max_tokens: 32000,
        thinking: { type: 'adaptive' },
        tools,
        messages,
      })
      .finalMessage();

    if (response.stop_reason !== 'pause_turn') break;
    messages = [...messages, { role: 'assistant', content: response.content }];
  }

  return parseResult(response);
}

module.exports = { collectFromSources, collectFromSearch };
