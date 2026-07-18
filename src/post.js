// Публикация в Telegram: пост в канал (с картинкой, если есть) + пересылка в группу.
const TOKEN = () => process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL = () => process.env.CHANNEL_ID;
const GROUP = () => (process.env.GROUP_ID || '').trim();

// Лимит Telegram: подпись к фото — 1024 символа, обычный текст — 4096
const CAPTION_LIMIT = 1000;

async function tg(method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN()}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) {
    const err = new Error(`Telegram ${method} failed: ${data.description}`);
    err.tg = data;
    throw err;
  }
  return data.result;
}

// Убрать HTML-теги (запасной вариант, если Telegram не принял разметку)
function stripHtml(html) {
  return html
    .replace(/<a\s+href="([^"]*)"[^>]*>([^<]*)<\/a>/gi, '$2 $1')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function isParseError(e) {
  return e.tg && e.tg.error_code === 400 && /parse|entit/i.test(e.tg.description || '');
}

// Отправить пост в канал: фото с подписью, если есть картинка и текст влезает,
// иначе обычное сообщение. Возвращает message_id.
async function sendToChannel(html, imageUrl) {
  // 1) Фото + подпись
  if (imageUrl && html.length <= CAPTION_LIMIT) {
    try {
      const msg = await tg('sendPhoto', {
        chat_id: CHANNEL(),
        photo: imageUrl,
        caption: html,
        parse_mode: 'HTML',
      });
      return msg.message_id;
    } catch (e) {
      if (isParseError(e)) {
        try {
          const msg = await tg('sendPhoto', { chat_id: CHANNEL(), photo: imageUrl, caption: stripHtml(html) });
          return msg.message_id;
        } catch (e2) { /* картинка битая — падаем в текст */ }
      }
      // Битая картинка / недоступный URL — постим текстом
      console.log(`Картинка не принята Telegram (${e.tg ? e.tg.description : e.message}), пост текстом`);
    }
  }

  // 2) Текст (превью ссылки покажет картинку страницы само)
  try {
    const msg = await tg('sendMessage', {
      chat_id: CHANNEL(),
      text: html,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: false },
    });
    return msg.message_id;
  } catch (e) {
    // Невалидный HTML от модели — шлём без разметки
    if (isParseError(e)) {
      const msg = await tg('sendMessage', { chat_id: CHANNEL(), text: stripHtml(html) });
      return msg.message_id;
    }
    throw e;
  }
}

// Переслать сообщение из канала в группу (если GROUP_ID задан)
async function forwardToGroup(messageId) {
  if (!GROUP()) return null;
  const msg = await tg('forwardMessage', {
    chat_id: GROUP(),
    from_chat_id: CHANNEL(),
    message_id: messageId,
  });
  return msg.message_id;
}

// Пост в канал + пересылка в группу одним вызовом
async function publish(html, imageUrl) {
  const messageId = await sendToChannel(html, imageUrl);
  try {
    await forwardToGroup(messageId);
  } catch (e) {
    console.error('Пересылка в группу не удалась:', e.message);
  }
  return messageId;
}

module.exports = { publish, sendToChannel, forwardToGroup, stripHtml };
