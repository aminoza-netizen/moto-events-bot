// Экспорт данных для мини-аппа: docs/data/events.json (+ git push, чтобы GitHub Pages обновился).
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'docs', 'data');
const OUT_FILE = path.join(OUT_DIR, 'events.json');

function daysUntilMadrid(dateStr) {
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(new Date());
  const [y1, m1, d1] = today.split('-').map(Number);
  const [y2, m2, d2] = String(dateStr).split('-').map(Number);
  if (!y2) return null;
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

// Нормализация региона к автономному сообществу (для фильтра без дублей)
const ZONES = [
  ['Комунидад Валенсиана', /valencia|valència|alicante|alacant|castell|benidorm|torrevieja|elche|gandia|cheste|xativa|xàtiva|peniscola|peñiscola/],
  ['Мурсия', /murcia|cartagena|lorca/],
  ['Каталония', /catalu|barcelona|girona|lleida|tarragona|montmel/],
  ['Андалусия', /andalu|sevilla|malaga|málaga|cadiz|cádiz|cordoba|córdoba|granada|huelva|jaen|jaén|almeria|almería|jerez/],
  ['Мадрид', /madrid|jarama/],
  ['Кастилия-и-Леон', /castilla y le|valladolid|zamora|salamanca|leon,|león|burgos|palencia|avila|ávila|segovia|soria|tordesillas/],
  ['Кастилия-Ла-Манча', /la mancha|toledo|ciudad real|cuenca|guadalajara|albacete/],
  ['Галисия', /galicia|coruña|coruna|lugo|ourense|pontevedra/],
  ['Астурия', /asturias|gijon|gijón|oviedo|llanes/],
  ['Кантабрия', /cantabria|santander/],
  ['Страна Басков', /vasco|euskadi|bizkaia|vizcaya|gipuzkoa|guipuzcoa|guipúzcoa|alava|álava|araba|bilbao/],
  ['Наварра', /navarra|pamplona/],
  ['Ла-Риоха', /rioja|logroño|logrono/],
  ['Арагон', /aragon|aragón|zaragoza|huesca|teruel|motorland|alcañiz|alcaniz/],
  ['Эстремадура', /extremadura|caceres|cáceres|badajoz/],
  ['Балеары', /balear|mallorca|ibiza|menorca/],
  ['Канары', /canaria|tenerife|las palmas|lanzarote|fuerteventura/],
];

function zoneOf(ev) {
  const s = `${ev.region || ''} ${ev.city || ''}`
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
  for (const [name, re] of ZONES) if (re.test(s)) return name;
  return 'Другие регионы';
}

// Собрать публичные данные из базы бота
function buildWebData(db) {
  const events = db.events
    .filter((e) => {
      const end = e.end_date || e.date;
      const d = daysUntilMadrid(end);
      return d !== null && d >= -1; // показываем до дня после окончания
    })
    .map((e) => ({
      id: e.id,
      title: e.title,
      date: e.date,
      end_date: e.end_date || null,
      city: e.city || '',
      region: e.region || '',
      zone: zoneOf(e),
      venue: e.venue || '',
      url: e.url || '',
      image_url: e.image_url || null,
      short_ru: e.short_ru || '',
      // полный текст для детальной карточки в мини-аппе (без внешней ссылки в конце)
      full_ru: String(e.announce_ru || '').replace(/\n*<a href="[^"]*">[^<]*<\/a>\s*$/i, '').trimEnd(),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const news = db.news
    .slice(-10)
    .reverse()
    .map((n) => ({
      title: n.title,
      url: n.url || '',
      post_ru: n.post_ru || '',
      created_at: n.created_at,
    }));

  return { generated_at: new Date().toISOString(), events, news };
}

// Записать и (по возможности) запушить на GitHub, чтобы Pages обновился.
// Сбой пуша не фатален — бот продолжает работать, данные догонятся при следующем запуске.
function exportWeb(db) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const data = buildWebData(db);
  fs.writeFileSync(OUT_FILE, JSON.stringify(data, null, 2), 'utf8');
  console.log(`Веб-данные обновлены: ${data.events.length} событий, ${data.news.length} новостей`);

  if (process.env.WEB_PUSH === '0') return;
  try {
    const opts = { cwd: ROOT, stdio: 'pipe' };
    execSync('git add docs/data/events.json', opts);
    const changed = execSync('git status --porcelain docs/data/events.json', opts).toString().trim();
    if (!changed) return; // нечего пушить
    execSync('git -c user.name="moto-bot" -c user.email="bot@local" commit -m "data: update web events" ', opts);
    execSync('git push', opts);
    console.log('Календарь на GitHub Pages обновлён (git push).');
  } catch (e) {
    console.error('Не удалось запушить веб-данные (календарь обновится при следующем удачном пуше):', e.message.split('\n')[0]);
  }
}

module.exports = { exportWeb, buildWebData };
