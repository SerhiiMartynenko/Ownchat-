import test from "node:test";
import assert from "node:assert/strict";
import { createSSEParser, streamChat, applyReasoning, isAnthropic, validEndpoint, DEFAULT_API_URL, FALLBACK_PROXY_URL, probeEndpoint, probeAll, describeBlocked, errorDetail } from "./api.js";

function sseResponse(chunks, init){
  var enc = new TextEncoder();
  var stream = new ReadableStream({
    start(c){ for(var ch of chunks) c.enqueue(enc.encode(ch)); c.close(); }
  });
  return new Response(stream, Object.assign({ status: 200, headers: { "Content-Type": "text/event-stream" } }, init));
}
function data(obj){ return "data: " + JSON.stringify(obj) + "\n\n"; }
function fakeFetch(handlers){
  var calls = [];
  var f = async function(url, init){
    calls.push({ url, init, body: JSON.parse(init.body) });
    var h = handlers[Math.min(calls.length - 1, handlers.length - 1)];
    return h(url, init);
  };
  f.calls = calls;
  return f;
}
var okStream = () => sseResponse([data({ choices: [{ delta: { content: "ok" } }] }), "data: [DONE]\n\n"]);

test("SSE parser handles chunks split mid-line, comments and [DONE]", () => {
  var got = [];
  var p = createSSEParser(j => got.push(j));
  p.push(": OPENROUTER PROCESSING\n\nda");
  p.push('ta: {"a":1');
  p.push('}\n\ndata: {"a":2}\n');
  p.push("data: [DONE]\n");
  p.push('data: {"a":3}\n');
  p.end();
  assert.deepEqual(got, [{ a: 1 }, { a: 2 }]);
});

test("SSE parser throws on error payloads", () => {
  var p = createSSEParser(() => {});
  assert.throws(() => p.push('data: {"error":{"message":"boom"}}\n'), /boom/);
  var p2 = createSSEParser(() => {});
  assert.throws(() => p2.push('data: {"error":{}}\n'), /API error/);
});

test("streams reasoning_details and content, captures usage, sends exact request", async () => {
  var f = fakeFetch([() => sseResponse([
    data({ choices: [{ delta: { reasoning_details: [{ text: "hm" }, { summary: "m" }] } }] }).slice(0, 20),
    data({ choices: [{ delta: { reasoning_details: [{ text: "hm" }, { summary: "m" }] } }] }).slice(20),
    ": keep-alive\n\n",
    data({ choices: [{ delta: { content: "Hello" } }] }),
    data({ choices: [{ delta: { content: " world" } }] }),
    data({ choices: [], usage: { prompt_tokens: 1234, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 1000 } } }),
    "data: [DONE]\n\n"
  ])]);
  var reasoning = [], content = [], usages = [];
  var r = await streamChat({
    apiKey: "k", endpoint: "", model: "x/y", messages: [{ role: "user", content: "hi" }], thinking: "high",
    fetchImpl: f,
    onReasoning: (d, full) => reasoning.push([d, full]),
    onContent: (d, full) => content.push([d, full]),
    onUsage: u => usages.push(u)
  });
  assert.equal(r.content, "Hello world");
  assert.equal(r.thinking, "hmm");
  assert.deepEqual(reasoning, [["hmm", "hmm"]]);
  assert.deepEqual(content, [["Hello", "Hello"], [" world", "Hello world"]]);
  assert.equal(r.aborted, false);
  assert.equal(r.usedFallback, false);
  assert.equal(r.url, DEFAULT_API_URL);
  assert.equal(typeof r.thinkMs, "number");
  assert.equal(usages.length, 1);
  assert.equal(r.usage.prompt_tokens, 1234);
  assert.equal(r.usage.cached_tokens, 1000);

  assert.equal(f.calls.length, 1);
  var c = f.calls[0];
  assert.equal(c.url, DEFAULT_API_URL);
  assert.deepEqual(c.init.headers, { "Authorization": "Bearer k", "Content-Type": "application/json" });
  assert.equal(c.init.method, "POST");
  assert.equal(c.body.stream, true);
  assert.equal(c.body.stream_options.include_usage, true);
  assert.equal(c.body.model, "x/y");
  assert.deepEqual(c.body.messages, [{ role: "user", content: "hi" }]);
  assert.deepEqual(c.body.reasoning, { effort: "high" });
  assert.equal(c.body.max_tokens, 40000);
});

test("cached_tokens falls back to cache_read_input_tokens, then 0", async () => {
  for(var [u, want] of [[{ prompt_tokens: 5, cache_read_input_tokens: 7 }, 7], [{ prompt_tokens: 5 }, 0]]){
    var f = fakeFetch([() => sseResponse([data({ choices: [], usage: u }), "data: [DONE]\n\n"])]);
    var r = await streamChat({ apiKey: "k", model: "m", messages: [], fetchImpl: f });
    assert.equal(r.usage.cached_tokens, want);
    assert.equal(r.usage.prompt_tokens, 5);
  }
});

test("custom endpoint is trimmed and maxTokens overrides max_tokens", async () => {
  var f = fakeFetch([okStream]);
  var r = await streamChat({ apiKey: "k", endpoint: "  https://x.test/v1/chat  ", model: "anthropic/z", messages: [], thinking: "max", maxTokens: 500, fetchImpl: f });
  assert.equal(f.calls[0].url, "https://x.test/v1/chat");
  assert.equal(f.calls[0].body.max_tokens, 500);
  assert.deepEqual(f.calls[0].body.reasoning, { max_tokens: 32000 });
  assert.equal(r.content, "ok");
  assert.equal(r.thinkMs >= 0, true);
});

test("thinking off sends no reasoning and max_tokens 16000", async () => {
  var f = fakeFetch([okStream]);
  await streamChat({ apiKey: "k", model: "m", messages: [], fetchImpl: f });
  assert.equal(f.calls[0].body.reasoning, undefined);
  assert.equal(f.calls[0].body.max_tokens, 16000);
});

test("reasoning-400 retries once without reasoning", async () => {
  var f = fakeFetch([
    () => new Response(JSON.stringify({ error: { message: "Reasoning is not supported for this model" } }), { status: 400 }),
    okStream
  ]);
  var r = await streamChat({ apiKey: "k", model: "m", messages: [], thinking: "medium", fetchImpl: f });
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[0].body.reasoning, { effort: "medium" });
  assert.equal(f.calls[1].body.reasoning, undefined);
  assert.equal(r.content, "ok");
});

test("other non-OK responses throw the server message", async () => {
  var f = fakeFetch([() => new Response(JSON.stringify({ error: { message: "No credits" } }), { status: 402 })]);
  await assert.rejects(streamChat({ apiKey: "k", model: "m", messages: [], thinking: "high", fetchImpl: f }), /No credits/);
  assert.equal(f.calls.length, 1);
  var f2 = fakeFetch([() => new Response("plain failure", { status: 500 })]);
  await assert.rejects(streamChat({ apiKey: "k", model: "m", messages: [], fetchImpl: f2 }), /plain failure/);
});

test("TypeError falls back to the proxy and reports usedFallback", async () => {
  var f = fakeFetch([() => { throw new TypeError("Failed to fetch"); }, okStream]);
  var r = await streamChat({ apiKey: "k", model: "m", messages: [], fetchImpl: f, fallbackUrl: "https://proxy.test/v1" });
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].url, "https://proxy.test/v1");
  assert.deepEqual(f.calls[1].init.headers, { "Authorization": "Bearer k", "Content-Type": "application/json" });
  assert.equal(r.usedFallback, true);
  assert.equal(r.url, "https://proxy.test/v1");
  assert.equal(r.content, "ok");
});

var PROXY = "https://proxy.test/v1";
var typeErr = () => { throw new TypeError("Failed to fetch"); };
var html403 = () => new Response("<html>blocked</html>", { status: 403, headers: { "Content-Type": "text/html" } });

test("blocked on both direct and proxy throws the descriptive error", async () => {
  var f = fakeFetch([typeErr, html403]);
  var err = await streamChat({ apiKey: "k", model: "m", messages: [], fetchImpl: f, fallbackUrl: PROXY }).then(() => null, e => e);
  assert.equal(f.calls.length, 2);
  assert.equal(err.message,
    "OpenRouter could not be reached from this network. Direct: CORS preflight failed (Failed to fetch). Proxy: refused (403: blocked). Try Settings → Advanced → Test connection, or another network.");
});

test("describeBlocked formats one line", () => {
  assert.equal(describeBlocked([{ label: "Direct", reason: "CORS preflight failed (Preflight response is not successful. Status code: 403)" }, { label: "Proxy", reason: "refused (403)" }]),
    "OpenRouter could not be reached from this network. Direct: CORS preflight failed (Preflight response is not successful. Status code: 403). Proxy: refused (403). Try Settings → Advanced → Test connection, or another network.");
});

test("non-JSON 403 on direct is retried on the proxy", async () => {
  var f = fakeFetch([html403, okStream]);
  var r = await streamChat({ apiKey: "k", model: "m", messages: [], fetchImpl: f, fallbackUrl: PROXY });
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].url, DEFAULT_API_URL);
  assert.equal(f.calls[1].url, PROXY);
  assert.equal(r.usedFallback, true);
  assert.equal(r.url, PROXY);
  assert.equal(r.startUrl, DEFAULT_API_URL);
  assert.equal(r.content, "ok");
});

test("JSON 403 from the API is surfaced, not retried", async () => {
  var f = fakeFetch([() => new Response(JSON.stringify({ error: { message: "flagged" } }), { status: 403 }), okStream]);
  await assert.rejects(streamChat({ apiKey: "k", model: "m", messages: [], fetchImpl: f, fallbackUrl: PROXY }), /flagged/);
  assert.equal(f.calls.length, 1);
});

test("endpoint set to the proxy and proxy blocked: direct is tried", async () => {
  var f = fakeFetch([typeErr, okStream]);
  var r = await streamChat({ apiKey: "k", endpoint: PROXY, model: "m", messages: [], fetchImpl: f, fallbackUrl: PROXY });
  assert.deepEqual(f.calls.map(c => c.url), [PROXY, DEFAULT_API_URL]);
  assert.equal(r.usedFallback, true);
  assert.equal(r.url, DEFAULT_API_URL);
  assert.equal(r.startUrl, PROXY);
});

test("proxy 'Origin not allowed' plain 403 counts as blocked", async () => {
  var f = fakeFetch([() => new Response("Origin not allowed", { status: 403 }), okStream]);
  var r = await streamChat({ apiKey: "k", endpoint: PROXY, model: "m", messages: [], fetchImpl: f, fallbackUrl: PROXY });
  assert.equal(r.url, DEFAULT_API_URL);
  assert.equal(r.usedFallback, true);
});

test("custom endpoint blocked: proxy then direct, in order", async () => {
  var f = fakeFetch([typeErr, typeErr, okStream]);
  var r = await streamChat({ apiKey: "k", endpoint: "https://mine.test/x", model: "m", messages: [], fetchImpl: f, fallbackUrl: PROXY });
  assert.deepEqual(f.calls.map(c => c.url), ["https://mine.test/x", PROXY, DEFAULT_API_URL]);
  assert.equal(r.url, DEFAULT_API_URL);
  assert.equal(r.usedFallback, true);
  f.calls.forEach(c => assert.deepEqual(c.init.headers, { "Authorization": "Bearer k", "Content-Type": "application/json" }));
});

test("all paths blocked lists each with its reason", async () => {
  var f = fakeFetch([html403, typeErr, html403]);
  var err = await streamChat({ apiKey: "k", endpoint: "https://mine.test/x", model: "m", messages: [], fetchImpl: f, fallbackUrl: PROXY }).then(() => null, e => e);
  assert.equal(f.calls.length, 3);
  assert.match(err.message, /Endpoint: refused \(403: blocked\)\. Proxy: CORS preflight failed \(Failed to fetch\)\. Direct: refused \(403: blocked\)\./);
});

test("fallbackUrl null: no retry, message names the direct path", async () => {
  var f = fakeFetch([typeErr, okStream]);
  await assert.rejects(streamChat({ apiKey: "k", model: "m", messages: [], fetchImpl: f, fallbackUrl: null }), /Direct: CORS preflight failed/);
  assert.equal(f.calls.length, 1);
});

test("probeEndpoint classifies responses and sends a minimal request", async () => {
  var cases = [
    [() => new Response(JSON.stringify({ error: { message: "No auth credentials found", code: 401 } }), { status: 401 }), { ok: true, status: 401, reason: "reachable, but the key was rejected" }],
    [() => new Response(JSON.stringify({ error: { message: "model is required" } }), { status: 400 }), { ok: true, status: 400, reason: "reachable" }],
    [html403, { ok: false, status: 403, reason: "refused (403: blocked)" }],
    [typeErr, { ok: false, status: 0, reason: "CORS preflight failed (Failed to fetch)" }],
    [() => new Response("{}", { status: 200 }), { ok: true, status: 200, reason: "reachable" }],
    [() => new Response("bad gateway", { status: 502 }), { ok: false, status: 502, reason: "error 502: bad gateway" }]
  ];
  for(var [h, want] of cases){
    var f = fakeFetch([h]);
    var r = await probeEndpoint({ url: "https://p.test/x", apiKey: "k", fetchImpl: f });
    assert.deepEqual(r, Object.assign({ url: "https://p.test/x" }, want));
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].init.method, "POST");
    assert.deepEqual(f.calls[0].init.headers, { "Authorization": "Bearer k", "Content-Type": "application/json" });
    assert.equal(f.calls[0].init.body, JSON.stringify({ model: "", messages: [] }));
  }
});

test("probeAll probes endpoint, direct and proxy with labels", async () => {
  var f = async (url, init) => {
    if(url === DEFAULT_API_URL) throw new TypeError("Failed to fetch");
    if(url === PROXY) return new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 });
    return new Response("nope", { status: 403 });
  };
  var r = await probeAll({ endpoint: " https://mine.test/x ", apiKey: "k", fetchImpl: f, fallbackUrl: PROXY });
  assert.deepEqual(r.map(x => [x.label, x.url, x.ok, x.reason]), [
    ["Endpoint", "https://mine.test/x", false, "refused (403: nope)"],
    ["Direct", DEFAULT_API_URL, false, "CORS preflight failed (Failed to fetch)"],
    ["Proxy", PROXY, true, "reachable, but the key was rejected"]
  ]);
  var r2 = await probeAll({ endpoint: PROXY, apiKey: "k", fetchImpl: f, fallbackUrl: PROXY });
  assert.deepEqual(r2.map(x => x.label), ["Direct", "Proxy"]);
  var r3 = await probeAll({ endpoint: "", apiKey: "k", fetchImpl: f });
  assert.deepEqual(r3.map(x => [x.label, x.url]), [["Direct", DEFAULT_API_URL], ["Proxy", FALLBACK_PROXY_URL]]);
});

test("abort resolves with aborted:true", async () => {
  var ac = new AbortController(); ac.abort();
  var f = fakeFetch([(url, init) => {
    if(init.signal && init.signal.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    return okStream();
  }]);
  var r = await streamChat({ apiKey: "k", model: "m", messages: [], signal: ac.signal, fetchImpl: f });
  assert.equal(f.calls[0].init.signal, ac.signal);
  assert.equal(r.aborted, true);
  assert.equal(r.usedFallback, false);
  assert.equal(f.calls.length, 1);

  var f2 = fakeFetch([() => { var e = new Error("aborted"); e.name = "AbortError"; throw e; }]);
  var r2 = await streamChat({ apiKey: "k", model: "m", messages: [], fetchImpl: f2 });
  assert.equal(r2.aborted, true);
});

test("applyReasoning: effort for non-anthropic, budget for anthropic", () => {
  var a = {}; applyReasoning(a, "x-ai/some-model", "max");
  assert.deepEqual(a, { max_tokens: 64000, reasoning: { effort: "high" } });
  var b = {}; applyReasoning(b, "anthropic/some-model", "medium");
  assert.deepEqual(b, { max_tokens: 24000, reasoning: { max_tokens: 8000 } });
  assert.equal(isAnthropic("Anthropic/x"), true);
  assert.equal(isAnthropic("openai/x"), false);
  assert.equal(isAnthropic(undefined), false);
});

test("validEndpoint", () => {
  assert.equal(validEndpoint(""), true);
  assert.equal(validEndpoint("https://a.b"), true);
  assert.equal(validEndpoint("http://localhost:8787/x"), true);
  assert.equal(validEndpoint("http://evil.test"), false);
});

test("errorDetail: object error, string error, detail/title", () => {
  assert.equal(errorDetail(402, JSON.stringify({ error: { message: "No credits" } })), "402: No credits");
  assert.equal(errorDetail(403, JSON.stringify({ error: "Forbidden thing" })), "403: Forbidden thing");
  assert.equal(errorDetail(422, JSON.stringify({ detail: "bad field" })), "422: bad field");
  assert.equal(errorDetail(400, JSON.stringify({ title: "Bad", detail: "why" })), "400: why · Bad");
  assert.equal(errorDetail(400, JSON.stringify({ message: "m" })), "400: m");
});
test("errorDetail: metadata provider, raw and code", () => {
  var t = JSON.stringify({ error: { message: "Provider returned error", code: "key_limit", metadata: { provider_name: "Acme", raw: { a: 1 } } } });
  assert.equal(errorDetail(403, t), '403: Provider returned error · provider: Acme · raw: {"a":1} · code: key_limit');
  assert.equal(errorDetail(500, JSON.stringify({ error: { message: "x", metadata: { raw: "text" } } })), "500: x · raw: text");
});
test("errorDetail: unknown JSON, HTML, plain, empty", () => {
  assert.equal(errorDetail(403, '{"foo": 1}'), '403: {"foo":1}');
  assert.equal(errorDetail(403, "<html><head><title>Just a moment</title></head><body><h1>Blocked</h1>  now</body></html>"), "403: Just a moment · Blocked now");
  assert.equal(errorDetail(502, "bad   gateway\n"), "502: bad gateway");
  assert.equal(errorDetail(403, ""), "403: empty response");
  assert.equal(errorDetail(403, "   "), "403: empty response");
});
test("errorDetail: truncates body part to 300 chars", () => {
  var out = errorDetail(500, "x".repeat(500));
  assert.equal(out, "500: " + "x".repeat(300) + "…");
});
test("errorDetail: header suffixes", () => {
  var h = new Headers({ "x-openrouter-error-origin": "client", "cf-mitigated": "challenge" });
  assert.equal(errorDetail(403, JSON.stringify({ error: { message: "Key limit exceeded" } }), h), "403: Key limit exceeded [origin: client] [cf-mitigated: challenge]");
  assert.equal(errorDetail(403, "", { "x-openrouter-error-origin": "client" }), "403: empty response [origin: client]");
  assert.equal(errorDetail(403, "", new Headers()), "403: empty response");
});
test("errorDetail never throws on odd input", () => {
  var bad = { get(){ throw new Error("boom"); } };
  assert.equal(errorDetail(403, "", bad), "403: empty response");
  for(var v of [undefined, null, 5, {}, [], "null", "[]", "123"]) assert.equal(typeof errorDetail(500, v, 7), "string");
  assert.match(errorDetail(500, undefined), /^500: /);
});
test("JSON 403 with string error is surfaced with status, single call", async () => {
  var f = fakeFetch([() => new Response(JSON.stringify({ error: "Key limit exceeded" }), { status: 403 }), okStream]);
  var err = await streamChat({ apiKey: "k", model: "m", messages: [], fetchImpl: f, fallbackUrl: PROXY }).then(() => null, e => e);
  assert.equal(err.message, "Key limit exceeded (HTTP 403)");
  assert.equal(f.calls.length, 1);
});
test("unrecognised error body is shown raw with status", async () => {
  var f = fakeFetch([() => new Response("upstream exploded", { status: 500 })]);
  var err = await streamChat({ apiKey: "k", model: "m", messages: [], fetchImpl: f, fallbackUrl: PROXY }).then(() => null, e => e);
  assert.equal(err.message, "Request failed (HTTP 500: upstream exploded)");
});
test("empty-body 403 via proxy start path is blocked, then reported", async () => {
  var empty403 = () => new Response("", { status: 403 });
  var f = fakeFetch([empty403, empty403]);
  var err = await streamChat({ apiKey: "k", endpoint: PROXY, model: "m", messages: [], fetchImpl: f, fallbackUrl: PROXY }).then(() => null, e => e);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls.map(c => c.url), [PROXY, DEFAULT_API_URL]);
  assert.match(err.message, /Proxy: refused \(403: empty response\)\. Direct: refused \(403: empty response\)\./);
});
test("API error answered by the proxy gets a ' via proxy' suffix", async () => {
  var f = fakeFetch([() => new Response(JSON.stringify({ error: { message: "Key limit exceeded" } }), { status: 403 })]);
  var err = await streamChat({ apiKey: "k", endpoint: PROXY, model: "m", messages: [], fetchImpl: f, fallbackUrl: PROXY }).then(() => null, e => e);
  assert.equal(err.message, "Key limit exceeded (HTTP 403) via proxy");
  var f2 = fakeFetch([() => new Response(JSON.stringify({ error: { message: "Nope" } }), { status: 401 })]);
  var e2 = await streamChat({ apiKey: "k", endpoint: "https://mine.test/x", model: "m", messages: [], fetchImpl: f2, fallbackUrl: PROXY }).then(() => null, e => e);
  assert.equal(e2.message, "Nope (HTTP 401) via endpoint");
});

test("recognised error keeps provider, raw and header detail", async () => {
  var body = JSON.stringify({ error: { message: "Provider returned error", metadata: { provider_name: "Acme", raw: { reason: "x" } } } });
  var f = fakeFetch([() => new Response(body, { status: 403, headers: { "x-openrouter-error-origin": "provider" } })]);
  var err = await streamChat({ apiKey: "k", endpoint: PROXY, model: "m", messages: [], fetchImpl: f, fallbackUrl: PROXY }).then(() => null, e => e);
  assert.equal(err.message, 'Provider returned error · provider: Acme · raw: {"reason":"x"} [origin: provider] (HTTP 403) via proxy');
  var f2 = fakeFetch([() => new Response(JSON.stringify({ error: { message: "No credits" } }), { status: 402 })]);
  var e2 = await streamChat({ apiKey: "k", model: "m", messages: [], fetchImpl: f2, fallbackUrl: PROXY }).then(() => null, e => e);
  assert.equal(e2.message, "No credits (HTTP 402)");
});
