import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import worker, { resolveTelegramLink, rewriteIndexHtml } from "../src/worker.js";

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
  });
  assert.ok(out.includes('href="https://t.me/new_channel" id="action-btn"'));
  assert.ok(
    out.includes(
      '<script id="tg-config" type="application/json">{"url":"https://t.me/new_channel","deeplink":"tg://resolve?domain=new_channel","version":7}</script>',
    ),
  );
  // Original title and beacons remain intact
  assert.ok(out.includes("<h1>Психология себя и людей</h1>"));
  assert.ok(out.includes("/track-tg-app.json"));
});

test("Worker injects KV link on GET /, sets no-store, strips ETag, and ignores client conditional headers", async () => {
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
  assert.equal(resp.headers.get("etag"), null);
  assert.equal(resp.headers.get("last-modified"), null);

  // Asset fetch did not forward conditional headers from client
  assert.equal(assets.receivedRequests.length, 1);
  assert.equal(assets.receivedRequests[0].headers.get("If-None-Match"), null);

  const html = await resp.text();
  assert.ok(html.includes('href="https://t.me/psy_public_hub" id="action-btn"'));
  assert.ok(html.includes('"deeplink":"tg://resolve?domain=psy_public_hub"'));
  assert.ok(html.includes('"version":4'));
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
