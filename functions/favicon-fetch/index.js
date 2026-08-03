// EdgeOne Pages Function: favicon-fetch
// 抓取目标网站的 favicon，转为 base64 data URL 返回。
//
// 抓取策略（按优先级依次尝试）：
//   1. 解析目标站点 HTML 的 <link rel="icon|shortcut icon|apple-touch-icon"> 指向的图标
//   2. 解析 <link rel="manifest"> 中 PWA 声明的图标
//   3. /favicon.ico 根路径 + 第三方图标服务（icon.horse、DuckDuckGo、Google）并行兜底
//
// 性能设计：
//   - 分级超时（HTML 6s、图标 6s、兜底 5s），单次请求最坏 ≈ 12s
//   - 兜底源并行竞速，整体耗时 = 单个兜底源超时，而非串行累加
//   - 成功响应附带 CDN 缓存头，重复请求（定时刷新）可命中缓存
//
// 兼容性：
//   - 支持只通过 <link rel="icon" href="/favicon.svg"> 引用图标的站点
//     （如 Next.js 站点），以及 PNG/ICO/SVG 等各种图标格式
//   - 处理 HTML 实体编码的 href（如 Next.js 输出的 data: SVG 图标）

// 分级超时：HTML 抓取与常规图标下载各 6s，兜底源（根路径 + 第三方）5s。
// 所有阶段均为并行或单阶段超时，单次请求最坏耗时 ≈ 12s（HTML 6s + 兜底 6s）。
const HTML_TIMEOUT_MS = 6 * 1000;
const ICON_TIMEOUT_MS = 6 * 1000;
const FALLBACK_TIMEOUT_MS = 5 * 1000;

// 成功响应附带 CDN 缓存头，同 URL 重复请求（如定时刷新图标）可命中缓存，
// 避免每次打开页面都重新抓取目标站点。
const CACHE_HEADERS = { 'cache-control': 'public, max-age=86400' };

// 常见 HTML 实体解码表。
const HTML_ENTITY_MAP = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  '#x27': "'",
};

// 解码 href 中的 HTML/XML 实体（如 &#x27;、&amp;、&quot;），
// 否则实体编码的 data URL 会被浏览器当作字面量而无法解析。
function decodeHtmlEntities(str) {
  if (!str || !str.includes('&')) return str;

  return str.replace(/&(#x?[0-9a-f]+|[a-z]+);?/gi, (full, entity) => {
    const key = entity.toLowerCase();

    if (HTML_ENTITY_MAP[key] !== undefined) {
      return HTML_ENTITY_MAP[key];
    }

    if (entity[0] === '#') {
      const isHex = entity[1] === 'x' || entity[1] === 'X';
      const code = parseInt(
        entity.slice(isHex ? 2 : 1),
        isHex ? 16 : 10
      );
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        return String.fromCodePoint(code);
      }
    }

    return full;
  });
}

function getHeaders() {
  return {
    'content-type': 'application/json; charset=UTF-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...getHeaders(),
      ...extraHeaders,
    },
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

// 基于文件头 magic bytes 校验内容是否真的是图像，
// 防止部分站点 /favicon.ico 返回 200 但内容是 HTML 时被误当作图标。
function looksLikeImage(bytes, contentType) {
  const ct = (contentType || '').toLowerCase();

  // 明确为文本/HTML/JSON 等非图像类型时拒绝。
  if (ct && /^(text\/html|application\/json|application\/javascript|text\/plain)/.test(ct)) {
    return false;
  }

  // 兼容 ArrayBuffer / Uint8Array 两种入参。
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

  // 至少需要 12 字节判断魔数（WEBP 需读到第 12 字节）。
  if (data.byteLength < 12) return false;

  const head = Array.from(data.slice(0, 12));
  const u8 = (val) => head[val];
  const str4 = () => String.fromCharCode(u8(0), u8(1), u8(2), u8(3));

  // SVG / XML 文本：以 <svg、<?xml、<!DOCTYPE svg 开头。
  // 注意 <html、<!DOCTYPE html 等普通 HTML 不属于图像。
  if (u8(0) === 0x3c) {
    const prefix = String.fromCharCode(...Array.from(data.slice(0, 64)));
    if (
      /^<\s*svg\b/i.test(prefix) ||
      /^<\s*\?xml/i.test(prefix) ||
      /^<!DOCTYPE\s+svg\b/i.test(prefix)
    ) {
      return true;
    }
  }

  if (ct && ct.includes('svg')) return true;

  switch (str4()) {
    case '\u0089PNG': // PNG: 89 50 4E 47
      return true;
    case 'GIF8': // GIF
      return true;
    case 'RIFF': // WEBP: RIFF....WEBP
      return (
        String.fromCharCode(u8(8), u8(9), u8(10), u8(11)) === 'WEBP'
      );
    default:
      break;
  }

  // ICO: 00 00 01 00
  if (u8(0) === 0x00 && u8(1) === 0x00 && u8(2) === 0x01 && u8(3) === 0x00) {
    return true;
  }

  // JPEG: FF D8 FF
  if (u8(0) === 0xff && u8(1) === 0xd8 && u8(2) === 0xff) {
    return true;
  }

  return false;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = ICON_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function tryFetchIcon(url, timeoutMs = ICON_TIMEOUT_MS) {
  try {
    const resp = await fetchWithTimeout(
      url,
      {
        method: 'GET',
        headers: {
          accept: 'image/*,*/*;q=0.8',
          // 部分站点对无 UA 请求返回 403，伪装常见浏览器 UA 提升兼容性。
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        },
        redirect: 'follow',
      },
      timeoutMs
    );

    if (!resp.ok) {
      return null;
    }

    const contentType = inferContentType(resp, url);
    // 原始响应 content-type 用于内容校验（推断后的类型会掩盖 text/html 等）。
    const rawContentType = resp.headers.get('content-type') || '';

    const arrayBuffer = await resp.arrayBuffer();

    if (!arrayBuffer || arrayBuffer.byteLength === 0) {
      return null;
    }

    // 校验文件头，拒绝非图像内容（如 200 但返回 HTML 的 /favicon.ico）。
    if (!looksLikeImage(arrayBuffer, rawContentType || contentType)) {
      return null;
    }

    return toBase64DataUrl(contentType, arrayBuffer);
  } catch (err) {
    console.error('Fetch icon failed:', url, err);
    return null;
  }
}

// 从单个 <link> 标签提取 href 属性值。
// 按引号类型分别匹配：双引号优先、单引号次之、无引号兜底，
// 避免 data URL 内部包含字面引号时被截断。
function extractHrefFromTag(tag) {
  let m = tag.match(/\bhref\s*=\s*"([^"]*)"/i);
  if (m) return m[1];

  m = tag.match(/\bhref\s*=\s*'([^']*)'/i);
  if (m) return m[1];

  m = tag.match(/\bhref\s*=\s*([^\s>]+)/i);
  if (m) return m[1];

  return null;
}

// 提取 <link> 标签的 rel 属性完整值（含空格分隔的多个值）。
function extractRelFromTag(tag) {
  let m = tag.match(/\brel\s*=\s*"([^"]*)"/i);
  if (m) return m[1];

  m = tag.match(/\brel\s*=\s*'([^']*)'/i);
  if (m) return m[1];

  m = tag.match(/\brel\s*=\s*([^\s>]+)/i);
  if (m) return m[1];

  return null;
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
    const rel = extractRelFromTag(tag);
    if (rel === null) continue;
    if (!rel.toLowerCase().split(/\s+/).some((r) => r.includes('icon'))) {
      continue;
    }

    const rawHref = extractHrefFromTag(tag);
    if (rawHref === null) continue;

    // 解码 HTML 实体，否则实体编码的 data URL / 含 &amp; 的 URL 无法使用。
    const href = decodeHtmlEntities(rawHref.trim());
    if (!href) continue;

    if (href.startsWith('data:')) {
      // data: URL 直接作为候选（无需再下载）。
      links.push({ url: href, isDataUrl: true });
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

// 解析 HTML 中的 <link rel="manifest">，返回 manifest URL（可能为 null）。
function extractManifestUrlFromHtml(html, baseUrl) {
  const linkRegex = /<link\b[^>]*>/gi;

  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    const tag = match[0];

    const rel = extractRelFromTag(tag);
    if (rel === null) continue;
    if (!rel.toLowerCase().split(/\s+/).includes('manifest')) continue;

    const rawHref = extractHrefFromTag(tag);
    if (rawHref === null) continue;

    try {
      return new URL(decodeHtmlEntities(rawHref.trim()), baseUrl).toString();
    } catch {
      return null;
    }
  }

  return null;
}

// 从 PWA manifest JSON 中提取图标 URL，按尺寸从大到小排序。
function extractIconsFromManifest(manifestJson, manifestUrl) {
  const icons = (manifestJson && Array.isArray(manifestJson.icons) && manifestJson.icons) || [];

  return icons
    .map((icon) => {
      if (!icon || typeof icon.src !== 'string' || !icon.src.trim()) return null;
      if (icon.src.trim().startsWith('data:')) {
        return { url: icon.src.trim(), isDataUrl: true, size: 0 };
      }
      try {
        return {
          url: new URL(icon.src.trim(), manifestUrl).toString(),
          isDataUrl: false,
          size: parseIconSize(icon.sizes),
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.size - a.size);
}

// 解析 PWA icon sizes 字符串（如 "192x192"），无有效尺寸返回 0。
function parseIconSize(sizes) {
  if (typeof sizes !== 'string') return 0;
  const m = sizes.match(/(\d+)x(\d+)/i);
  return m ? Math.max(Number(m[1]) || 0, Number(m[2]) || 0) : 0;
}

// 抓取目标站点首页 HTML，从中解析出图标候选 URL 与 manifest URL。
// 返回 { iconLinks: [], manifestUrl: string|null }。
async function fetchSiteHtmlInfo(targetUrl) {
  try {
    const resp = await fetchWithTimeout(
      targetUrl,
      {
        method: 'GET',
        headers: {
          accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        },
        redirect: 'follow',
      },
      HTML_TIMEOUT_MS
    );

    if (!resp.ok) {
      return { iconLinks: [], manifestUrl: null };
    }

    const contentType = (resp.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('html') && !contentType.includes('text')) {
      return { iconLinks: [], manifestUrl: null };
    }

    const html = await resp.text();
    if (!html) return { iconLinks: [], manifestUrl: null };

    const finalUrl = resp.url || targetUrl;
    return {
      iconLinks: extractIconLinksFromHtml(html, finalUrl),
      manifestUrl: extractManifestUrlFromHtml(html, finalUrl),
    };
  } catch (err) {
    console.error('Fetch site HTML failed:', targetUrl, err);
    return { iconLinks: [], manifestUrl: null };
  }
}

function buildThirdPartySources(hostname) {
  return [
    `https://icon.horse/icon/${hostname}`,
    `https://icons.duckduckgo.com/ip3/${hostname}.ico`,
    `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=128`,
  ];
}

// 抓取 PWA manifest 并返回其中按尺寸降序排列的图标候选。
async function fetchIconsFromManifest(manifestUrl) {
  try {
    const resp = await fetchWithTimeout(
      manifestUrl,
      {
        method: 'GET',
        headers: {
          accept: 'application/manifest+json,application/json,*/*;q=0.8',
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        },
        redirect: 'follow',
      },
      ICON_TIMEOUT_MS
    );

    if (!resp.ok) return [];

    const json = await resp.json();
    return extractIconsFromManifest(json, manifestUrl);
  } catch (err) {
    console.error('Fetch manifest failed:', manifestUrl, err);
    return [];
  }
}

// 并行竞速：返回第一个成功的图标 data URL；
// 全部失败（或全部返回 null）时返回 null。
// 整体耗时 = 第一个成功源的耗时；全失败时 = 最慢源 settle 的耗时。
// 避免某个慢源（如 /favicon.ico 挂起至超时）拖累整体。
async function raceFirstSuccess(fetchers) {
  let settled = 0;

  return new Promise((resolve) => {
    for (const fetcher of fetchers) {
      fetcher.then((value) => {
        if (value) {
          resolve(value);
          return;
        }

        settled += 1;
        if (settled === fetchers.length) {
          resolve(null);
        }
      });
    }
  });
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
    const { iconLinks, manifestUrl } = await fetchSiteHtmlInfo(targetUrl);

    for (const link of iconLinks) {
      if (link.isDataUrl) {
        return jsonResponse(
          { iconDataUrl: link.url, source: 'html-data-url' },
          200,
          CACHE_HEADERS
        );
      }

      const iconDataUrl = await tryFetchIcon(link.url);
      if (iconDataUrl) {
        return jsonResponse(
          { iconDataUrl, source: 'html-link' },
          200,
          CACHE_HEADERS
        );
      }
    }

    // 策略 2：解析 <link rel="manifest"> 中的 PWA 图标（无 HTML link 图标时）。
    if (iconLinks.length === 0 && manifestUrl) {
      const manifestIcons = await fetchIconsFromManifest(manifestUrl);
      for (const icon of manifestIcons) {
        if (icon.isDataUrl) {
          return jsonResponse(
            { iconDataUrl: icon.url, source: 'manifest-data-url' },
            200,
            CACHE_HEADERS
          );
        }

        const iconDataUrl = await tryFetchIcon(icon.url);
        if (iconDataUrl) {
          return jsonResponse(
            { iconDataUrl, source: 'manifest' },
            200,
            CACHE_HEADERS
          );
        }
      }
    }

    // 策略 3：/favicon.ico 根路径 + 第三方图标服务并行兜底。
    // 竞速语义：第一个成功源立即返回，整体耗时 = 最快成功源耗时。
    const fallbackSources = [
      `${parsed.protocol}//${hostname}/favicon.ico`,
      ...buildThirdPartySources(hostname),
    ];

    const fallbackIcon = await raceFirstSuccess(
      fallbackSources.map((source) => tryFetchIcon(source, FALLBACK_TIMEOUT_MS))
    );

    if (fallbackIcon) {
      return jsonResponse(
        { iconDataUrl: fallbackIcon, source: 'fallback' },
        200,
        CACHE_HEADERS
      );
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
