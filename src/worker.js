/**
 * Cloudflare Worker shell for psy-telegram.
 * Reads the active Telegram link config from LINK_CONFIG_KV on / and /index.html requests,
 * injects url/deeplink/version server-side into index.html, and disables edge/browser caching.
 * All other assets (including track-*.json analytics beacons) pass directly through ASSETS.
 */

const FALLBACK_TG_URL = "https://t.me/+IukZVSEw0io4NGEy";

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

/**
 * Rewrites #action-btn href and #tg-config JSON block inside the shell index.html.
 */
export function rewriteIndexHtml(html, { url, deeplink, version = 1 }) {
  const safeUrlAttr = escapeHtmlAttr(url);
  const safeJson = serializeSafeJsonForScript({
    url,
    deeplink,
    version: Number(version) || 1,
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
  async fetch(request, env) {
    const url = new URL(request.url);
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
    });

    const headers = new Headers(assetResp.headers);
    headers.set("Content-Type", "text/html; charset=utf-8");
    headers.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    headers.set("Pragma", "no-cache");
    headers.delete("etag");
    headers.delete("last-modified");
    headers.delete("content-length");

    return new Response(request.method === "HEAD" ? null : updatedHtml, {
      status: 200,
      headers,
    });
  },
};
