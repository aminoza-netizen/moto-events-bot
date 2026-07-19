// Поиск картинки для поста: og:image / twitter:image со страницы источника.
const TIMEOUT_MS = 12000;

function absolutize(imgUrl, pageUrl) {
  try {
    return new URL(imgUrl, pageUrl).href;
  } catch (e) {
    return null;
  }
}

function looksLikeImage(url) {
  if (!/^https?:\/\//i.test(url)) return false;
  if (/\.svg(\?|$)/i.test(url)) return false;
  // логотипы/иконки сайтов вместо афиши события — не берём
  if (/logo|icon|favicon|brand|avatar|placeholder|default[-_.]/i.test(url)) return false;
  return true;
}

// Вернёт прямой URL картинки или null. Никогда не бросает.
async function getPageImage(pageUrl) {
  if (!pageUrl || !/^https?:\/\//i.test(pageUrl)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(pageUrl, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });
    if (!res.ok) return null;
    const html = (await res.text()).slice(0, 300000);

    const patterns = [
      /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["']/i,
      /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i,
      /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i,
    ];
    for (const re of patterns) {
      const m = html.match(re);
      if (m) {
        const abs = absolutize(m[1].replace(/&amp;/g, '&'), pageUrl);
        if (abs && looksLikeImage(abs)) return abs;
      }
    }
    return null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { getPageImage };
