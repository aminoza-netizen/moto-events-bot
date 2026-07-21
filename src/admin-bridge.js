// Мост «написать администратору» + база подписчиков + рассылка.
// Длинный поллинг getUpdates:
//  - каждый, кто пишет боту или разрешает доступ из мини-аппа, попадает в data/users.json
//  - личные сообщения пересылаются админу (ADMIN_CHAT_ID)
//  - команды админа: /stats — размер базы, /broadcast <текст> — рассылка всем
const store = require('./store');

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

// Рассылка по базе. Троттлинг ~15 сообщений/сек (лимит Telegram — 30/сек).
async function broadcast(text) {
  const users = store.loadUsers().users.filter((u) => !u.blocked);
  let ok = 0, blocked = 0, failed = 0;
  for (const u of users) {
    const r = await tg('sendMessage', { chat_id: u.id, text, parse_mode: 'HTML' });
    if (r.ok) ok++;
    else if (r.error_code === 403) { blocked++; store.markBlocked(u.id); }
    else failed++;
    await sleep(70);
  }
  return { ok, blocked, failed, total: users.length };
}

async function handleAdminCommand(text, chatId) {
  if (text === '/stats') {
    const users = store.loadUsers().users;
    const active = users.filter((u) => !u.blocked).length;
    await tg('sendMessage', {
      chat_id: chatId,
      text: `📊 База бота: ${users.length} чел., активных ${active}, заблокировали ${users.length - active}.`,
    });
    return true;
  }
  if (text.startsWith('/broadcast')) {
    const payload = text.slice('/broadcast'.length).trim();
    if (!payload) {
      await tg('sendMessage', {
        chat_id: chatId,
        text: 'Формат: /broadcast текст сообщения\nМожно HTML: <b>жирный</b>, <i>курсив</i>, <a href="...">ссылка</a>.\nУйдёт всем из базы (посмотреть размер: /stats).',
      });
      return true;
    }
    await tg('sendMessage', { chat_id: chatId, text: '📤 Рассылаю...' });
    const r = await broadcast(payload);
    await tg('sendMessage', {
      chat_id: chatId,
      text: `✅ Рассылка завершена: доставлено ${r.ok} из ${r.total}${r.blocked ? `, заблокировали бота: ${r.blocked}` : ''}${r.failed ? `, ошибок: ${r.failed}` : ''}.`,
    });
    return true;
  }
  return false;
}

async function handleMessage(msg) {
  if (!msg || !msg.chat || msg.chat.type !== 'private') return;
  const chatId = msg.chat.id;
  const from = msg.from || {};
  const text = msg.text || '';

  // Каждый написавший — в базу подписчиков
  const isNew = store.addUser({ id: chatId, first_name: from.first_name, username: from.username });
  if (isNew && ADMIN() && String(chatId) !== ADMIN()) {
    tg('sendMessage', { chat_id: ADMIN(), text: `➕ Новый подписчик бота: ${[from.first_name, from.last_name].filter(Boolean).join(' ')}${from.username ? ' (@' + from.username + ')' : ''}. Всего: ${store.loadUsers().users.length}` }).catch(() => {});
  }

  // Разрешение писать из мини-аппа (кнопка «Подписаться»)
  if (msg.write_access_allowed) {
    await tg('sendMessage', {
      chat_id: chatId,
      text: '🔔 Отлично, подписка оформлена! Самые важные события и новости будут приходить сюда.',
    });
    return;
  }

  // Команды админа
  if (ADMIN() && String(chatId) === ADMIN()) {
    if (await handleAdminCommand(text, chatId)) return;
  }

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
      const who = [from.first_name, from.last_name].filter(Boolean).join(' ') + (from.username ? ` (@${from.username})` : '');
      await tg('sendMessage', {
        chat_id: ADMIN(),
        text: `⬆️ Сообщение от ${who || 'подписчика'}. Ответить: ${from.username ? 'https://t.me/' + from.username : 'через пересланное сообщение'}`,
      });
      await tg('sendMessage', { chat_id: chatId, text: 'Передал администратору ✅ Он ответит тебе лично.' });
    }
  } else {
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

module.exports = { startAdminBridge, broadcast };
