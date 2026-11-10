/* Streaming chat client for OpenRouter-style (OpenAI-compatible SSE) endpoints. DOM-free. */

export var DEFAULT_API_URL = "https://openrouter.ai/api/v1/chat/completions";
// Personal proxy (proxy/cloudflare-worker.js). streamChat switches between it and direct OpenRouter
// automatically when one path is blocked (no response / CORS preflight refused, or a non-API 403).
export var FALLBACK_PROXY_URL = "https://ownchat-proxy.ownchat-serhii.workers.dev/api/v1/chat/completions";

export function isAnthropic(model){ return /^anthropic\//i.test(model || ""); }

// thinking -> reasoning budget + overall output cap. max_tokens must exceed the reasoning budget.
export function reasoningConfig(level){
  if(level==="off")    return null;
  if(level==="medium") return { budget:8000,  max:24000 };
  if(level==="high")   return { budget:16000, max:40000 };
  return { budget:32000, max:64000 };
}
// Anthropic models take a token budget; others take an effort level.
export function applyReasoning(body, model, level){
  var rc = reasoningConfig(level);
  if(!rc){ body.max_tokens = 16000; return; }
  body.max_tokens = rc.max;
  if(isAnthropic(model)) body.reasoning = { max_tokens: rc.budget };
  else body.reasoning = { effort: level === "medium" ? "medium" : "high" };
}
export function validEndpoint(u){ return !u || /^https:\/\//i.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(u); }

// Line-buffered SSE parser. Calls onJson(parsed) for every "data:" JSON payload until "[DONE]".
export function createSSEParser(onJson){
  var buf = "";
  var done = false;
  function line(raw){
    if(done) return;
    var s = raw.trim();
    if(!s || s.charAt(0) === ":") return;           // blank / SSE keep-alive comment
    if(s.slice(0,5) !== "data:") return;
    var data = s.slice(5).trim();
    if(data === "[DONE]"){ done = true; return; }
    var j; try{ j = JSON.parse(data); }catch(e){ return; }
    if(j && j.error) throw new Error((j.error && j.error.message) || "API error");
    onJson(j);
  }
  return {
    push: function(text){
      buf += text;
      var nl;
      while((nl = buf.indexOf("\n")) !== -1){
        var l = buf.slice(0, nl); buf = buf.slice(nl + 1);
        line(l);
      }
    },
    end: function(){ var l = buf; buf = ""; if(l) line(l); }
  };
}

// Reads a response body as JSON; returns the parsed object only if it carries an error/message field.
function apiJson(text){
  try{ var j = JSON.parse(text); }catch(e){ return null; }
  return (j && typeof j === "object" && (j.error || j.message)) ? j : null;
}
function cut(s, n){ return s.length > n ? s.slice(0, n) + "…" : s; }
function readHeader(headers, name){
  try{
    if(!headers) return "";
    var v = typeof headers.get === "function" ? headers.get(name) : headers[name];
    return (typeof v === "string" || typeof v === "number") ? String(v).trim() : "";
  }catch(e){ return ""; }
}

// One-line, human-readable description of a non-OK response: "<status>: <what the server said>".
export function errorDetail(status, text, headers){
  var detail = "";
  try{
    var t = typeof text === "string" ? text : (text == null ? "" : String(text));
    var j = null;
    try{ j = JSON.parse(t); }catch(e){ j = null; }
    if(j && typeof j === "object"){
      var parts = [];
      var err = j.error;
      var eo = err && typeof err === "object" ? err : null;
      function add(v){ if(typeof v === "string" && v.trim()) parts.push(v.trim()); }
      if(eo) add(eo.message);
      else add(err);
      add(j.message); add(j.detail); add(j.title);
      var md = eo && eo.metadata && typeof eo.metadata === "object" ? eo.metadata : null;
      if(md){
        if(typeof md.provider_name === "string" && md.provider_name) parts.push("provider: " + md.provider_name);
        if(md.raw != null && md.raw !== ""){
          var raw = typeof md.raw === "string" ? md.raw : JSON.stringify(md.raw);
          if(raw) parts.push("raw: " + raw);
        }
      }
      if(eo){
        if(typeof eo.code === "string" && eo.code) parts.push("code: " + eo.code);
        if(typeof eo.type === "string" && eo.type) parts.push("type: " + eo.type);
      }
      detail = parts.length ? parts.join(" · ") : JSON.stringify(j);
    }else{
      var title = "";
      if(/<\s*(html|!doctype|head|body|title)/i.test(t)){
        var tm = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(t);
        if(tm) title = tm[1].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
        t = t.replace(/<title[^>]*>[\s\S]*?<\/title>/i, " ").replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, " ");
      }
      var body = t.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
      detail = title && body ? title + " · " + body : (title || body);
    }
    detail = detail ? cut(detail.replace(/\s+/g, " "), 300) : "empty response";
  }catch(e){ detail = "empty response"; }
  var out = status + ": " + detail;
  var origin = readHeader(headers, "x-openrouter-error-origin");
  if(origin) out += " [origin: " + origin + "]";
  var cf = readHeader(headers, "cf-mitigated");
  if(cf) out += " [cf-mitigated: " + cf + "]";
  return out;
}
function isAbort(e, signal){ return (e && e.name === "AbortError") || !!(signal && signal.aborted); }

// Path label for messages: "Direct" for OpenRouter, "Proxy" for the fallback worker, else "Endpoint".
export function pathLabel(url, fallbackUrl){
  if(url === DEFAULT_API_URL) return "Direct";
  if(url === (fallbackUrl === undefined ? FALLBACK_PROXY_URL : fallbackUrl)) return "Proxy";
  return "Endpoint";
}
function preflightReason(e){ return "CORS preflight failed (" + ((e && e.message) || String(e)) + ")"; }

// attempts: [{label, reason}] -> one-line message shown when every path was blocked.
export function describeBlocked(attempts){
  return "OpenRouter could not be reached from this network. " +
    attempts.map(function(a){ return a.label + ": " + a.reason + "."; }).join(" ") +
    " Try Settings → Advanced → Test connection, or another network.";
}

// Order of paths to try: the configured one first, then the alternates.
export function candidatePaths(endpoint, fallbackUrl){
  var start = (endpoint || "").trim() || DEFAULT_API_URL;
  var alts;
  if(start === DEFAULT_API_URL) alts = [fallbackUrl];
  else if(start === fallbackUrl) alts = [DEFAULT_API_URL];
  else alts = [fallbackUrl, DEFAULT_API_URL];
  var out = [start];
  alts.forEach(function(u){ if(u && out.indexOf(u) === -1) out.push(u); });
  return out;
}

function BlockedError(reason, cause){
  var e = new Error(reason); e.blocked = true; e.reason = reason; e.cause = cause; return e;
}

// Cheap reachability check: an empty model is rejected by OpenRouter before any generation,
// but the request goes through the same CORS preflight as a real message.
export function probeEndpoint(o){
  o = o || {};
  var fetchImpl = o.fetchImpl || globalThis.fetch;
  var url = o.url;
  return Promise.resolve().then(function(){
    return fetchImpl(url, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + (o.apiKey || ""),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ model: "", messages: [] }),
      signal: o.signal
    });
  }).then(function(res){
    return res.text().catch(function(){ return ""; }).then(function(t){
      var status = res.status;
      if(apiJson(t) || res.ok){
        return { url: url, ok: true, status: status, reason: status === 401 ? "reachable, but the key was rejected" : "reachable" };
      }
      var d = errorDetail(status, t, res.headers);
      if(status === 403) return { url: url, ok: false, status: 403, reason: "refused (" + d + ")" };
      return { url: url, ok: false, status: status, reason: "error " + d };
    });
  }, function(e){
    if(e && e.name === "AbortError") return { url: url, ok: false, status: 0, reason: "cancelled" };
    if(e instanceof TypeError) return { url: url, ok: false, status: 0, reason: preflightReason(e) };
    return { url: url, ok: false, status: 0, reason: (e && e.message) || String(e) };
  });
}

// Probes the custom endpoint (if any), direct OpenRouter and the proxy in parallel.
export function probeAll(o){
  o = o || {};
  var fallbackUrl = o.fallbackUrl === undefined ? FALLBACK_PROXY_URL : o.fallbackUrl;
  var ep = (o.endpoint || "").trim();
  var list = [];
  if(ep && ep !== DEFAULT_API_URL && ep !== fallbackUrl) list.push({ label: "Endpoint", url: ep });
  list.push({ label: "Direct", url: DEFAULT_API_URL });
  if(fallbackUrl) list.push({ label: "Proxy", url: fallbackUrl });
  return Promise.all(list.map(function(p){
    return probeEndpoint({ url: p.url, apiKey: o.apiKey, fetchImpl: o.fetchImpl, signal: o.signal }).then(function(r){
      return { label: p.label, url: p.url, ok: r.ok, status: r.status, reason: r.reason };
    });
  }));
}

export function streamChat(opts){
  opts = opts || {};
  var fetchImpl = opts.fetchImpl || globalThis.fetch;
  var fallbackUrl = opts.fallbackUrl === undefined ? FALLBACK_PROXY_URL : opts.fallbackUrl;
  var signal = opts.signal;
  var model = opts.model;
  var started = Date.now();

  var body = { model: model, messages: opts.messages, stream: true, stream_options: { include_usage: true } };
  applyReasoning(body, model, opts.thinking || "off");
  if(typeof opts.maxTokens === "number") body.max_tokens = opts.maxTokens;

  var paths = candidatePaths(opts.endpoint, fallbackUrl);
  var result = { content: "", thinking: "", thinkMs: 0, aborted: false, usage: null, usedFallback: false, url: paths[0], startUrl: paths[0] };
  var firstContentAt = null;
  var retried = false;

  function post(){
    return Promise.resolve().then(function(){ return fetchImpl(result.url, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + opts.apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: signal
    }); }).catch(function(e){
      // No response at all (CORS preflight refused, network block): this path is blocked.
      if(e instanceof TypeError && !isAbort(e, signal)) throw BlockedError(preflightReason(e), e);
      throw e;
    });
  }

  function onJson(j){
    if(j.usage && typeof j.usage === "object"){
      var u = j.usage;
      var ptd = u.prompt_tokens_details;
      u.cached_tokens = (ptd && ptd.cached_tokens != null) ? ptd.cached_tokens : (u.cache_read_input_tokens != null ? u.cache_read_input_tokens : 0);
      result.usage = u;
      if(opts.onUsage) opts.onUsage(u);
    }
    var d = (j.choices && j.choices[0] && j.choices[0].delta) || {};
    var r2 = "";
    if(typeof d.reasoning === "string") r2 = d.reasoning;
    else if(Array.isArray(d.reasoning_details)){
      r2 = d.reasoning_details.map(function(x){ return x.text || x.summary || x.content || ""; }).join("");
    }
    if(r2){
      result.thinking += r2;
      if(opts.onReasoning) opts.onReasoning(r2, result.thinking);
    }
    if(typeof d.content === "string" && d.content){
      if(firstContentAt === null){
        firstContentAt = Date.now();
        result.thinkMs = firstContentAt - started;
      }
      result.content += d.content;
      if(opts.onContent) opts.onContent(d.content, result.content, { thinkMs: result.thinkMs });
    }
  }

  function handle(res){
    if(!res.ok){
      return res.text().then(function(t){
        var aj = apiJson(t);
        var detail = errorDetail(res.status, t, res.headers);
        // A 403 that is not the API's own JSON error is a block page (WAF, proxy origin check): try another path.
        if(res.status === 403 && !aj) throw BlockedError("refused (" + detail + ")");
        var m = "";
        try{
          var j = JSON.parse(t);
          if(j && typeof j === "object"){
            var e0 = j.error;
            m = (e0 && typeof e0 === "object" && typeof e0.message === "string" && e0.message) ||
              (typeof e0 === "string" && e0) || (typeof j.message === "string" && j.message) || "";
          }
        }catch(e){ m = ""; }
        // Some models reject the reasoning parameter; nothing has streamed yet, so retry once without it.
        if(res.status === 400 && body.reasoning && !retried && /reason|effort|unsupported|not supported/i.test(m + " " + t)){
          retried = true;
          delete body.reasoning;
          return post().then(handle);
        }
        var lbl = pathLabel(result.url, fallbackUrl);
        var via = lbl === "Direct" ? "" : " via " + lbl.toLowerCase();
        throw new Error((m ? detail.slice(String(res.status).length + 2) + " (HTTP " + res.status + ")" : "Request failed (HTTP " + detail + ")") + via);
      });
    }
    if(!res.body) throw new Error("No response stream from server.");
    var reader = res.body.getReader();
    var dec = new TextDecoder();
    var parser = createSSEParser(onJson);
    function pump(){
      return reader.read().then(function(r){
        if(r.done){ parser.push(dec.decode()); parser.end(); return; }
        parser.push(dec.decode(r.value, { stream: true }));
        return pump();
      });
    }
    return pump();
  }

  var attempts = [];
  function attempt(i){
    result.url = paths[i];
    return Promise.resolve().then(post).then(handle).catch(function(e){
      if(!(e && e.blocked) || isAbort(e, signal)) throw e;
      // Nothing has streamed yet (the failure came before the body was read), so another path is safe.
      attempts.push({ label: pathLabel(paths[i], fallbackUrl), reason: e.reason });
      if(i + 1 < paths.length) return attempt(i + 1);
      throw new Error(describeBlocked(attempts));
    });
  }

  return attempt(0).then(function(){
    result.usedFallback = result.url !== result.startUrl;
  }, function(e){
    if(isAbort(e, signal)){ result.aborted = true; return; }
    throw e;
  }).then(function(){
    if(!result.thinkMs && result.thinking) result.thinkMs = Date.now() - started;
    return result;
  });
}
