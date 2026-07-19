// Мост «написать администратору»: длинный поллинг getUpdates.
// Любое личное сообщение боту пересылается админу (ADMIN_CHAT_ID).
// /start — приветствие с кнопками мини-аппа и группы.
const TOKEN = () => process.env.TELEGRAM_BOT_TOKEN;
const ADMIN = () => (process.env.ADMIN_CHAT_ID || '').trim();
const WEBAPP_URL = () => (process.env.WEBAPP_URL || '').trim();
const GROUP_LINK = 'https://t.me/MotorcyclesSpain';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tg(method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN()}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

async function handleMessage(msg) {
  if (!msg || !msg.chat || msg.chat.type !== 'private') return;
  const chatId = msg.chat.id;
  const text = msg.text || '';

  if (text.startsWith('/start')) {
    const buttons = [];
    if (WEBAPP_URL()) buttons.push([{ text: '📅 Открыть мото-афишу', web_app: { url: WEBAPP_URL() } }]);
    buttons.push([{ text: '💬 Группа — общение', url: GROUP_LINK }]);
    buttons.push([{ text: '📣 Канал — афиша', url: 'https://t.me/motospainnew' }]);
    await tg('sendMessage', {
      chat_id: chatId,
      text: '🏍 Привет! Это бот мото-афиши Испании.\n\nЗдесь календарь событий, а если хочешь написать администратору — просто отправь сообщение в этот чат, я передам.',
      reply_markup: { inline_keyboard: buttons },
    });
    return;
  }

  // Обычное сообщение → пересылаем админу
  if (ADMIN()) {
    const fwd = await tg('forwardMessage', { chat_id: ADMIN(), from_chat_id: chatId, message_id: msg.message_id });
    if (fwd.ok) {
      const from = msg.from || {};
      const who = [from.first_name, from.last_name].filter(Boolean).join(' ') + (from.username ? ` (@${from.username})` : '');
      await tg('sendMessage', {
        chat_id: ADMIN(),
        text: `⬆️ Сообщение от ${who || 'подписчика'}. Ответить: ${from.username ? 'https://t.me/' + from.username : 'через пересланное сообщение'}`,
      });
      await tg('sendMessage', { chat_id: chatId, text: 'Передал администратору ✅ Он ответит тебе лично.' });
    }
  } else {
    console.log(`[admin-bridge] сообщение от chat_id=${chatId}, но ADMIN_CHAT_ID не задан в .env`);
    await tg('sendMessage', { chat_id: chatId, text: 'Спасибо! Сообщение получено.' });
  }
}

// Бесконечный длинный поллинг. Запускается только в режиме демона.
async function startAdminBridge() {
  let offset = 0;
  console.log('Мост «написать админу» запущен (getUpdates).');
  while (true) {
    try {
      const res = await tg('getUpdates', { timeout: 50, offset: offset + 1, allowed_updates: ['message'] });
      if (res.ok && Array.isArray(res.result)) {
        for (const u of res.result) {
          offset = Math.max(offset, u.update_id);
          try { await handleMessage(u.message); } catch (e) { console.error('[admin-bridge]', e.message); }
        }
      } else if (!res.ok) {
        console.error('[admin-bridge] getUpdates:', res.description);
        await sleep(10000);
      }
    } catch (e) {
      console.error('[admin-bridge] сеть:', e.message);
      await sleep(10000);
    }
  }
}

module.exports = { startAdminBridge };
