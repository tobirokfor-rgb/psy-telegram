/**
 * Cloudflare Worker shell for psy-telegram.
 * Reads the active Telegram link config from LINK_CONFIG_KV on / and /index.html requests,
 * injects url/deeplink/version server-side into index.html, and disables edge/browser caching.
 * All other assets (including track-*.json analytics beacons) pass directly through ASSETS.
 */

const FALLBACK_TG_URL = "https://t.me/+IukZVSEw0io4NGEy";
const CHANNEL_META_KV_KEY = "channel_meta_cache";
const CHANNEL_META_TTL_MS = 6 * 60 * 60 * 1000;

function decodeHtmlEntities(str) {
  return String(str || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&nbsp;", " ");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function extractMetaTag(html, propName) {
  const re1 = new RegExp(
    `<meta[^>]+(?:property|name)=["']${propName}["'][^>]*content=["']([^"']*)["'][^>]*>`,
    "i",
  );
  const re2 = new RegExp(
    `<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${propName}["'][^>]*>`,
    "i",
  );
  const m = html.match(re1) || html.match(re2);
  return m ? decodeHtmlEntities(m[1]).trim() : "";
}

function formatMembersCount(rawCount) {
  const digits = String(rawCount || "").replace(/[^\d]/g, "");
  if (!digits) return "";
  const num = parseInt(digits, 10);
  if (!Number.isFinite(num) || num <= 0) return "";
  const spaced = String(num).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const mod100 = num % 100;
  const mod10 = num % 10;
  const word =
    mod100 >= 11 && mod100 <= 14
      ? "участников"
      : mod10 === 1
        ? "участник"
        : mod10 >= 2 && mod10 <= 4
          ? "участника"
          : "участников";
  return `${spaced} ${word}`;
}

export function parseTelegramChannelPreview(html) {
  const raw = String(html || "");
  let title = extractMetaTag(raw, "og:title");
  if (!title || /^Telegram(?:\s*:|\s+Messenger|$)/i.test(title) || /^Join group chat/i.test(title)) {
    title = "";
  }

  let avatarUrl = extractMetaTag(raw, "og:image");
  if (!/^https:\/\//i.test(avatarUrl) || /telegram\.org\/img\/t_logo/i.test(avatarUrl)) {
    avatarUrl = "";
  }

  let membersText = "";
  const extraMatch = raw.match(/<div\b[^>]*class=["'][^"']*tgme_page_extra[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
  if (extraMatch) {
    const cleanExtra = decodeHtmlEntities(extraMatch[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    const countMatch = cleanExtra.match(/([\d\s.,]+)\s*(?:subscribers?|members?|участник\w*|подписчик\w*)/i);
    if (countMatch) {
      membersText = formatMembersCount(countMatch[1]);
    }
  }

  return { title, avatarUrl, membersText };
}

async function fetchAndCacheChannelMeta(targetUrl, env) {
  try {
    const resp = await fetch(targetUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; TTAutoPreview/1.0)",
        "Accept-Language": "ru,en;q=0.9",
      },
      signal: AbortSignal.timeout(1800),
    });
    if (!resp.ok) return null;
    const html = await resp.text();
    const parsed = parseTelegramChannelPreview(html);
    if (!parsed.title && !parsed.avatarUrl && !parsed.membersText) {
      return null;
    }
    const meta = {
      url: targetUrl,
      title: parsed.title,
      avatarUrl: parsed.avatarUrl,
      membersText: parsed.membersText,
      fetchedAt: Date.now(),
    };
    if (env?.LINK_CONFIG_KV) {
      await env.LINK_CONFIG_KV.put(CHANNEL_META_KV_KEY, JSON.stringify(meta));
    }
    return meta;
  } catch {
    return null;
  }
}

async function getChannelMeta(targetUrl, env, ctx) {
  if (!env?.LINK_CONFIG_KV) return null;
  let cached = null;
  try {
    cached = await env.LINK_CONFIG_KV.get(CHANNEL_META_KV_KEY, "json");
  } catch {
    cached = null;
  }

  if (cached && cached.url === targetUrl) {
    const age = Date.now() - (Number(cached.fetchedAt) || 0);
    if (age > CHANNEL_META_TTL_MS && ctx?.waitUntil) {
      ctx.waitUntil(fetchAndCacheChannelMeta(targetUrl, env));
    }
    return cached;
  }

  return await fetchAndCacheChannelMeta(targetUrl, env);
}

/**
 * Validates and resolves Telegram URL or @username to canonical url + native deeplink.
 */
export function resolveTelegramLink(rawInput) {
  const trimmed = String(rawInput || "").trim();
  if (!trimmed || /\s/.test(trimmed)) {
    return null;
  }

  if (trimmed.startsWith("@")) {
    const uname = trimmed.slice(1);
    if (!/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(uname)) {
      return null;
    }
    return {
      url: `https://t.me/${uname}`,
      link_type: "public",
      deeplink: `tg://resolve?domain=${uname}`,
    };
  }

  const candidate = /^(?:t\.me|telegram\.me|telegram\.dog)\//i.test(trimmed)
    ? `https://${trimmed}`
    : trimmed;

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  if (!["t.me", "telegram.me", "telegram.dog", "www.t.me"].includes(host)) {
    return null;
  }

  const path = parsed.pathname.replace(/\/+$/, "");
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) {
    return null;
  }

  if (segments[0].toLowerCase() === "c") {
    return null;
  }

  if (segments.length === 1 && segments[0].startsWith("+")) {
    const hash = segments[0].slice(1);
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(hash)) {
      return null;
    }
    return {
      url: `https://t.me/+${hash}`,
      link_type: "invite",
      deeplink: `tg://join?invite=${hash}`,
    };
  }

  if (segments.length === 2 && segments[0].toLowerCase() === "joinchat") {
    const hash = segments[1];
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(hash)) {
      return null;
    }
    return {
      url: `https://t.me/+${hash}`,
      link_type: "invite",
      deeplink: `tg://join?invite=${hash}`,
    };
  }

  if (segments.length === 1) {
    const uname = segments[0];
    if (!/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(uname)) {
      return null;
    }
    return {
      url: `https://t.me/${uname}`,
      link_type: "public",
      deeplink: `tg://resolve?domain=${uname}`,
    };
  }

  return null;
}

function escapeHtmlAttr(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function serializeSafeJsonForScript(obj) {
  return JSON.stringify(obj)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}

function normalizeAndroidIntentMode(rawMode) {
  const clean = String(rawMode || "").trim().toLowerCase();
  return ["off", "telegram", "browser"].includes(clean) ? clean : "off";
}

/**
 * Rewrites #action-btn href and #tg-config JSON block inside the shell index.html.
 */
export function rewriteIndexHtml(
  html,
  { url, deeplink, version = 1, android_intent_mode = "off", channelTitle = "", channelMembers = "", avatarSrc = "" },
) {
  const safeUrlAttr = escapeHtmlAttr(url);
  const safeJson = serializeSafeJsonForScript({
    url,
    deeplink,
    version: Number(version) || 1,
    android_intent_mode: normalizeAndroidIntentMode(android_intent_mode),
  });

  // Update href on <a ... id="action-btn" ...> regardless of attribute order
  let out = String(html).replace(
    /<a\b([^>]*\bid=["']action-btn["'][^>]*)>/i,
    (fullMatch, attrs) => {
      if (/\bhref\s*=\s*["'][^"']*["']/i.test(attrs)) {
        const updatedAttrs = attrs.replace(
          /\bhref\s*=\s*["'][^"']*["']/i,
          () => `href="${safeUrlAttr}"`,
        );
        return `<a${updatedAttrs}>`;
      }
      return `<a href="${safeUrlAttr}"${attrs}>`;
    },
  );

  if (channelTitle) {
    out = out.replace(
      /(<h1\b[^>]*\bid=["']channel-title["'][^>]*>)([\s\S]*?)(<\/h1>)/i,
      (_, openTag, _old, closeTag) => `${openTag}${escapeHtml(channelTitle)}${closeTag}`,
    );
  }

  if (channelMembers) {
    out = out.replace(
      /(<span\b[^>]*\bid=["']channel-sub["'][^>]*>)([\s\S]*?)(<\/span>)/i,
      (_, openTag, _old, closeTag) => `${openTag}Закрытый канал · ${escapeHtml(channelMembers)}${closeTag}`,
    );
  }

  if (avatarSrc) {
    const imgTag = `<img id="channel-avatar" class="tg-avatar-img" src="${escapeHtmlAttr(avatarSrc)}" alt="" onerror="this.style.display='none'">`;
    out = out.replace(
      /(<div\b[^>]*\bid=["']tg-avatar-wrap["'][^>]*>)/i,
      (_, openTag) => `${openTag}${imgTag}`,
    );
  }

  // Replace <script id="tg-config" type="application/json">...</script>
  const cfgPattern = /(<script\b[^>]*\bid=["']tg-config["'][^>]*>)([\s\S]*?)(<\/script>)/i;
  if (cfgPattern.test(out)) {
    out = out.replace(cfgPattern, (_, openTag, _oldBody, closeTag) => `${openTag}${safeJson}${closeTag}`);
  } else {
    out = out.replace(
      /<\/body>/i,
      () => `  <script id="tg-config" type="application/json">${safeJson}</script>\n</body>`,
    );
  }

  return out;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/channel-avatar") {
      let meta = null;
      if (env?.LINK_CONFIG_KV) {
        try {
          meta = await env.LINK_CONFIG_KV.get(CHANNEL_META_KV_KEY, "json");
        } catch {
          meta = null;
        }
      }
      if (!meta?.avatarUrl) {
        return new Response("Not found", { status: 404 });
      }
      try {
        const imgResp = await fetch(meta.avatarUrl, { signal: AbortSignal.timeout(3000) });
        if (!imgResp.ok) {
          return new Response("Not found", { status: 404 });
        }
        const headers = new Headers();
        headers.set("Content-Type", imgResp.headers.get("Content-Type") || "image/jpeg");
        headers.set("Cache-Control", "public, max-age=3600");
        return new Response(imgResp.body, { status: 200, headers });
      } catch {
        return new Response("Not found", { status: 404 });
      }
    }

    const isHtmlEntry =
      (request.method === "GET" || request.method === "HEAD") &&
      (url.pathname === "/" || url.pathname === "/index.html");

    if (!isHtmlEntry) {
      return env.ASSETS.fetch(request);
    }

    let kvCfg = null;
    if (env?.LINK_CONFIG_KV) {
      try {
        kvCfg = await env.LINK_CONFIG_KV.get("channel_config", "json");
      } catch {
        kvCfg = null;
      }
    }

    const resolved =
      resolveTelegramLink(kvCfg?.url) ||
      resolveTelegramLink(env?.DEFAULT_TG_URL || FALLBACK_TG_URL) ||
      resolveTelegramLink(FALLBACK_TG_URL);

    const version = Number(kvCfg?.version) > 0 ? Number(kvCfg.version) : 1;
    const androidIntentMode = normalizeAndroidIntentMode(kvCfg?.android_intent_mode);
    const channelMeta = await getChannelMeta(resolved.url, env, ctx);
    const avatarSrc = channelMeta?.avatarUrl
      ? `/channel-avatar?v=${encodeURIComponent(String(channelMeta.fetchedAt || version))}`
      : "";

    // Request static /index.html cleanly without client conditional headers (avoids 304 without body)
    const assetReq = new Request(new URL("/index.html", request.url), { method: "GET" });
    const assetResp = await env.ASSETS.fetch(assetReq);
    if (!assetResp.ok) {
      return assetResp;
    }

    const rawHtml = await assetResp.text();
    const updatedHtml = rewriteIndexHtml(rawHtml, {
      url: resolved.url,
      deeplink: resolved.deeplink,
      version,
      android_intent_mode: androidIntentMode,
      channelTitle: channelMeta?.title || "",
      channelMembers: channelMeta?.membersText || "",
      avatarSrc,
    });

    const headers = new Headers(assetResp.headers);
    headers.set("Content-Type", "text/html; charset=utf-8");
    headers.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    headers.set("Pragma", "no-cache");
    headers.set("X-Robots-Tag", "noindex, nofollow");
    headers.delete("etag");
    headers.delete("last-modified");
    headers.delete("content-length");

    return new Response(request.method === "HEAD" ? null : updatedHtml, {
      status: 200,
      headers,
    });
  },
};
