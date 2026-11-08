// Run with: node --test proxy/
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { handle } from "./cloudflare-worker.js";

const ORIGIN = "https://serhiimartynenko.github.io";
const realFetch = globalThis.fetch;
let calls;

beforeEach(() => {
  calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { "content-type": "text/event-stream", "set-cookie": "__cf_bm=abc; Path=/" },
    });
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

test("OPTIONS from allowed origin -> 204 with CORS headers", async () => {
  const res = await handle(new Request("https://p.example/api/v1/chat/completions", {
    method: "OPTIONS",
    headers: { Origin: ORIGIN, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type" },
  }), {});
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), ORIGIN);
  assert.equal(res.headers.get("access-control-allow-methods"), "POST, OPTIONS");
  assert.equal(res.headers.get("access-control-allow-headers"), "Authorization, Content-Type");
  assert.equal(res.headers.get("access-control-max-age"), "86400");
  assert.equal(calls.length, 0);
});

test("disallowed origin -> 403", async () => {
  const res = await handle(new Request("https://p.example/api/v1/chat/completions", {
    method: "OPTIONS", headers: { Origin: "https://evil.example" },
  }), {});
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("access-control-allow-origin"), null);
  assert.equal(calls.length, 0);
});

test("ALLOWED_ORIGINS env is honoured", async () => {
  const env = { ALLOWED_ORIGINS: "http://localhost:8000, https://me.example" };
  const ok = await handle(new Request("https://p.example/api/v1/chat/completions", { method: "OPTIONS", headers: { Origin: "https://me.example" } }), env);
  assert.equal(ok.status, 204);
  const no = await handle(new Request("https://p.example/api/v1/chat/completions", { method: "OPTIONS", headers: { Origin: ORIGIN } }), env);
  assert.equal(no.status, 403);
});

test("POST /api/v1/chat/completions is forwarded with Authorization preserved", async () => {
  const res = await handle(new Request("https://p.example/api/v1/chat/completions", {
    method: "POST",
    headers: { Origin: ORIGIN, Authorization: "Bearer sk-or-test", "Content-Type": "application/json", Cookie: "x=1", "X-Title": "nope" },
    body: JSON.stringify({ model: "x-ai/grok-4.7", messages: [] }),
  }), {});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://openrouter.ai/api/v1/chat/completions");
  const h = calls[0].init.headers;
  assert.equal(h.get("authorization"), "Bearer sk-or-test");
  assert.equal(h.get("content-type"), "application/json");
  assert.equal(h.get("cookie"), null);
  assert.equal(h.get("x-title"), null);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), ORIGIN);
  assert.equal(res.headers.get("set-cookie"), null);
  assert.match(await res.text(), /data: \[DONE\]/);
});

test("GET /anything-else -> 404", async () => {
  const res = await handle(new Request("https://p.example/anything-else", { headers: { Origin: ORIGIN } }), {});
  assert.equal(res.status, 404);
  assert.equal(calls.length, 0);
});

test("GET under /api/v1/ -> 405", async () => {
  const res = await handle(new Request("https://p.example/api/v1/models", { headers: { Origin: ORIGIN } }), {});
  assert.equal(res.status, 405);
});
