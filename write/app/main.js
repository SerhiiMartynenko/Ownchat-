(function(){
  /* ===== Constants ===== */
  var DEFAULT_API_URL = "https://openrouter.ai/api/v1/chat/completions";
  // Personal proxy (proxy/cloudflare-worker.js) used automatically when the browser's direct
  // request to OpenRouter is blocked before it gets a response (e.g. by Cloudflare bot protection).
  var FALLBACK_PROXY_URL = "https://ownchat-proxy.ownchat-serhii.workers.dev/api/v1/chat/completions";
  var LS_SET = "ownchat.write.settings.v1";
  var LS_HIST = "ownchat.write.history.v1";
  var LEGACY_LS_SET = "orchat.settings.v1";
  var LEGACY_LS_HIST = "orchat.history.v1";

  var ICON = {
    copy:'<svg class="ic" viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
    dl:'<svg class="ic" viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>',
    read:'<svg class="ic" viewBox="0 0 24 24"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>',
    retry:'<svg class="ic" viewBox="0 0 24 24"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
    file:'<svg class="ic" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
    close:'<svg class="ic" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    chev:'<svg class="ic chev" viewBox="0 0 24 24" style="width:14px;height:14px"><path d="M6 9l6 6 6-6"/></svg>',
    arrow:'<svg class="ic" viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
    stop:'<svg class="ic" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>'
  };
  var MODEL_PRESETS = ["x-ai/grok-4.7","x-ai/grok-4.5","anthropic/claude-opus-4.8","anthropic/claude-opus-4.8-fast","anthropic/claude-sonnet-4.6","anthropic/claude-haiku-4.5"];
  var STARTERS = [
    "Write the first chapter of a short story about a lighthouse keeper.",
    "Explain how SSH key authentication works, simply.",
    "Draft a markdown cheat-sheet I can export."
  ];

  /* ===== State ===== */
  var settings = { apiKey:"", model:"x-ai/grok-4.7", thinking:"max", system:"", endpoint:"" };
  var messages = [];
  var attachments = [];
  var isStreaming = false;
  var currentAbort = null;
  var stick = true;
  var pendingThink = "max";

  /* ===== Elements ===== */
  function $(id){ return document.getElementById(id); }
  var app=$("app"), scroller=$("scroll"), list=$("list"), empty=$("empty"), fab=$("fab");
  var input=$("input"), sendBtn=$("send"), attachBtn=$("attachBtn"), fileInput=$("fileInput");
  var attachWrap=$("attachWrap"), pillText=$("pillText");
  var settingsOverlay=$("settingsOverlay"), setKey=$("setKey"), setModel=$("setModel"),
      setSystem=$("setSystem"), setEndpoint=$("setEndpoint"), thinkSeg=$("thinkSeg"), toastEl=$("toast");
  var reader=$("reader"), readerBody=$("readerBody"), readerTitle=$("readerTitle");
  var currentReaderMd = "";

  /* ===== Utilities ===== */
  function uid(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,7); }
  function escapeHtml(s){ return String(s).replace(/[&<>"']/g,function(c){
    return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; }); }
  function fmtBytes(n){ if(n<1024) return n+" B"; if(n<1048576) return (n/1024).toFixed(1)+" KB"; return (n/1048576).toFixed(1)+" MB"; }
  function fmtDur(ms){ var s=ms/1000; if(s<60) return s.toFixed(1)+"s"; var m=Math.floor(s/60); return m+"m "+Math.round(s%60)+"s"; }

  function toast(msg){
    toastEl.textContent = msg; toastEl.classList.add("show");
    clearTimeout(toast._t); toast._t = setTimeout(function(){ toastEl.classList.remove("show"); }, 1900);
  }
  function copyText(t){
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(t).then(function(){ toast("Copied"); }, fallback);
    } else { fallback(); }
    function fallback(){
      var ta=document.createElement("textarea"); ta.value=t;
      ta.style.position="fixed"; ta.style.opacity="0"; document.body.appendChild(ta);
      ta.focus(); ta.select();
      try{ document.execCommand("copy"); toast("Copied"); }catch(e){ toast("Copy failed"); }
      ta.remove();
    }
  }
  function shortModel(m){ var p=m.split("/").pop()||m; return p.replace(/^claude-/,"").replace(/-/g," "); }
  function thinkLabel(t){ return t==="off"?"no thinking":t==="medium"?"med-think":t==="high"?"high-think":"max-think"; }
  function updatePill(){ pillText.textContent = shortModel(settings.model)+" · "+thinkLabel(settings.thinking); }

  // thinking -> reasoning budget + overall output cap. max_tokens must exceed the reasoning budget.
  function reasoningConfig(level){
    if(level==="off")    return null;
    if(level==="medium") return { budget:8000,  max:24000 };
    if(level==="high")   return { budget:16000, max:40000 };
    return { budget:32000, max:64000 };
  }
  // Anthropic models take a token budget; others (Grok, OpenAI, ...) take an effort level.
  function applyReasoning(body, model, level){
    var rc = reasoningConfig(level);
    if(!rc){ body.max_tokens = 16000; return; }
    body.max_tokens = rc.max;
    if(/^anthropic\//i.test(model || "")) body.reasoning = { max_tokens: rc.budget };
    else body.reasoning = { effort: level === "medium" ? "medium" : "high" };
  }
  function apiUrl(){ return (settings.endpoint && settings.endpoint.trim()) || DEFAULT_API_URL; }
  function validEndpoint(u){ return !u || /^https:\/\//i.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(u); }

  /* ===== Markdown ===== */
  if(window.marked && marked.setOptions){ marked.setOptions({ gfm:true, breaks:true }); }
  function renderMarkdown(text){
    var html;
    try{ html = (window.marked) ? marked.parse(text) : escapeHtml(text).replace(/\n/g,"<br>"); }
    catch(e){ html = escapeHtml(text).replace(/\n/g,"<br>"); }
    if(window.DOMPurify){ html = DOMPurify.sanitize(html, { ADD_ATTR:["target","rel"] }); }
    return html;
  }
  function enhanceContent(container){
    container.querySelectorAll("a[href]").forEach(function(a){ a.target="_blank"; a.rel="noopener noreferrer"; });
    container.querySelectorAll("pre").forEach(function(pre){
      if(pre.parentElement && pre.parentElement.classList.contains("codeblock")) return;
      var wrap=document.createElement("div"); wrap.className="codeblock";
      pre.parentNode.insertBefore(wrap, pre); wrap.appendChild(pre);
      var btn=document.createElement("button"); btn.className="copy-code"; btn.type="button"; btn.textContent="Copy";
      btn.addEventListener("click", function(){
        copyText(pre.innerText); btn.textContent="Copied";
        setTimeout(function(){ btn.textContent="Copy"; }, 1200);
      });
      wrap.appendChild(btn);
    });
  }
  function firstHeading(content){
    var m = content.match(/^\s*#{1,6}\s+(.+)$/m);
    if(m) return m[1].trim();
    var line = (content.trim().split("\n").find(function(l){ return l.trim(); }) || "").trim();
    return line.replace(/[#*_>`\-]/g,"").slice(0,60) || "Document";
  }
  function slugFilename(content){
    var slug = firstHeading(content).toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,60) || "ownchat-note";
    var d=new Date();
    var stamp = d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
    return slug+"-"+stamp+".md";
  }

  /* ===== Export (iOS share sheet -> Save to Files, with download fallback) ===== */
  function exportMarkdown(text, filename){
    var blob = new Blob([text], { type:"text/markdown" });
    try{
      var file = new File([blob], filename, { type:"text/markdown" });
      if(navigator.canShare && navigator.canShare({ files:[file] }) && navigator.share){
        // Share ONLY the file. Passing title/text makes some targets save a second .txt of that text.
        navigator.share({ files:[file] }).then(function(){}, function(err){
          if(err && err.name==="AbortError") return;
          anchorDownload(blob, filename);
        });
        return;
      }
    }catch(e){ /* File ctor or share unsupported -> fallback */ }
    anchorDownload(blob, filename);
  }
  function anchorDownload(blob, filename){
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = filename; a.rel = "noopener";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function(){ URL.revokeObjectURL(url); }, 1500);
    toast("Exported " + filename);
  }

  /* ===== Message DOM ===== */
  function buildUser(msg){
    var node = document.createElement("div");
    node.className = "msg user";
    var bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = msg.display || "";
    node.appendChild(bubble);
    // Support multiple attachments; fall back to the legacy single `attachment` on old history.
    var atts = msg.attachments || (msg.attachment ? [msg.attachment] : []);
    atts.forEach(function(att){
      if(!att || !att.name) return;
      var chip = document.createElement("div");
      chip.className = "file-chip";
      chip.innerHTML = ICON.file + "<span></span>";
      chip.querySelector("span").textContent = att.name;
      node.appendChild(chip);
    });
    var actions = document.createElement("div");
    actions.className = "msg-actions";
    var copy = document.createElement("button");
    copy.className = "act"; copy.type = "button";
    copy.innerHTML = ICON.copy + "<span>Copy</span>";
    copy.addEventListener("click", function(){ copyText(msg.display || ""); });
    actions.appendChild(copy);
    node.appendChild(actions);
    list.appendChild(node);
    return node;
  }

  function buildAssistant(){
    var node = document.createElement("div");
    node.className = "msg assistant";
    node.innerHTML =
      '<div class="bubble-a">' +
        '<div class="msg-think" hidden>' +
          '<button class="think-toggle" type="button">' +
            '<span class="dot"></span>' +
            '<span class="think-label">Thinking…</span>' +
            '<span class="think-time"></span>' +
            ICON.chev +
          '</button>' +
          '<div class="think-body-wrap"><div class="think-body"></div></div>' +
        '</div>' +
        '<div class="msg-content markdown"></div>' +
        '<span class="caret" hidden></span>' +
      '</div>' +
      '<div class="msg-actions" hidden></div>';
    var els = {
      node: node,
      think: node.querySelector(".msg-think"),
      thinkToggle: node.querySelector(".think-toggle"),
      thinkLabel: node.querySelector(".think-label"),
      thinkTime: node.querySelector(".think-time"),
      thinkBody: node.querySelector(".think-body"),
      content: node.querySelector(".msg-content"),
      caret: node.querySelector(".caret"),
      actions: node.querySelector(".msg-actions"),
      _raf: null, _timer: null, _pendingContent: null, _pendingThink: null
    };
    els.thinkToggle.addEventListener("click", function(){ els.think.classList.toggle("open"); });
    list.appendChild(node);
    return els;
  }

  function scheduleRender(els){
    if(els._raf) return;
    els._raf = requestAnimationFrame(function(){
      els._raf = null;
      if(els._pendingThink !== null){
        els.thinkBody.textContent = els._pendingThink;
        els.thinkBody.scrollTop = els.thinkBody.scrollHeight;
        els._pendingThink = null;
      }
      if(els._pendingContent !== null){
        els.content.innerHTML = renderMarkdown(els._pendingContent);
        els._pendingContent = null;
      }
      if(stick) scrollBottom();
    });
  }

  function bindAssistantActions(els, msg){
    els.actions.innerHTML =
      '<button class="act" data-a="copy" type="button">'  + ICON.copy + '<span>Copy</span></button>' +
      '<button class="act" data-a="export" type="button">'+ ICON.dl   + '<span>Export</span></button>' +
      '<button class="act" data-a="read" type="button">'  + ICON.read + '<span>Read</span></button>';
    els.actions.querySelector('[data-a=copy]').addEventListener("click", function(){ copyText(msg.content); });
    els.actions.querySelector('[data-a=export]').addEventListener("click", function(){ exportMarkdown(msg.content, slugFilename(msg.content)); });
    els.actions.querySelector('[data-a=read]').addEventListener("click", function(){ openReader(msg.content, firstHeading(msg.content)); });
    els.actions.hidden = false;
  }

  function finalizeAssistant(els, state){
    if(els._raf){ cancelAnimationFrame(els._raf); els._raf = null; }
    if(els._timer){ clearInterval(els._timer); els._timer = null; }
    els.caret.hidden = true;
    els.content.classList.remove("streaming");
    if(state.content){
      els.content.innerHTML = renderMarkdown(state.content);
      enhanceContent(els.content);
    } else {
      els.content.innerHTML = '<span class="muted">' + (state.aborted ? "(stopped)" : "(no output)") + '</span>';
    }
    if(state.thinking){
      els.think.hidden = false;
      els.thinkBody.textContent = state.thinking;
      els.think.classList.remove("thinking","open");
      els.thinkLabel.textContent = "Thought for " + fmtDur(state.thinkMs || 0);
      els.thinkTime.textContent = "";
    } else {
      els.think.hidden = true;
    }
  }

  function finalizeError(els, msg, node){
    if(els._raf){ cancelAnimationFrame(els._raf); els._raf = null; }
    if(els._timer){ clearInterval(els._timer); els._timer = null; }
    els.caret.hidden = true;
    els.content.classList.remove("streaming");
    els.think.hidden = !els.thinkBody.textContent;
    if(els.think.classList.contains("thinking")) els.think.classList.remove("thinking","open");
    els.content.innerHTML = '<div class="err"><strong>Could not get a response.</strong><br>' + escapeHtml(msg) + '</div>';
    els.actions.innerHTML = '<button class="act" data-a="retry" type="button">' + ICON.retry + '<span>Retry</span></button>';
    els.actions.hidden = false;
    els.actions.querySelector('[data-a=retry]').addEventListener("click", function(){
      node.remove(); runAssistantTurn();
    });
  }

  /* ===== Streaming (OpenRouter, OpenAI-compatible SSE) ===== */
  function streamCompletion(api, els, state){
    var started = Date.now();
    var controller = new AbortController();
    currentAbort = controller;
    var body = { model: settings.model, messages: api, stream: true };
    applyReasoning(body, settings.model, settings.thinking);

    var firstContentAt = null;
    function startTimer(){
      if(els._timer) return;
      els.think.hidden = false;
      els.think.classList.add("thinking","open");
      els.thinkLabel.textContent = "Thinking…";
      els._timer = setInterval(function(){ els.thinkTime.textContent = fmtDur(Date.now() - started); }, 100);
    }

    var url = apiUrl();
    var retried = false;
    var usedFallback = false;
    function post(){
      return fetch(url, {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + settings.apiKey,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
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
      var buf = "";

      function pump(){
        return reader.read().then(function(r){
          if(r.done) return;
          buf += dec.decode(r.value, { stream: true });
          var nl;
          while((nl = buf.indexOf("\n")) !== -1){
            var line = buf.slice(0, nl); buf = buf.slice(nl + 1);
            var s = line.trim();
            if(!s || s.charAt(0) === ":") continue;        // blank / SSE keep-alive comment
            if(s.slice(0,5) !== "data:") continue;
            var data = s.slice(5).trim();
            if(data === "[DONE]"){ buf = ""; continue; }
            var j; try{ j = JSON.parse(data); }catch(e){ continue; }
            if(j.error) throw new Error((j.error && j.error.message) || "Stream error.");
            var d = (j.choices && j.choices[0] && j.choices[0].delta) || {};
            var r2 = "";
            if(typeof d.reasoning === "string") r2 = d.reasoning;
            else if(Array.isArray(d.reasoning_details)){
              r2 = d.reasoning_details.map(function(x){ return x.text || x.summary || x.content || ""; }).join("");
            }
            if(r2){
              if(!els._timer) startTimer();
              state.thinking += r2;
              els._pendingThink = state.thinking;
              scheduleRender(els);
            }
            if(typeof d.content === "string" && d.content){
              if(firstContentAt === null){
                firstContentAt = Date.now();
                state.thinkMs = firstContentAt - started;
                if(els._timer){ clearInterval(els._timer); els._timer = null; }
                if(state.thinking){
                  els.think.classList.remove("thinking","open");
                  els.thinkLabel.textContent = "Thought for " + fmtDur(state.thinkMs);
                  els.thinkTime.textContent = "";
                }
              }
              state.content += d.content;
              els._pendingContent = state.content;
              scheduleRender(els);
            }
          }
          return pump();
        });
      }
      return pump();
    }

    function blocked(e){ return e instanceof TypeError && !(controller.signal && controller.signal.aborted); }

    return post().then(handle).catch(function(e){
      // Direct call never got a response: retry once through the personal proxy. Nothing has streamed yet.
      if(blocked(e) && FALLBACK_PROXY_URL && url !== FALLBACK_PROXY_URL){
        url = FALLBACK_PROXY_URL; usedFallback = true;
        return post().then(handle);
      }
      throw e;
    }).catch(function(e){
      if(e && e.name === "AbortError"){ state.aborted = true; return; }
      if(blocked(e)){
        throw new Error("Request was blocked before it reached OpenRouter (CORS preflight failed)" + (usedFallback ? ", and the proxy could not be reached either" : "") + ". Try another network, or set a proxy endpoint in Settings \u2192 Advanced. (" + (e.message || String(e)) + ")");
      }
      throw e;
    }).then(function(){
      if(els._timer){ clearInterval(els._timer); els._timer = null; }
      currentAbort = null;
      if(usedFallback && !state.aborted && settings.endpoint !== FALLBACK_PROXY_URL){
        settings.endpoint = FALLBACK_PROXY_URL; saveSettings();
        toast("Direct OpenRouter calls are blocked here. Switched to your proxy (Settings \u2192 Advanced).");
      }
      if(!state.thinkMs && state.thinking) state.thinkMs = Date.now() - started;
      return state;
    });
  }

  /* ===== Conversation ===== */
  function buildUserContent(text){
    if(attachments.length){
      var plural = attachments.length > 1;
      var note = text ? text : "(No message — please read the attached file" + (plural ? "s" : "") + " and acknowledge " + (plural ? "them" : "it") + ".)";
      var blocks = attachments.map(function(att){
        return 'File "' + att.name + '":\n\n```\n' + att.text + '\n```';
      }).join("\n\n");
      var header = plural
        ? "The user attached " + attachments.length + " files.\n\n"
        : "";
      return header + blocks + "\n\n" + note;
    }
    return text;
  }
  function buildApiMessages(){
    var arr = [];
    if(settings.system && settings.system.trim()) arr.push({ role:"system", content: settings.system.trim() });
    for(var i=0;i<messages.length;i++){ arr.push({ role: messages[i].role, content: messages[i].content }); }
    return arr;
  }

  function runAssistantTurn(){
    var els = buildAssistant();
    setStreaming(true);
    stick = true; scrollBottom();
    els.content.classList.add("streaming");
    els.caret.hidden = false;
    var state = { content:"", thinking:"", thinkMs:0, aborted:false };
    streamCompletion(buildApiMessages(), els, state).then(function(){
      finalizeAssistant(els, state);
      if(state.content || state.thinking){
        var aMsg = { id:uid(), role:"assistant", content:state.content, thinking:state.thinking, thinkMs:state.thinkMs };
        messages.push(aMsg);
        bindAssistantActions(els, aMsg);
      } else {
        els.node.remove();
      }
      saveHistory();
    }).catch(function(err){
      finalizeError(els, (err && err.message) ? err.message : "Something went wrong.", els.node);
    }).then(function(){
      setStreaming(false);
      if(stick) scrollBottom();
    });
  }

  function send(){
    if(isStreaming) return;
    var text = input.value.trim();
    if(!text && !attachments.length) return;
    if(!settings.apiKey){ toast("Add your OpenRouter API key first"); openSettings(); return; }

    var userMsg = {
      id: uid(), role: "user",
      display: text,
      content: buildUserContent(text),
      attachments: attachments.map(function(att){ return { name: att.name, size: att.size }; })
    };
    messages.push(userMsg);
    hideEmpty();
    buildUser(userMsg);

    input.value = ""; autoresize();
    attachments = []; renderAttachmentChips();
    saveHistory();

    stick = true; scrollBottom();
    runAssistantTurn();
  }

  function setStreaming(b){
    isStreaming = b;
    if(b){
      sendBtn.classList.add("stop");
      sendBtn.innerHTML = ICON.stop;
      sendBtn.setAttribute("aria-label","Stop");
    } else {
      sendBtn.classList.remove("stop");
      sendBtn.innerHTML = ICON.arrow;
      sendBtn.setAttribute("aria-label","Send");
    }
  }

  /* ===== Scrolling ===== */
  function scrollBottom(){ scroller.scrollTop = scroller.scrollHeight; }
  scroller.addEventListener("scroll", function(){
    var nearBottom = (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight) < 80;
    stick = nearBottom;
    fab.classList.toggle("show", !nearBottom && messages.length > 0);
  });
  fab.addEventListener("click", function(){ stick = true; scrollBottom(); fab.classList.remove("show"); });

  /* ===== Empty state ===== */
  function showEmpty(){ empty.style.display = "flex"; }
  function hideEmpty(){ empty.style.display = "none"; }
  function refreshEmpty(){ if(messages.length) hideEmpty(); else showEmpty(); }

  /* ===== History (localStorage) ===== */
  function saveHistory(){
    try{ localStorage.setItem(LS_HIST, JSON.stringify(messages)); }catch(e){}
  }
  function loadHistory(){
    try{
      var raw = localStorage.getItem(LS_HIST);
      messages = raw ? JSON.parse(raw) : [];
      if(!Array.isArray(messages)) messages = [];
    }catch(e){ messages = []; }
  }
  function renderHistory(){
    list.innerHTML = "";
    for(var i=0;i<messages.length;i++){
      var m = messages[i];
      if(m.role === "user"){ buildUser(m); }
      else {
        var els = buildAssistant();
        var state = { content:m.content||"", thinking:m.thinking||"", thinkMs:m.thinkMs||0, aborted:false };
        finalizeAssistant(els, state);
        bindAssistantActions(els, m);
      }
    }
    refreshEmpty();
    requestAnimationFrame(scrollBottom);
  }

  function newChat(){
    if(isStreaming && currentAbort) currentAbort.abort();
    if(messages.length && !window.confirm("Start a new chat? This clears the current conversation on this device.")) return;
    messages = []; saveHistory();
    list.innerHTML = ""; refreshEmpty();
  }

  /* ===== Settings ===== */
  function loadSettings(){
    try{
      var raw = localStorage.getItem(LS_SET);
      if(!raw){
        // One-time copy from the legacy chat app's settings (system is migrated into the style guide later).
        var legacy = localStorage.getItem(LEGACY_LS_SET);
        if(legacy){
          var l = JSON.parse(legacy);
          var copied = {
            apiKey: l.apiKey, model: l.model, thinking: l.thinking,
            endpoint: l.endpoint, system: l.system
          };
          raw = JSON.stringify(copied);
          localStorage.setItem(LS_SET, raw);
        }
      }
      if(raw){
        var s = JSON.parse(raw);
        settings.apiKey  = s.apiKey  || "";
        settings.model   = s.model   || "x-ai/grok-4.7";
        settings.thinking= s.thinking|| "max";
        settings.system  = s.system  || "";
        settings.endpoint= typeof s.endpoint === "string" ? s.endpoint : "";
      }
    }catch(e){}
  }
  function saveSettings(){
    try{ localStorage.setItem(LS_SET, JSON.stringify(settings)); }catch(e){}
  }
  function setThinkSeg(v){
    pendingThink = v;
    thinkSeg.querySelectorAll("button").forEach(function(b){ b.classList.toggle("on", b.getAttribute("data-v")===v); });
  }
  function openSettings(){
    setKey.value = settings.apiKey;
    setModel.value = settings.model;
    setSystem.value = settings.system || "";
    setEndpoint.value = settings.endpoint || "";
    setThinkSeg(settings.thinking);
    settingsOverlay.classList.add("open");
  }
  function closeSettings(){ settingsOverlay.classList.remove("open"); }
  function saveSettingsForm(){
    var ep = setEndpoint.value.trim();
    if(!validEndpoint(ep)){ setEndpoint.value = settings.endpoint || ""; toast("Endpoint must start with https://"); return; }
    settings.endpoint = ep;
    settings.apiKey = setKey.value.trim();
    settings.model = setModel.value.trim() || "x-ai/grok-4.7";
    settings.system = setSystem.value;
    settings.thinking = pendingThink;
    saveSettings(); updatePill(); closeSettings(); toast("Settings saved");
  }

  function renderPresets(){
    var box = $("presets"); box.innerHTML = "";
    MODEL_PRESETS.forEach(function(m){
      var b = document.createElement("button");
      b.className = "preset"; b.type = "button"; b.textContent = m.split("/").pop();
      b.addEventListener("click", function(){ setModel.value = m; });
      box.appendChild(b);
    });
  }
  function renderStarters(){
    var box = $("starters"); box.innerHTML = "";
    STARTERS.forEach(function(p){
      var b = document.createElement("button");
      b.className = "chip"; b.type = "button";
      b.textContent = p.length > 42 ? p.slice(0,40)+"…" : p;
      b.addEventListener("click", function(){ input.value = p; autoresize(); input.focus(); });
      box.appendChild(b);
    });
  }

  /* ===== File attachment ===== */
  function handleFile(f){
    if(!f) return;
    var reader = new FileReader();
    reader.onload = function(){
      attachments.push({ name: f.name, size: f.size, text: String(reader.result) });
      renderAttachmentChips();
      toast("Attached " + f.name);
      input.focus();
    };
    reader.onerror = function(){ toast("Could not read " + f.name); };
    reader.readAsText(f);
  }
  function renderAttachmentChips(){
    if(!attachments.length){ attachWrap.hidden = true; attachWrap.innerHTML = ""; return; }
    attachWrap.hidden = false;
    attachWrap.innerHTML = "";
    attachments.forEach(function(att, i){
      var chip = document.createElement("div");
      chip.className = "attach-chip";
      chip.innerHTML = ICON.file + '<span class="ac-name"></span><span class="ac-size"></span>';
      chip.querySelector(".ac-name").textContent = att.name;
      chip.querySelector(".ac-size").textContent = fmtBytes(att.size);
      chip.querySelector(".ac-name").addEventListener("click", function(){ openReader(att.text, att.name); });
      var rm = document.createElement("button");
      rm.className = "ac-remove"; rm.type = "button"; rm.innerHTML = ICON.close; rm.setAttribute("aria-label","Remove file");
      rm.addEventListener("click", function(){ attachments.splice(i, 1); renderAttachmentChips(); });
      chip.appendChild(rm);
      attachWrap.appendChild(chip);
    });
  }

  /* ===== Reader ===== */
  function openReader(md, title){
    currentReaderMd = md;
    readerTitle.textContent = title || "Document";
    readerBody.innerHTML = renderMarkdown(md);
    enhanceContent(readerBody);
    readerBody.scrollTop = 0;
    reader.classList.add("open");
  }
  function closeReader(){ reader.classList.remove("open"); }

  /* ===== Textarea autoresize ===== */
  function autoresize(){
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, Math.round(window.innerHeight * 0.42)) + "px";
  }

  /* ===== Keyboard / viewport (keep composer above the iOS keyboard) ===== */
  function syncViewport(){
    var vv = window.visualViewport;
    if(!vv) return;
    app.style.height = vv.height + "px";
    app.style.transform = "translateY(" + vv.offsetTop + "px)";
    var kbOpen = (window.innerHeight - vv.height) > 120;
    document.body.classList.toggle("kb-open", kbOpen);
    if(stick) scrollBottom();
  }

  /* ===== Home-screen icon + manifest (generated, keeps the file standalone) ===== */
  function roundRect(x, X, Y, W, H, R){ x.beginPath();
    x.moveTo(X+R,Y); x.arcTo(X+W,Y,X+W,Y+H,R); x.arcTo(X+W,Y+H,X,Y+H,R);
    x.arcTo(X,Y+H,X,Y,R); x.arcTo(X,Y,X+W,Y,R); x.closePath(); }
  function makeIcon(size){
    var c = document.createElement("canvas"); c.width=size; c.height=size;
    var x = c.getContext("2d");
    var g = x.createLinearGradient(0,0,0,size); g.addColorStop(0,"#1d222b"); g.addColorStop(1,"#0e1014");
    x.fillStyle=g; x.fillRect(0,0,size,size);
    var w=size*0.56, h=w*0.8, bx=(size-w)/2, by=size*0.2, r=size*0.13;
    x.fillStyle="#e8a04b"; roundRect(x,bx,by,w,h,r); x.fill();
    x.beginPath(); x.moveTo(bx+w*0.24,by+h-2); x.lineTo(bx+w*0.10,by+h+size*0.12); x.lineTo(bx+w*0.46,by+h-2); x.closePath(); x.fill();
    x.fillStyle="#1c1206"; var cy=by+h*0.5, dr=size*0.045, gap=size*0.13;
    [-1,0,1].forEach(function(i){ x.beginPath(); x.arc(size/2+i*gap, cy, dr, 0, Math.PI*2); x.fill(); });
    return c.toDataURL("image/png");
  }
  function installIcons(){
    try{
      var apple = document.createElement("link"); apple.rel="apple-touch-icon"; apple.href=makeIcon(180);
      document.head.appendChild(apple);
      var fav = document.createElement("link"); fav.rel="icon"; fav.href=makeIcon(64);
      document.head.appendChild(fav);
      var base = new URL(".", location.href).href;
      var manifest = { name:"Ownchat Write", short_name:"Ownchat Write", display:"standalone",
        background_color:"#0e1014", theme_color:"#0e1014", start_url:base, scope:base, id:base,
        icons:[ {src:makeIcon(192),sizes:"192x192",type:"image/png"},
                {src:makeIcon(512),sizes:"512x512",type:"image/png"} ] };
      var mblob = new Blob([JSON.stringify(manifest)], { type:"application/manifest+json" });
      var mlink = document.createElement("link"); mlink.rel="manifest"; mlink.href=URL.createObjectURL(mblob);
      document.head.appendChild(mlink);
    }catch(e){}
  }

  /* ===== Wire up ===== */
  function init(){
    loadSettings(); updatePill();
    renderPresets(); renderStarters();
    loadHistory(); renderHistory();
    installIcons();

    sendBtn.addEventListener("click", function(){
      if(isStreaming){ if(currentAbort) currentAbort.abort(); }
      else { send(); }
    });
    input.addEventListener("input", autoresize);
    input.addEventListener("keydown", function(e){
      if(e.key === "Enter" && (e.metaKey || e.ctrlKey)){ e.preventDefault(); send(); }
    });

    attachBtn.addEventListener("click", function(){ fileInput.click(); });
    fileInput.addEventListener("change", function(e){
      var files = e.target.files ? Array.prototype.slice.call(e.target.files) : [];
      files.forEach(handleFile);
      fileInput.value = ""; // allow re-picking the same file(s)
    });

    $("openSettings").addEventListener("click", openSettings);
    $("modelPill").addEventListener("click", openSettings);
    $("emptyKey").addEventListener("click", openSettings);
    $("setCancel").addEventListener("click", closeSettings);
    $("setSave").addEventListener("click", saveSettingsForm);
    settingsOverlay.addEventListener("click", function(e){ if(e.target === settingsOverlay) closeSettings(); });
    $("toggleKey").addEventListener("click", function(){
      var show = setKey.type === "password";
      setKey.type = show ? "text" : "password";
      this.textContent = show ? "Hide" : "Show";
    });
    thinkSeg.querySelectorAll("button").forEach(function(b){
      b.addEventListener("click", function(){ setThinkSeg(b.getAttribute("data-v")); });
    });

    $("newChat").addEventListener("click", newChat);
    $("readerClose").addEventListener("click", closeReader);
    $("readerExport").addEventListener("click", function(){ exportMarkdown(currentReaderMd, slugFilename(currentReaderMd)); });

    if(window.visualViewport){
      window.visualViewport.addEventListener("resize", syncViewport);
      window.visualViewport.addEventListener("scroll", syncViewport);
      syncViewport();
    }
    window.addEventListener("orientationchange", function(){ setTimeout(syncViewport, 250); });

    autoresize();
    if(!settings.apiKey) setTimeout(openSettings, 350);
    document.documentElement.dataset.ready = "1";
  }

  if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
