// Сбор событий и новостей через Claude + встроенный веб-поиск.
// Возвращает { events: [...], news: [...] } на русском языке.
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-4-8';

function buildPrompt(knownEvents) {
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(new Date());
  const knownList = knownEvents.length
    ? knownEvents.map((e) => `- ${e.title} (${e.date}, ${e.city})`).join('\n')
    : '(пока пусто)';

  return `Сегодня ${today}. Ты редактор русскоязычного Telegram-канала для мотоциклистов, живущих в Испании.

Найди через веб-поиск:

1. МОТО-СОБЫТИЯ в Испании на ближайшие 90 дней: мото-слёты (concentraciones moteras), фестивали, выставки, ярмарки, track days, benéficas/благотворительные заезды, крупные rides.
   - ПРИОРИТЕТ: провинции Аликанте и Валенсия (Alicante, Benidorm, Torrevieja, Elche, Valencia, Gandía и т.д.), затем вся Коммунидад Валенсиана и Мурсия, затем крупные события по всей Испании (Мадрид, Барселона, Херес, MotoGP и т.п.).
   - Ищи на испанском ("concentración motera 2026", "eventos moteros Alicante", "feria moto"), английском и русском. Проверяй календари типа todocircuito, lacomunidad motera, клубные сайты, afiches.

2. НОВОСТИ, важные для мотоциклистов в Испании (0–3 штуки): изменения законов DGT, штрафы, требования к экипировке, ITV для мото, новые правила. Только реально свежие и значимые.

УЖЕ ИЗВЕСТНЫЕ события (НЕ включай их повторно, даже с немного другим названием или датой):
${knownList}

Ответ верни СТРОГО в виде одного JSON-блока в fence \`\`\`json ... \`\`\` без другого текста после него:

{
  "events": [
    {
      "title": "оригинальное название события",
      "date": "YYYY-MM-DD",          // дата начала; если известен только месяц — не включай событие
      "end_date": "YYYY-MM-DD",      // или null
      "city": "город",
      "region": "провинция/регион",
      "url": "ссылка на источник",
      "short_ru": "одна строка по-русски: что это, для напоминаний",
      "announce_ru": "готовый пост для Telegram на русском"
    }
  ],
  "news": [
    { "title": "заголовок", "url": "ссылка", "post_ru": "готовый пост на русском" }
  ]
}

Требования к announce_ru и post_ru:
- Живой, дружелюбный тон, 2–5 эмодзи, до 900 символов.
- Начни с эмодзи и цепляющего заголовка жирным.
- Для события укажи: дату (по-русски, напр. «15 августа»), город, что будет, для кого интересно.
- Разрешён ТОЛЬКО такой HTML: <b>...</b>, <i>...</i>, <a href="...">...</a>. Никаких других тегов, никакого Markdown. Символы < > & в обычном тексте экранируй как &lt; &gt; &amp;.
- В конце поста ссылка на источник через <a>.
- Не выдумывай события: только то, что реально нашлось в поиске, с рабочей ссылкой. Если событий мало — верни мало. Пустые массивы тоже допустимы.`;
}

function extractJson(text) {
  const fence = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('JSON not found in model response');
  return JSON.parse(candidate.slice(start, end + 1));
}

async function collect(knownEvents) {
  const client = new Anthropic.Anthropic();

  const tools = [
    {
      type: 'web_search_20260209',
      name: 'web_search',
      max_uses: 8,
      user_location: { type: 'approximate', country: 'ES', timezone: 'Europe/Madrid' },
    },
  ];

  let messages = [{ role: 'user', content: buildPrompt(knownEvents) }];
  let response;

  // Серверный веб-поиск может вернуть pause_turn — продолжаем до конца хода
  for (let i = 0; i < 6; i++) {
    response = await client.messages.stream({
      model: MODEL,
      max_tokens: 32000,
      thinking: { type: 'adaptive' },
      tools,
      messages,
    }).finalMessage();

    if (response.stop_reason !== 'pause_turn') break;
    messages = [...messages, { role: 'assistant', content: response.content }];
  }

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

module.exports = { collect };
