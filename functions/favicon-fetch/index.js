// EdgeOne Pages Function: favicon-fetch
// 抓取目标网站的 favicon，转为 base64 data URL 返回。
//
// 抓取策略（按优先级依次尝试）：
//   1. 解析目标站点 HTML 的 <link rel="icon|shortcut icon|apple-touch-icon"> 指向的图标
//   2. /favicon.ico 根路径图标
//   3. 第三方图标服务（DuckDuckGo、Google）作为兜底
//
// 这样可以兼容只通过 <link rel="icon" href="/favicon.svg"> 引用图标的站点
//（如 Next.js 站点），以及使用 PNG/ICO/SVG 等各种图标格式的站点。

const FETCH_TIMEOUT_MS = 8 * 1000;

function getHeaders() {
  return {
    'content-type': 'application/json; charset=UTF-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: getHeaders(),
  });
}

function toBase64DataUrl(contentType, arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';

  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }

  const base64 = btoa(binary);
  return `data:${contentType};base64,${base64}`;
}

// 根据响应头与 URL 推断图标 MIME 类型，兼容服务器未正确返回 content-type 的情况。
function inferContentType(resp, url) {
  const ct = (resp.headers.get('content-type') || '').toLowerCase();
  if (ct && ct.includes('image')) {
    return ct.split(';')[0].trim();
  }

  const lowerUrl = url.toLowerCase().split('?')[0].split('#')[0];
  if (lowerUrl.endsWith('.svg')) return 'image/svg+xml';
  if (lowerUrl.endsWith('.png')) return 'image/png';
  if (lowerUrl.endsWith('.ico')) return 'image/x-icon';
  if (lowerUrl.endsWith('.jpg') || lowerUrl.endsWith('.jpeg')) return 'image/jpeg';
  if (lowerUrl.endsWith('.webp')) return 'image/webp';
  if (lowerUrl.endsWith('.gif')) return 'image/gif';
  return 'image/x-icon';
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function tryFetchIcon(url) {
  try {
    const resp = await fetchWithTimeout(url, {
      method: 'GET',
      headers: {
        accept: 'image/*,*/*;q=0.8',
        // 部分站点对无 UA 请求返回 403，伪装常见浏览器 UA 提升兼容性。
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      },
      redirect: 'follow',
    });

    if (!resp.ok) {
      return null;
    }

    const contentType = inferContentType(resp, url);

    const arrayBuffer = await resp.arrayBuffer();

    if (!arrayBuffer || arrayBuffer.byteLength === 0) {
      return null;
    }

    return toBase64DataUrl(contentType, arrayBuffer);
  } catch (err) {
    console.error('Fetch icon failed:', url, err);
    return null;
  }
}

// 解析 HTML head 中的 <link rel="icon"> 等标签，提取图标候选 URL。
function extractIconLinksFromHtml(html, baseUrl) {
  const links = [];

  // 匹配 <link ... rel="icon|shortcut icon|apple-touch-icon" ... href="...">
  // rel 与 href 顺序不固定，且可能含单引号或无引号，故分别匹配再配对。
  const linkRegex = /<link\b[^>]*>/gi;
  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    const tag = match[0];

    // 只处理 head 区域的 link 标签（避免 body 中样式表等干扰）。
    // 简化处理：只要 rel 含 icon 关键字即可。
    const relMatch = tag.match(/rel\s*=\s*["']?([^"'\s>]+)/i);
    if (!relMatch) continue;
    const rel = relMatch[1].toLowerCase();
    if (
      !rel.includes('icon') &&
      rel !== 'shortcut icon' &&
      rel !== 'apple-touch-icon' &&
      rel !== 'apple-touch-icon-precomposed'
    ) {
      continue;
    }

    const hrefMatch = tag.match(/href\s*=\s*["']([^"']+)["']/i);
    if (!hrefMatch) continue;

    const href = hrefMatch[1].trim();
    if (!href || href.startsWith('data:')) {
      // data: URL 直接作为候选（无需再下载）。
      if (href && href.startsWith('data:')) {
        links.push({ url: href, isDataUrl: true });
      }
      continue;
    }

    try {
      const absoluteUrl = new URL(href, baseUrl).toString();
      links.push({ url: absoluteUrl, isDataUrl: false });
    } catch {
      // href 无效则跳过。
    }
  }

  return links;
}

// 抓取目标站点首页 HTML，从中解析出图标候选 URL。
async function fetchIconLinksFromSite(targetUrl) {
  try {
    const resp = await fetchWithTimeout(targetUrl, {
      method: 'GET',
      headers: {
        accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      },
      redirect: 'follow',
    });

    if (!resp.ok) {
      return [];
    }

    const contentType = (resp.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('html') && !contentType.includes('text')) {
      return [];
    }

    const html = await resp.text();
    if (!html) return [];

    const finalUrl = resp.url || targetUrl;
    return extractIconLinksFromHtml(html, finalUrl);
  } catch (err) {
    console.error('Fetch site HTML failed:', targetUrl, err);
    return [];
  }
}

function buildThirdPartySources(hostname) {
  return [
    `https://icons.duckduckgo.com/ip3/${hostname}.ico`,
    `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=128`,
  ];
}

export async function onRequestOptions() {
  return new Response('ok', {
    headers: getHeaders(),
  });
}

export async function onRequestGet({ request }) {
  try {
    const requestUrl = new URL(request.url);
    const targetUrl = requestUrl.searchParams.get('url') || '';

    if (!targetUrl) {
      return jsonResponse({ error: 'Missing url query parameter' }, 400);
    }

    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch {
      return jsonResponse({ error: 'Invalid url parameter' }, 400);
    }

    const hostname = parsed.hostname;

    // 策略 1：解析目标站点 HTML 中的 <link rel="icon"> 标签。
    // 这是兼容性最好的方式，能抓到 SVG、PNG 等非 ico 格式图标。
    const iconLinks = await fetchIconLinksFromSite(targetUrl);

    for (const link of iconLinks) {
      if (link.isDataUrl) {
        return jsonResponse({ iconDataUrl: link.url, source: 'html-data-url' });
      }

      const iconDataUrl = await tryFetchIcon(link.url);
      if (iconDataUrl) {
        return jsonResponse({ iconDataUrl, source: 'html-link' });
      }
    }

    // 策略 2：尝试 /favicon.ico 根路径。
    const rootFavicon = `${parsed.protocol}//${hostname}/favicon.ico`;
    const rootIcon = await tryFetchIcon(rootFavicon);
    if (rootIcon) {
      return jsonResponse({ iconDataUrl: rootIcon, source: 'root-favicon' });
    }

    // 策略 3：第三方图标服务兜底。
    for (const source of buildThirdPartySources(hostname)) {
      const iconDataUrl = await tryFetchIcon(source);
      if (iconDataUrl) {
        return jsonResponse({ iconDataUrl, source: 'third-party' });
      }
    }

    return jsonResponse({ error: 'Failed to download icon' }, 404);
  } catch (err) {
    return jsonResponse(
      {
        error: err && err.message ? err.message : String(err),
      },
      500
    );
  }
}

export async function onRequest(context) {
  const method = context.request.method;

  if (method === 'OPTIONS') {
    return onRequestOptions(context);
  }

  if (method === 'GET') {
    return onRequestGet(context);
  }

  return jsonResponse({ error: 'Method not allowed' }, 405);
}
