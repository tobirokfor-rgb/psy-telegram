import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import worker, { resolveTelegramLink, rewriteIndexHtml, parseTelegramChannelPreview } from "../src/worker.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const shellHtml = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

function makeAssetsMock({ status = 200, etag = '"static-etag"' } = {}) {
  const receivedRequests = [];
  return {
    receivedRequests,
    async fetch(req) {
      receivedRequests.push(req);
      const u = new URL(req.url);
      if (u.pathname === "/track-copy.json") {
        return new Response('{"status":"ok","event":"copy_link"}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(shellHtml, {
        status,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          ETag: etag,
          "Last-Modified": "Fri, 20 Nov 2026 10:00:00 GMT",
        },
      });
    },
  };
}

test("resolveTelegramLink resolves invite and public channel links and rejects invalid ones", () => {
  assert.deepEqual(resolveTelegramLink("https://t.me/+AbCdEfGh1234"), {
    url: "https://t.me/+AbCdEfGh1234",
    link_type: "invite",
    deeplink: "tg://join?invite=AbCdEfGh1234",
  });
  assert.deepEqual(resolveTelegramLink("t.me/joinchat/AbCdEfGh1234"), {
    url: "https://t.me/+AbCdEfGh1234",
    link_type: "invite",
    deeplink: "tg://join?invite=AbCdEfGh1234",
  });
  assert.deepEqual(resolveTelegramLink("@psy_channel_1"), {
    url: "https://t.me/psy_channel_1",
    link_type: "public",
    deeplink: "tg://resolve?domain=psy_channel_1",
  });
  assert.deepEqual(resolveTelegramLink("https://t.me/psy_channel_1/"), {
    url: "https://t.me/psy_channel_1",
    link_type: "public",
    deeplink: "tg://resolve?domain=psy_channel_1",
  });
  assert.equal(resolveTelegramLink("https://t.me/c/123456789/1"), null);
  assert.equal(resolveTelegramLink("https://t.me/psy_channel/42"), null);
  assert.equal(resolveTelegramLink("https://example.com/psy"), null);
});

test("rewriteIndexHtml replaces #action-btn href and #tg-config safely", () => {
  const out = rewriteIndexHtml(shellHtml, {
    url: "https://t.me/new_channel",
    deeplink: "tg://resolve?domain=new_channel",
    version: 7,
    android_intent_mode: "telegram",
  });
  assert.ok(out.includes('href="https://t.me/new_channel" id="action-btn"'));
  assert.ok(
    out.includes(
      '<script id="tg-config" type="application/json">{"url":"https://t.me/new_channel","deeplink":"tg://resolve?domain=new_channel","version":7,"android_intent_mode":"telegram"}</script>',
    ),
  );
  // Unknown android_intent_mode falls back cleanly to "off"
  const outInvalid = rewriteIndexHtml(shellHtml, {
    url: "https://t.me/new_channel",
    deeplink: "tg://resolve?domain=new_channel",
    version: 7,
    android_intent_mode: "bogus",
  });
  assert.ok(outInvalid.includes('"android_intent_mode":"off"'));
  // Original title, noindex meta, 2300ms iOS timeout, and beacons remain intact
  assert.ok(out.includes('<h1 id="channel-title">Психология себя и людей</h1>'));
  assert.ok(out.includes('<meta name="robots" content="noindex, nofollow">'));
  assert.ok(out.includes("const IOS_FALLBACK_DELAY_MS = 2300;"));
  assert.ok(out.includes("/track-tg-app.json"));
});

test("Worker injects KV link and android_intent_mode on GET /, sets no-store & X-Robots-Tag, and ignores client conditional headers", async () => {
  const assets = makeAssetsMock();
  const env = {
    ASSETS: assets,
    DEFAULT_TG_URL: "https://t.me/+IukZVSEw0io4NGEy",
    LINK_CONFIG_KV: {
      async get(key, type) {
        assert.equal(key, "channel_config");
        assert.equal(type, "json");
        return {
          url: "https://t.me/psy_public_hub",
          version: 4,
          android_intent_mode: "browser",
        };
      },
    },
  };

  const req = new Request("https://psy-telegram.tobirokfor.workers.dev/", {
    method: "GET",
    headers: {
      "If-None-Match": '"static-etag"',
      "If-Modified-Since": "Fri, 20 Nov 2026 10:00:00 GMT",
    },
  });

  const resp = await worker.fetch(req, env);
  assert.equal(resp.status, 200);
  assert.equal(resp.headers.get("Cache-Control"), "no-store, no-cache, must-revalidate, max-age=0");
  assert.equal(resp.headers.get("X-Robots-Tag"), "noindex, nofollow");
  assert.equal(resp.headers.get("etag"), null);
  assert.equal(resp.headers.get("last-modified"), null);

  // Asset fetch did not forward conditional headers from client
  assert.equal(assets.receivedRequests.length, 1);
  assert.equal(assets.receivedRequests[0].headers.get("If-None-Match"), null);

  const html = await resp.text();
  assert.ok(html.includes('href="https://t.me/psy_public_hub" id="action-btn"'));
  assert.ok(html.includes('"deeplink":"tg://resolve?domain=psy_public_hub"'));
  assert.ok(html.includes('"version":4'));
  assert.ok(html.includes('"android_intent_mode":"browser"'));
});

test("public/robots.txt blocks crawler indexing", () => {
  const robotsTxt = fs.readFileSync(path.join(__dirname, "..", "public", "robots.txt"), "utf8");
  assert.ok(robotsTxt.includes("Disallow: /"));
  assert.ok(!robotsTxt.includes("Allow: /"));
});

test("Worker falls back to DEFAULT_TG_URL when KV fails or is empty", async () => {
  const assets = makeAssetsMock();
  const env = {
    ASSETS: assets,
    DEFAULT_TG_URL: "https://t.me/+IukZVSEw0io4NGEy",
    LINK_CONFIG_KV: {
      async get() {
        throw new Error("KV timeout");
      },
    },
  };

  const resp = await worker.fetch(
    new Request("https://psy-telegram.tobirokfor.workers.dev/index.html", { method: "GET" }),
    env,
  );
  assert.equal(resp.status, 200);
  const html = await resp.text();
  assert.ok(html.includes('href="https://t.me/+IukZVSEw0io4NGEy"'));
  assert.ok(html.includes('"deeplink":"tg://join?invite=IukZVSEw0io4NGEy"'));
});

test("Worker handles HEAD / and proxies beacon JSON files straight to ASSETS", async () => {
  const assets = makeAssetsMock();
  const env = {
    ASSETS: assets,
    DEFAULT_TG_URL: "https://t.me/+IukZVSEw0io4NGEy",
    LINK_CONFIG_KV: { async get() { return null; } },
  };

  const headResp = await worker.fetch(
    new Request("https://psy-telegram.tobirokfor.workers.dev/", { method: "HEAD" }),
    env,
  );
  assert.equal(headResp.status, 200);
  assert.equal(await headResp.text(), "");
  assert.equal(headResp.headers.get("Cache-Control"), "no-store, no-cache, must-revalidate, max-age=0");

  const beaconResp = await worker.fetch(
    new Request("https://psy-telegram.tobirokfor.workers.dev/track-copy.json", { method: "GET" }),
    env,
  );
  assert.equal(beaconResp.status, 200);
  assert.deepEqual(await beaconResp.json(), { status: "ok", event: "copy_link" });
});

test("parseTelegramChannelPreview and rewriteIndexHtml inject channel title, members, and avatar safely", () => {
  const tgHtml = `
    <meta property="og:title" content="Скрытая психология &amp; разборы">
    <meta property="og:image" content="https://cdn4.telesco.pe/file/avatar123.jpg">
    <div class="tgme_page_extra">1 243 subscribers</div>
  `;
  const parsed = parseTelegramChannelPreview(tgHtml);
  assert.deepEqual(parsed, {
    title: "Скрытая психология & разборы",
    avatarUrl: "https://cdn4.telesco.pe/file/avatar123.jpg",
    membersText: "1 243 участника",
  });

  const out = rewriteIndexHtml(shellHtml, {
    url: "https://t.me/+AbCdEfGh1234",
    deeplink: "tg://join?invite=AbCdEfGh1234",
    version: 3,
    android_intent_mode: "telegram",
    channelTitle: parsed.title,
    channelMembers: parsed.membersText,
    avatarSrc: "/channel-avatar?v=123",
  });
  assert.ok(out.includes('<h1 id="channel-title">Скрытая психология &amp; разборы</h1>'));
  assert.ok(out.includes('<span id="channel-sub">Закрытый канал · 1 243 участника</span>'));
  assert.ok(out.includes('<img id="channel-avatar" class="tg-avatar-img" src="/channel-avatar?v=123"'));
});

test("Worker injects cached channel meta from KV and returns 404 on /channel-avatar when empty", async () => {
  const assets = makeAssetsMock();
  const env = {
    ASSETS: assets,
    DEFAULT_TG_URL: "https://t.me/+IukZVSEw0io4NGEy",
    LINK_CONFIG_KV: {
      async get(key) {
        if (key === "channel_config") {
          return { url: "https://t.me/psy_public_hub", version: 5, android_intent_mode: "telegram" };
        }
        if (key === "channel_meta_cache") {
          return {
            url: "https://t.me/psy_public_hub",
            title: "Тёмная психология",
            membersText: "612 участников",
            avatarUrl: "",
            fetchedAt: Date.now(),
          };
        }
        return null;
      },
    },
  };

  const resp = await worker.fetch(new Request("https://psy-telegram.tobirokfor.workers.dev/"), env);
  assert.equal(resp.status, 200);
  const html = await resp.text();
  assert.ok(html.includes('<h1 id="channel-title">Тёмная психология</h1>'));
  assert.ok(html.includes('<span id="channel-sub">Закрытый канал · 612 участников</span>'));

  const avatarResp = await worker.fetch(new Request("https://psy-telegram.tobirokfor.workers.dev/channel-avatar"), env);
  assert.equal(avatarResp.status, 404);
});
