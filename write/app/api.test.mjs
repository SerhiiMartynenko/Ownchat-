import test from "node:test";
import assert from "node:assert/strict";
import { createSSEParser, streamChat, applyReasoning, isAnthropic, validEndpoint, DEFAULT_API_URL } from "./api.js";

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

test("blocked on both direct and proxy throws the descriptive error", async () => {
  var f = fakeFetch([() => { throw new TypeError("Failed to fetch"); }]);
  await assert.rejects(
    streamChat({ apiKey: "k", model: "m", messages: [], fetchImpl: f, fallbackUrl: "https://proxy.test/v1" }),
    /blocked before it reached OpenRouter \(CORS preflight failed\), and the proxy could not be reached either/
  );
  assert.equal(f.calls.length, 2);
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
