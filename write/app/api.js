/* Streaming chat client for OpenRouter-style (OpenAI-compatible SSE) endpoints. DOM-free. */

export var DEFAULT_API_URL = "https://openrouter.ai/api/v1/chat/completions";
// Personal proxy (proxy/cloudflare-worker.js) used automatically when the browser's direct
// request to OpenRouter is blocked before it gets a response (e.g. by Cloudflare bot protection).
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

function blockedMessage(usedFallback, e){
  return "Request was blocked before it reached OpenRouter (CORS preflight failed)" + (usedFallback ? ", and the proxy could not be reached either" : "") + ". Try another network, or set a proxy endpoint in Settings → Advanced. (" + (e.message || String(e)) + ")";
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

  var result = { content: "", thinking: "", thinkMs: 0, aborted: false, usage: null, usedFallback: false, url: (opts.endpoint && opts.endpoint.trim()) || DEFAULT_API_URL };
  var firstContentAt = null;
  var retried = false;

  function post(){
    return fetchImpl(result.url, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + opts.apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: signal
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
        var m = "Request failed (" + res.status + ").";
        try{ var j = JSON.parse(t); m = (j.error && j.error.message) || j.message || m; }
        catch(e){ if(t) m = t.slice(0, 300); }
        // Some models reject the reasoning parameter; nothing has streamed yet, so retry once without it.
        if(res.status === 400 && body.reasoning && !retried && /reason|effort|unsupported|not supported/i.test(m + " " + t)){
          retried = true;
          delete body.reasoning;
          return post().then(handle);
        }
        throw new Error(m);
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

  function blocked(e){ return e instanceof TypeError && !(signal && signal.aborted); }

  return Promise.resolve().then(post).then(handle).catch(function(e){
    // Direct call never got a response: retry once through the fallback proxy. Nothing has streamed yet.
    if(blocked(e) && fallbackUrl && result.url !== fallbackUrl){
      result.url = fallbackUrl; result.usedFallback = true;
      return post().then(handle);
    }
    throw e;
  }).catch(function(e){
    if(e && e.name === "AbortError"){ result.aborted = true; return; }
    if(blocked(e)) throw new Error(blockedMessage(result.usedFallback, e));
    throw e;
  }).then(function(){
    if(!result.thinkMs && result.thinking) result.thinkMs = Date.now() - started;
    return result;
  });
}
