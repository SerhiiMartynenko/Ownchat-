import { DEFAULT_API_URL, FALLBACK_PROXY_URL, reasoningConfig, applyReasoning, validEndpoint, streamChat } from "./api.js";
import { uid, hashText } from "./util.js";
import { normalizeBible, proposeFacts, listProposed, cardNames } from "./bible.js";
import { assembleContext } from "./context.js";
import { SUMMARY_DEFAULTS, planFold, runFold } from "./summaries.js";
import { openDb, requestPersistence } from "./db.js";
import { isIOS, isStandalone } from "./storage.js";
import { createStore, emptyThread } from "./store.js";
import { createDigest } from "./digest.js";
import { blocksToText, textToBlocks, countWords } from "./scene.js";
import { insertAfter } from "./editor.js";
import { cleanProse } from "./rewrite.js";
import { shareOrDownload, exportBundle, exportManuscript, readBundleFile } from "./export.js";
import { parseRoute, formatRoute } from "./router.js";
import { initBibleUI, openBible, openCardEditor } from "./ui/bible.js";
import { initMenu, openMenu, closeMenu } from "./ui/menu.js";
import { initLibrary } from "./ui/library.js";
import { initOutline } from "./ui/outline.js";
import { initSceneEditor } from "./ui/scene.js";
import { initSummarySheet } from "./ui/summary.js";
import { initStorageUI } from "./ui/storage.js";

(function(){
  /* ===== Constants ===== */
  var LS_SET = "ownchat.write.settings.v1";
  var LEGACY_LS_SET = "orchat.settings.v1";
  var LEGACY_LS_HIST = "orchat.history.v1";
  var DEFAULT_MODEL = "x-ai/grok-4.7";
  var DEFAULT_UTILITY_MODEL = "x-ai/grok-4.5";

  var ICON = {
    copy:'<svg class="ic" viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
    dl:'<svg class="ic" viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>',
    read:'<svg class="ic" viewBox="0 0 24 24"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>',
    retry:'<svg class="ic" viewBox="0 0 24 24"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
    file:'<svg class="ic" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
    close:'<svg class="ic" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    chev:'<svg class="ic chev" viewBox="0 0 24 24" style="width:14px;height:14px"><path d="M6 9l6 6 6-6"/></svg>',
    arrow:'<svg class="ic" viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
    stop:'<svg class="ic" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>',
    card:'<svg class="ic" viewBox="0 0 24 24"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>'
  };
  var MODEL_PRESETS = ["x-ai/grok-4.7","x-ai/grok-4.5","anthropic/claude-opus-4.8","anthropic/claude-opus-4.8-fast","anthropic/claude-sonnet-4.6","anthropic/claude-haiku-4.5"];
  var STARTERS = [
    "Write the first chapter of a short story about a lighthouse keeper.",
    "Explain how SSH key authentication works, simply.",
    "Draft a markdown cheat-sheet I can export."
  ];

  /* ===== State ===== */
  // settings.system is the legacy chat system prompt: kept for the one-time style-guide migration, never sent.
  var settings = { apiKey:"", model:DEFAULT_MODEL, utilityModel:DEFAULT_UTILITY_MODEL, thinking:"max", system:"", endpoint:"", editorMode:"blocks" };
  var messages = [];          // the thread's messages; single source for rendering (same array as thread.messages)
  var db = null;              // storage handle from openDb()
  var store = null;           // project store over db (store.js)
  var project = null;         // the open project record
  var activeScene = null;     // the project's active scene record (last opened), or null
  var bible = normalizeBible({});
  var thread = null;          // the loaded thread (project or scene scope), see store.emptyThread()
  var threadGen = 0;          // bumped on newChat and thread switches so stale replies and summary jobs are ignored
  var summaryJob = null;      // { controller } while a fold runs
  var summaryFailed = false;
  var lastBreakdown = null;
  var attachments = [];
  var isStreaming = false;
  var currentAbort = null;
  var stick = true;
  var pendingThink = "max";
  var storyChain = [];        // store.listSceneSummaries() of the open project, outline order
  var digest = null;          // background scene summariser (digest.js)
  var bibleUI = null, summarySheet = null, storageUI = null;
  var HISTORY_WINDOW = 60;    // messages rendered when a thread loads; "Show earlier messages" adds as many again
  var historyShown = HISTORY_WINDOW;

  /* ===== Elements ===== */
  function $(id){ return document.getElementById(id); }
  var app=$("app"), scroller=$("scroll"), list=$("list"), empty=$("empty"), fab=$("fab");
  var input=$("input"), sendBtn=$("send"), attachBtn=$("attachBtn"), fileInput=$("fileInput");
  var attachWrap=$("attachWrap"), pillText=$("pillText");
  var settingsOverlay=$("settingsOverlay"), setKey=$("setKey"), setModel=$("setModel"),
      setUtility=$("setUtility"), setEndpoint=$("setEndpoint"), thinkSeg=$("thinkSeg"), toastEl=$("toast");
  var showEarlierBtn=$("showEarlier");
  var ctxMeter=$("ctxMeter"), ctxMeterText=$("ctxMeterText"), ctxOverlay=$("ctxOverlay");
  var reader=$("reader"), readerBody=$("readerBody"), readerTitle=$("readerTitle");
  var currentReaderMd = "";
  // The empty-state paragraph of a project chat, as written in the page (a scene chat swaps in its own).
  var EMPTY_PROJECT_TEXT = empty.querySelector("p").textContent;
  var EMPTY_SCENE_TEXT = "Talk about this scene. Replies stay here; use To scene on a reply to put it in, or select text in the editor to rewrite it in place.";

  /* ===== Utilities ===== */
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
    return shareOrDownload(new Blob([text], { type:"text/markdown" }), filename, { toast: toast });
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
      '<button class="act" data-a="read" type="button">'  + ICON.read + '<span>Read</span></button>' +
      '<button class="act" data-a="card" type="button">'  + ICON.card + '<span>Card</span></button>' +
      '<button class="act" data-a="scene" type="button">' + ICON.arrow + '<span>To scene</span></button>';
    els.actions.querySelector('[data-a=copy]').addEventListener("click", function(){ copyText(msg.content); });
    els.actions.querySelector('[data-a=export]').addEventListener("click", function(){ exportMarkdown(msg.content, slugFilename(msg.content)); });
    els.actions.querySelector('[data-a=read]').addEventListener("click", function(){ openReader(msg.content, firstHeading(msg.content)); });
    els.actions.querySelector('[data-a=card]').addEventListener("click", function(){
      openCardEditor({ type:"note", name: firstHeading(msg.content || "").slice(0,40) || "Note", body: msg.content || "", pinned:false });
    });
    var toScene = els.actions.querySelector('[data-a=scene]');
    if(!msg.content) toScene.setAttribute("data-empty", "1");
    toScene.hidden = !msg.content || !targetSceneForChat();
    toScene.addEventListener("click", function(){ replyToScene(msg); });
    els.actions.hidden = false;
  }

  /* ===== To scene: a chat reply into the scene ===== */
  // The scene a reply can go to: the thread's own scene in a scene chat, else the project's active
  // (last opened) scene. A record (at least {id, title}) or null.
  function targetSceneForChat(){
    if(!thread) return null;
    if(thread.scope !== "scene") return activeScene;
    if(!thread.sceneId) return null;
    if(activeScene && activeScene.id === thread.sceneId) return activeScene;
    var cur = sceneEditor ? sceneEditor.current() : null;
    if(cur && cur.id === thread.sceneId) return cur;
    return { id: thread.sceneId, title: "" };
  }
  // The buttons are built when a message renders; the target can change later (scope, active scene).
  function refreshToSceneButtons(){
    var has = !!targetSceneForChat();
    list.querySelectorAll('.act[data-a=scene]').forEach(function(b){ b.hidden = !has || b.hasAttribute("data-empty"); });
  }
  function editorHas(id){
    var cur = sceneEditor ? sceneEditor.current() : null;
    return !!cur && cur.id === id;
  }
  // The scene is not loaded in the editor (a project chat opened from the outline): write it through
  // the store. Only append and replace exist here, there is no selection.
  async function applyToStoredScene(id, text, how){
    var sc = await store.getScene(id);
    if(!sc) throw new Error("The scene no longer exists");
    var blocks = how === "replace" ? textToBlocks(text, [], uid) : insertAfter(sc.blocks, sc.blocks.length - 1, text, uid);
    var res = await store.saveSceneWithVersion({ id: id, blocks: blocks, wordCount: countWords(blocksToText(blocks)) },
      { reason: how === "replace" ? "chat-replace" : "chat-append" });
    if(!res) throw new Error("The scene no longer exists");
    if(activeScene && activeScene.id === id) activeScene = res.scene;
    return true;
  }
  async function replyToScene(msg){
    var target = targetSceneForChat();
    if(!target || !msg.content) return;
    var id = target.id;
    var text = cleanProse(msg.content).text || msg.content;
    var items = [];
    if(editorHas(id) && sceneEditor.hasSelection()) items.push({ act:"selection", label:"Replace selection" });
    items.push({ act:"append", label:"Append to scene" });
    items.push({ act:"replace", label:"Replace whole scene\u2026" });
    var how = await openMenu("To scene \u00b7 " + (target.title || "Untitled scene"), items);
    if(!how) return;
    if(how === "replace" && !window.confirm("Replace the whole scene text? The current text is kept as a version.")) return;
    var ok = false;
    try{
      if(editorHas(id)) ok = await sceneEditor.applyText(text, how);
      else if(how !== "selection") ok = await applyToStoredScene(id, text, how);
      else toast("Select the text again");
    }catch(e){
      toast("Could not apply: " + ((e && e.message) || "unknown error"));
      return;
    }
    if(!ok) return;
    toast(how === "append" ? "Added to scene \u00b7 version saved" : "Replaced \u00b7 version saved");
    // Split shows the editor beside the chat already; elsewhere go and show the result.
    if(!mqSplit.matches) navigate({ name:"scene", sceneId: id });
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
  // The direct call was blocked and the proxy worked: remember the proxy for next time.
  function persistFallback(result){
    if(result && result.usedFallback && !result.aborted && settings.endpoint !== FALLBACK_PROXY_URL){
      settings.endpoint = FALLBACK_PROXY_URL; saveSettings();
      toast("Direct OpenRouter calls are blocked here. Switched to your proxy (Settings \u2192 Advanced).");
    }
    return result;
  }
  // Generic call (used by non-chat requests such as summaries); key and endpoint come from settings.
  function callApi(opts){
    var o = Object.assign({}, opts, { apiKey: settings.apiKey, endpoint: settings.endpoint });
    return streamChat(o).then(persistFallback);
  }

  function streamCompletion(api, els, state){
    var started = Date.now();
    var controller = new AbortController();
    currentAbort = controller;

    var firstContent = true;
    function startTimer(){
      if(els._timer) return;
      els.think.hidden = false;
      els.think.classList.add("thinking","open");
      els.thinkLabel.textContent = "Thinking…";
      els._timer = setInterval(function(){ els.thinkTime.textContent = fmtDur(Date.now() - started); }, 100);
    }

    return streamChat({
      apiKey: settings.apiKey,
      endpoint: settings.endpoint,
      model: settings.model,
      messages: api,
      thinking: settings.thinking,
      signal: controller.signal,
      onReasoning: function(delta, full){
        if(!els._timer) startTimer();
        state.thinking = full;
        els._pendingThink = state.thinking;
        scheduleRender(els);
      },
      onContent: function(delta, full, meta){
        if(firstContent){
          firstContent = false;
          state.thinkMs = meta.thinkMs;
          if(els._timer){ clearInterval(els._timer); els._timer = null; }
          if(state.thinking){
            els.think.classList.remove("thinking","open");
            els.thinkLabel.textContent = "Thought for " + fmtDur(state.thinkMs);
            els.thinkTime.textContent = "";
          }
        }
        state.content = full;
        els._pendingContent = state.content;
        scheduleRender(els);
      },
      onUsage: function(usage){ state.usage = usage; }
    }).then(function(result){
      if(els._timer){ clearInterval(els._timer); els._timer = null; }
      currentAbort = null;
      state.content = result.content;
      state.thinking = result.thinking;
      state.thinkMs = result.thinkMs;
      state.aborted = result.aborted;
      state.usage = result.usage;
      persistFallback(result);
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
  function runAssistantTurn(){
    var els = buildAssistant();
    setStreaming(true);
    stick = true; scrollBottom();
    els.content.classList.add("streaming");
    els.caret.hidden = false;
    var state = { content:"", thinking:"", thinkMs:0, aborted:false, usage:null };
    var gen = threadGen;
    var ctx;
    try{
      ctx = assembleContext({ model: settings.model, bible: bible, scene: sceneForContext(), storySoFar: storySoFarFor(),
        thread: { messages: messages, summary: thread.summary, summarizedUpTo: thread.summarizedUpTo } });
    }catch(e){
      finalizeError(els, (e && e.message) ? e.message : "Could not build the request.", els.node);
      setStreaming(false);
      return;
    }
    lastBreakdown = ctx.breakdown;
    streamCompletion(ctx.messages, els, state).then(function(){
      finalizeAssistant(els, state);
      if(gen !== threadGen){ els.node.remove(); return; }   // the chat was cleared mid-stream
      if(state.content || state.thinking){
        var aMsg = { id:uid(), role:"assistant", content:state.content, thinking:state.thinking, thinkMs:state.thinkMs };
        messages.push(aMsg);
        bindAssistantActions(els, aMsg);
      } else {
        els.node.remove();
      }
      thread.lastUsage = state.usage
        ? Object.assign({}, state.usage, { estimated: ctx.breakdown.total, model: settings.model, at: Date.now() })
        : thread.lastUsage;
      saveThread(); updateMeter(); maybeSummarize(false);
    }).catch(function(err){
      finalizeError(els, (err && err.message) ? err.message : "Something went wrong.", els.node);
    }).then(function(){
      setStreaming(false);
      if(stick) scrollBottom();
    });
  }

  function send(){
    if(isStreaming || !thread) return;
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
    saveThread();
    clearTimeout(meterTimer); updateMeter();

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

  /* ===== Thread and bible (through the project store) ===== */
  function saveThread(){
    if(!thread || !store || !project) return;
    thread.messages = messages;
    thread.updatedAt = Date.now();
    store.saveThread(project.id, thread).catch(function(){ toast("Could not save the conversation"); });
  }
  function saveBible(){
    if(!store || !project) return;
    store.saveBible(project.id, bible).catch(function(){ toast("Could not save the story bible"); });
  }
  function refreshProposedBadge(){
    $("openBible").classList.toggle("has-proposed", !!project && listProposed(bible).length > 0);
  }
  // The bible changed outside the bible sheet (digest, fold): persist and refresh what shows it.
  function bibleChanged(){
    saveBible();
    if(bibleUI) bibleUI.refresh();
    refreshProposedBadge();
    updateMeter();
  }

  /* ===== Legacy import (chat history from the original app) ===== */
  function legacyHistory(){
    try{
      var arr = JSON.parse(localStorage.getItem(LEGACY_LS_HIST) || "null");
      return Array.isArray(arr) ? arr.filter(function(m){ return m && (m.role === "user" || m.role === "assistant"); }) : [];
    }catch(e){ return []; }
  }
  function refreshImport(){
    var sceneScope = !!thread && thread.scope === "scene";
    $("importLegacy").hidden = sceneScope || !(messages.length === 0 && legacyHistory().length > 0);
  }
  function importLegacy(){
    var arr = legacyHistory();
    if(!arr.length || messages.length){ refreshImport(); return; }
    var seen = {};
    arr.forEach(function(m){
      var c = Object.assign({}, m);
      if(!c.id || seen[c.id]) c.id = uid();
      seen[c.id] = true;
      if(typeof c.content !== "string") c.content = String(c.content == null ? "" : c.content);
      messages.push(c);
    });
    saveThread(); historyChanged(); updateMeter();
    toast("Imported " + arr.length + " messages");
  }

  // Renders the last historyShown messages; opts.keepScroll keeps the visible messages in place
  // (used when earlier ones are revealed above them) instead of scrolling to the bottom.
  function renderHistory(opts){
    var keep = !!(opts && opts.keepScroll);
    var beforeH = scroller.scrollHeight, beforeTop = scroller.scrollTop;
    list.innerHTML = "";
    var from = Math.max(0, messages.length - historyShown);
    for(var i=from;i<messages.length;i++){
      var m = messages[i];
      if(m.role === "user"){ buildUser(m); }
      else {
        var els = buildAssistant();
        var state = { content:m.content||"", thinking:m.thinking||"", thinkMs:m.thinkMs||0, aborted:false };
        finalizeAssistant(els, state);
        bindAssistantActions(els, m);
      }
    }
    showEarlierBtn.hidden = from === 0;
    refreshEmpty(); refreshImport();
    if(keep){ stick = false; scroller.scrollTop = beforeTop + (scroller.scrollHeight - beforeH); }
    else requestAnimationFrame(scrollBottom);
  }
  function resetHistoryWindow(){ historyShown = HISTORY_WINDOW; }
  // The thread changed: render now when the chat is on screen, otherwise the first time it is shown.
  var historyDirty = true;
  function historyChanged(){
    historyDirty = true;
    if(chatShown()) renderHistoryNow();
  }
  function renderHistoryNow(){ historyDirty = false; renderHistory(); }
  function showEarlier(){
    if(messages.length <= historyShown) return;
    historyShown += HISTORY_WINDOW;
    renderHistory({ keepScroll: true });
  }

  function newChat(){
    if(!thread || !project) return;
    var scopeName = thread.scope === "scene" ? "scene chat" : "project chat";
    if(messages.length && !window.confirm("Start a new " + scopeName + "? This clears the current conversation on this device.")) return;
    if(isStreaming && currentAbort) currentAbort.abort();
    if(summaryJob){ summaryJob.controller.abort(); summaryJob = null; }
    threadGen++;
    summaryFailed = false;
    var old = thread;
    thread = emptyThread(old.id, project.id);
    thread.scope = old.scope === "scene" && old.sceneId ? "scene" : "project";
    thread.sceneId = thread.scope === "scene" ? old.sceneId : null;
    thread.includeScene = old.includeScene !== false;
    messages = thread.messages;
    resetHistoryWindow();
    saveThread();
    historyChanged(); updateMeter();
  }

  /* ===== Rolling summaries ===== */
  function maybeSummarize(force){
    if(summaryJob){ if(force) toast("Already summarizing"); return Promise.resolve(); }
    if(!settings.apiKey){ if(force) toast("Add your OpenRouter API key first"); return Promise.resolve(); }
    var plan = planFold(messages, thread.summarizedUpTo, SUMMARY_DEFAULTS, force);
    if(!plan){ if(force) toast("Nothing to fold yet"); return Promise.resolve(); }
    var gen = threadGen, from = thread.summarizedUpTo, snapshot = messages.slice();
    var job = { controller: new AbortController() };
    summaryJob = job;
    updateMeter();
    return runFold({
      messages: snapshot, summary: thread.summary, summarizedUpTo: from,
      cardNames: cardNames(bible), callApi: callApi, model: settings.utilityModel || DEFAULT_UTILITY_MODEL,
      opts: SUMMARY_DEFAULTS, force: !!force, signal: job.controller.signal
    }).then(function(res){
      if(summaryJob === job) summaryJob = null;
      if(!res){ if(gen === threadGen) updateMeter(); return; }
      var last = messages[res.summarizedUpTo - 1];
      if(gen !== threadGen || thread.summarizedUpTo !== from || !last || last.id !== res.summarizedUpToId){ updateMeter(); return; }
      thread.summary = res.summary;
      thread.summarizedUpTo = res.summarizedUpTo;
      thread.summarizedUpToId = res.summarizedUpToId;
      thread.summaryModel = res.model;
      thread.summaryUpdatedAt = Date.now();
      summaryFailed = false;
      saveThread(); updateMeter();
      proposeFromFold(res.facts);
      return maybeSummarize(false);   // catch up when a long backlog needs several folds
    }, function(err){
      if(summaryJob === job) summaryJob = null;
      if(gen !== threadGen) return;
      summaryFailed = true;
      updateMeter();
      if(force) toast("Summary failed: " + ((err && err.message) ? err.message : "unknown error"));
    });
  }

  // Facts the fold spotted become proposed cards (never approved ones).
  function proposeFromFold(facts){
    if(!project || !thread || !facts || !facts.length) return;
    var src = { kind:"chat", threadId: thread.id, at: Date.now() };
    if(thread.sceneId) src.sceneId = thread.sceneId;
    var r = proposeFacts(bible, facts, src, uid);
    if(!r.added.length) return;
    bible = r.bible;
    bibleChanged();
  }

  /* ===== Context meter ===== */
  function fmtK(n){ return n < 1000 ? String(n) : (n/1000).toFixed(1) + "k"; }
  function bibleHasContent(){
    return !!((bible.brief || "").trim() || (bible.styleGuide || "").trim() || (bible.cards || []).length);
  }
  // The scene as a context layer: a scene thread always has its own scene; the project thread has the
  // active scene unless the chip switched it off.
  function sceneForContext(){
    if(!thread || !activeScene) return null;
    var on = thread.scope === "scene" ? activeScene.id === thread.sceneId : thread.includeScene;
    return on ? { title: activeScene.title || "", text: blocksToText(activeScene.blocks) } : null;
  }
  // Summaries of earlier scenes: a scene thread sees the scenes before its own; the project thread sees
  // every scene except the one already included in full.
  function storySoFarFor(){
    if(!thread || !storyChain.length) return [];
    var list;
    if(thread.scope === "scene"){
      var i = -1;
      for(var k = 0; k < storyChain.length; k++){ if(storyChain[k].id === thread.sceneId){ i = k; break; } }
      list = i > 0 ? storyChain.slice(0, i) : [];
    } else {
      var skip = sceneForContext() && activeScene ? activeScene.id : null;
      list = storyChain.filter(function(e){ return e.id !== skip; });
    }
    return list.filter(function(e){ return (e.summary || "").trim(); }).map(function(e){
      return { title: e.title || "", chapterTitle: e.chapterTitle || "", summary: e.summary, stale: !!e.stale };
    });
  }
  function refreshChain(){
    if(!project || !store){ storyChain = []; return Promise.resolve(); }
    var pid = project.id;
    return store.listSceneSummaries(pid).then(function(list){
      if(project && project.id === pid) storyChain = list || [];
    }, function(){});
  }
  function digestBusy(){
    return !!digest && storyChain.some(function(e){ return digest.isRunning(e.id); });
  }
  function previewContext(){
    // The draft (possibly empty) is the would-be current message; every stored message is history.
    return assembleContext({ model: settings.model, bible: bible, scene: sceneForContext(), storySoFar: storySoFarFor(),
      thread: { messages: messages, summary: thread ? thread.summary : "", summarizedUpTo: thread ? thread.summarizedUpTo : 0 },
      draft: input.value.trim() ? input.value : "" });
  }
  function refreshSceneChip(){
    var chip = $("sceneChip");
    if(!activeScene || !thread || thread.scope === "scene"){ chip.hidden = true; chip.classList.remove("on"); return; }
    var on = thread.includeScene !== false;
    $("sceneChipText").textContent = "Scene: " + (activeScene.title || "Untitled scene") + " \u00b7 " + (on ? "On" : "Off");
    chip.classList.toggle("on", on);
    chip.setAttribute("aria-pressed", on ? "true" : "false");
    chip.hidden = false;
  }
  function toggleSceneInContext(){
    if(!thread || !activeScene || thread.scope === "scene") return;
    thread.includeScene = thread.includeScene === false;
    saveThread(); refreshSceneChip(); updateMeter();
  }
  function updateMeter(){
    refreshSceneChip();
    if(!thread) return;
    var hasDraft = !!input.value.trim();
    if(!messages.length && !hasDraft && !bibleHasContent() && !sceneForContext() && !storySoFarFor().length){ ctxMeter.hidden = true; lastBreakdown = null; return; }
    var b;
    try{ b = previewContext().breakdown; }catch(e){ ctxMeter.hidden = true; return; }
    lastBreakdown = b;
    var L = layerMap(b);
    var html = "~" + fmtK(b.total) + " tokens \u00b7 " + L.cards.cards.length + " cards \u00b7 " + L.summary.folded + " folded";
    if(L.scene && L.scene.included) html += L.scene.truncated ? ' \u00b7 <span class="warn">scene trimmed</span>' : " \u00b7 scene";
    if(L.story && L.story.count > 0) html += " \u00b7 " + scenesLabel(L.story.count) + " so far";
    if(L.recent.droppedUnsummarized > 0) html += ' \u00b7 <span class="warn">' + L.recent.droppedUnsummarized + " trimmed</span>";
    if(summaryJob) html += " \u00b7 summarizing\u2026";
    else if(digestBusy()) html += " \u00b7 summarizing scene\u2026";
    if(summaryFailed) html += ' \u00b7 <span class="err">summary failed</span>';
    if(b.overBudget) html += '<span class="warn"> \u00b7 over budget</span>';
    ctxMeterText.innerHTML = html;
    ctxMeter.hidden = false;
    if(ctxOverlay.classList.contains("open")) renderCtxSheet();
  }
  var meterTimer = null;
  function updateMeterSoon(){ clearTimeout(meterTimer); meterTimer = setTimeout(updateMeter, 250); }
  function scenesLabel(n){ return n + (n === 1 ? " scene" : " scenes"); }
  function layerMap(b){
    var out = {};
    b.layers.forEach(function(l){ out[l.key] = l; });
    return out;
  }
  function renderCtxSheet(){
    var b;
    try{ b = previewContext().breakdown; }catch(e){ b = lastBreakdown; }
    var ul = $("ctxLayers"); ul.innerHTML = "";
    if(b){
      b.layers.forEach(function(l){
        var detail = "";
        if(l.key === "cards"){
          detail = (l.cards || []).map(function(c){ return c.name + " (" + (c.reason === "pinned" ? "pinned" : "mentioned") + ")"; }).join(", ");
          if(l.dropped && l.dropped.length) detail += (detail ? " \u00b7 " : "") + "dropped: " + l.dropped.map(function(c){ return c.name; }).join(", ");
        } else if(l.key === "recent"){
          detail = l.count + " messages" + (l.droppedUnsummarized > 0 ? ", " + l.droppedUnsummarized + " trimmed" : "");
        } else if(l.key === "summary"){
          detail = l.folded ? l.folded + " messages folded" : "";
        } else if(l.key === "story"){
          if(l.count > 0){
            detail = scenesLabel(l.count);
            if(l.dropped > 0) detail += ", " + l.dropped + " earlier omitted";
            if(l.stale > 0) detail += ", " + l.stale + " may be out of date";
          }
        } else if(l.key === "scene"){
          if(l.included){
            detail = (l.title || "Untitled scene") + (l.truncated ? " · start trimmed (~" + (l.omittedTokens || 0).toLocaleString() + " tokens left out)" : "");
          } else {
            detail = activeScene && thread && thread.scope !== "scene" ? "off" : "no scene open";
          }
        }
        var li = document.createElement("li"); li.className = "layer-row";
        var a = document.createElement("span"); a.className = "layer-label"; a.textContent = l.label; li.appendChild(a);
        var t = document.createElement("span"); t.className = "layer-tokens"; t.textContent = "~" + l.tokens.toLocaleString(); li.appendChild(t);
        if(detail){ var d = document.createElement("span"); d.className = "layer-detail"; d.textContent = detail; li.appendChild(d); }
        ul.appendChild(li);
      });
      $("ctxTotal").textContent = "Total ~" + b.total.toLocaleString() + " of " + b.budget.toLocaleString() + " budget" + (b.overBudget ? " \u00b7 over budget" : "");
    } else {
      $("ctxTotal").textContent = "";
    }
    var u = thread && thread.lastUsage;
    $("ctxUsage").textContent = u
      ? "Last request: " + (Number(u.prompt_tokens) || 0).toLocaleString() + " prompt tokens (" + (Number(u.cached_tokens) || 0).toLocaleString() + " cached) \u00b7 estimate ~" + (Number(u.estimated) || 0).toLocaleString()
      : "No request yet";
    $("ctxSummaryText").textContent = (thread && thread.summary) || "(no summary yet)";
  }
  function openCtx(){ renderCtxSheet(); ctxOverlay.classList.add("open"); }
  function closeCtx(){ ctxOverlay.classList.remove("open"); }

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
        settings.model   = s.model   || DEFAULT_MODEL;
        settings.utilityModel = s.utilityModel || DEFAULT_UTILITY_MODEL;
        settings.thinking= s.thinking|| "max";
        settings.system  = s.system  || "";
        settings.endpoint= typeof s.endpoint === "string" ? s.endpoint : "";
        settings.editorMode = s.editorMode === "write" ? "write" : "blocks";
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
    setUtility.value = settings.utilityModel || DEFAULT_UTILITY_MODEL;
    setEndpoint.value = settings.endpoint || "";
    setThinkSeg(settings.thinking);
    settingsOverlay.classList.add("open");
    if(storageUI) storageUI.refreshSettings().catch(function(){});
  }
  function closeSettings(){ settingsOverlay.classList.remove("open"); }
  function saveSettingsForm(){
    var ep = setEndpoint.value.trim();
    if(!validEndpoint(ep)){ setEndpoint.value = settings.endpoint || ""; toast("Endpoint must start with https://"); return; }
    settings.endpoint = ep;
    settings.apiKey = setKey.value.trim();
    settings.model = setModel.value.trim() || DEFAULT_MODEL;
    settings.utilityModel = setUtility.value.trim() || DEFAULT_UTILITY_MODEL;
    settings.thinking = pendingThink;
    saveSettings(); updatePill(); closeSettings(); updateMeter(); toast("Settings saved");
  }

  function renderPresets(box, target){
    box.innerHTML = "";
    MODEL_PRESETS.forEach(function(m){
      var b = document.createElement("button");
      b.className = "preset"; b.type = "button"; b.textContent = m.split("/").pop();
      b.addEventListener("click", function(){ target.value = m; });
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
    if(!vv){ document.documentElement.style.removeProperty("--vvh"); return; }
    document.documentElement.style.setProperty("--vvh", vv.height + "px");
    app.style.height = vv.height + "px";
    app.style.transform = "translateY(" + vv.offsetTop + "px)";
    var kbOpen = (window.innerHeight - vv.height) > 120;
    document.body.classList.toggle("kb-open", kbOpen);
    if(stick && chatShown()) scrollBottom();
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

  /* ===== Projects, routing and views ===== */
  var VIEW_IDS = { library:"viewLibrary", outline:"viewOutline", scene:"viewScene", chat:"viewChat" };
  var currentView = "library";
  var currentRoute = null;
  var goSeq = 0;
  var navStack = [];          // hashes visited in this tab; Back uses history.back() when the parent is the previous one
  var chatOrigin = null;      // { hash, projectId } of the view the chat was opened from
  var library = null, outline = null, sceneEditor = null;
  var metaQueue = Promise.resolve();
  var routeSaveTimer = null;
  var settingsPrompted = false;

  function setMeta(patch){
    // Serialised so read-modify-write updates of the meta record cannot overwrite each other.
    var p = metaQueue.then(function(){ return store.setMeta(patch); });
    metaQueue = p.catch(function(){});
    return p;
  }
  function rememberRoute(hash){
    clearTimeout(routeSaveTimer);
    routeSaveTimer = setTimeout(function(){ setMeta({ lastRoute: hash }); }, 400);
  }

  // Desktop layout: outline sidebar from 1024px, scene chat beside the editor ("split") from 1280px.
  var mqWide = window.matchMedia("(min-width:1024px)");
  var mqSplit = window.matchMedia("(min-width:1280px)");
  function syncLayout(){ document.body.dataset.layout = mqWide.matches ? "wide" : "narrow"; }
  function onLayoutChange(){
    syncLayout();
    if(currentRoute) go(currentRoute);
  }
  function onMq(mq){
    if(mq.addEventListener) mq.addEventListener("change", onLayoutChange);
    else if(mq.addListener) mq.addListener(onLayoutChange);
  }
  function sceneShown(){ return currentView === "scene" || currentView === "split"; }
  function chatShown(){ return currentView === "chat" || currentView === "split"; }
  function outlineShown(){
    return currentView === "outline" || (mqWide.matches && (currentView === "scene" || currentView === "chat" || currentView === "split"));
  }
  // Sidebar refresh after autosaves: at most once every 3 s, trailing.
  var sidebarTimer = null;
  function refreshSidebarSoon(){
    if(sidebarTimer) return;
    sidebarTimer = setTimeout(function(){
      sidebarTimer = null;
      if(project && outline && outlineShown()) outline.renderOutline(project.id);
    }, 3000);
  }

  function show(view){
    currentView = view;
    Object.keys(VIEW_IDS).forEach(function(v){
      var on = v === view || (view === "split" && (v === "scene" || v === "chat"));
      $(VIEW_IDS[v]).classList.toggle("active", on);
    });
    document.body.dataset.view = view;
    document.querySelectorAll("[data-views]").forEach(function(el){
      el.hidden = el.dataset.views.split(" ").indexOf(view) < 0;
    });
    var label = view === "scene" ? "Scene chat" : "Project chat";
    $("hdrChat").setAttribute("aria-label", label);
    $("hdrChat").title = label;
  }
  function setHeader(title, sub){
    $("hdrTitle").textContent = title || "";
    var s = $("hdrSub");
    s.textContent = sub || "";
    s.style.display = sub ? "" : "none";
  }
  function wordsLabel(n){ n = Number(n) || 0; return n.toLocaleString() + (n === 1 ? " word" : " words"); }

  // Forget the open project: stop its stream and summary job and drop its records.
  function closeProject(){
    if(isStreaming && currentAbort) currentAbort.abort();
    if(summaryJob){ summaryJob.controller.abort(); summaryJob = null; }
    threadGen++;
    summaryFailed = false;
    project = null; thread = null; messages = []; activeScene = null; bible = normalizeBible({});
    lastBreakdown = null; chatOrigin = null; storyChain = [];
    resetHistoryWindow(); historyDirty = true;
    attachments = []; renderAttachmentChips();
    refreshProposedBadge();
  }

  // Makes pid the open project (no-op apart from a refresh when it already is). Resolves false if missing.
  async function openProject(pid){
    var p = await store.getProject(pid);
    if(!p) return false;
    if(project && project.id === pid){ project = p; return true; }
    if(sceneEditor) await sceneEditor.flush();
    var b = await store.getBible(p), t = await store.getThread(p);
    var sc = p.lastSceneId ? await store.getScene(p.lastSceneId) : null;
    closeProject();
    project = p; bible = b; thread = t; messages = thread.messages;
    activeScene = sc && sc.projectId === p.id ? sc : null;
    setMeta({ currentProjectId: p.id });
    historyChanged(); updateMeter(); refreshProposedBadge();
    return true;
  }

  /* ===== Chat threads: one per project, one per scene ===== */
  // Swaps in another thread: stops the reply and the fold of the old one.
  function switchThread(t){
    if(isStreaming && currentAbort) currentAbort.abort();
    if(summaryJob){ summaryJob.controller.abort(); summaryJob = null; }
    threadGen++;
    summaryFailed = false;
    thread = t; messages = thread.messages;
    resetHistoryWindow();
    historyChanged(); refreshScope(); updateMeter();
  }
  async function loadThreadFor(route){
    if(!project) return;
    var t = route.name === "sceneChat" ? await store.getSceneThread(activeScene) : await store.getThread(project);
    if(!t || !project || t.projectId !== project.id) return;
    if(thread && thread.id === t.id) return;
    switchThread(t);
  }
  function refreshScope(){
    var box = $("chatScope"), sBtn = $("chatScopeScene"), pBtn = $("chatScopeProject");
    var sceneScope = !!thread && thread.scope === "scene";
    box.hidden = !thread || !(sceneScope || activeScene);
    sBtn.classList.toggle("on", sceneScope);
    pBtn.classList.toggle("on", !sceneScope);
    sBtn.setAttribute("aria-pressed", sceneScope ? "true" : "false");
    pBtn.setAttribute("aria-pressed", sceneScope ? "false" : "true");
    sBtn.textContent = "Scene \u00b7 " + ((activeScene && activeScene.title) || "Untitled scene");
    $("emptyTitle").textContent = sceneScope ? "Scene chat" : "Project chat";
    empty.querySelector("p").textContent = sceneScope ? EMPTY_SCENE_TEXT : EMPTY_PROJECT_TEXT;
    refreshToSceneButtons();
  }
  function pickScope(v){
    if(!project || !thread || !chatShown()) return;
    if(v === "scene" && activeScene && !(thread.scope === "scene" && thread.sceneId === activeScene.id)){
      replaceRoute({ name:"sceneChat", sceneId: activeScene.id });
    } else if(v === "project" && thread.scope === "scene"){
      replaceRoute({ name:"chat", projectId: project.id });
    }
  }
  // Scenes deleted from the outline: their thread goes, and so do queued digests.
  function onScenesDeleted(ids){
    if(digest) digest.forget(ids);
    storyChain = storyChain.filter(function(e){ return ids.indexOf(e.id) < 0; });
    if(activeScene && ids.indexOf(activeScene.id) >= 0) activeScene = null;
    if(thread && thread.scope === "scene" && ids.indexOf(thread.sceneId) >= 0){
      if(isStreaming && currentAbort) currentAbort.abort();
      if(summaryJob){ summaryJob.controller.abort(); summaryJob = null; }
      threadGen++;
      var pid = project && project.id;
      if(pid) store.getThread(project).then(function(t){
        if(t && project && project.id === pid && thread && thread.scope === "scene" && ids.indexOf(thread.sceneId) >= 0) switchThread(t);
      }, function(){});
    }
    refreshScope(); updateMeter();
  }
  // A scene's summary was written (digest or the summary sheet).
  function onSceneUpdated(rec){
    if(!rec) return;
    if(activeScene && activeScene.id === rec.id){
      activeScene = Object.assign({}, activeScene, { summary: rec.summary, summaryHash: rec.summaryHash,
        summaryUpdatedAt: rec.summaryUpdatedAt, summaryModel: rec.summaryModel });
    }
    if(project && rec.projectId === project.id){
      refreshChain().then(updateMeter);
      if(outlineShown() && outline) outline.renderOutline(project.id);
    }
    if(summarySheet) summarySheet.refresh(rec);
  }

  async function reloadActiveScene(){
    if(sceneEditor) await sceneEditor.flush();
    var p = await store.getProject(project.id);
    if(p) project = p;
    var sc = project.lastSceneId ? await store.getScene(project.lastSceneId) : null;
    activeScene = sc && sc.projectId === project.id ? sc : null;
  }

  async function deleteProject(pid){
    if(project && project.id === pid){
      if(sceneEditor) await sceneEditor.close();
      closeProject();
    }
    await store.deleteProject(pid);
  }

  function noteNav(hash, replace){
    if(replace || !navStack.length){ navStack[Math.max(0, navStack.length - 1)] = hash; return; }
    if(navStack.length > 1 && navStack[navStack.length - 2] === hash) navStack.pop();
    else if(navStack[navStack.length - 1] !== hash) navStack.push(hash);
  }
  function navigate(route, opts){
    if(opts && opts.replace) return replaceRoute(route);
    var hash = formatRoute(route);
    if(location.hash === hash) return go(route);
    location.hash = hash;     // the hashchange listener calls go()
    return Promise.resolve();
  }
  function replaceRoute(route){
    var hash = formatRoute(route);
    history.replaceState(null, "", hash);
    noteNav(hash, true);
    return go(route);
  }
  function notFound(){
    toast("Not found");
    return replaceRoute({ name:"library" });
  }

  function parentOf(route){
    if(route.name === "scene") return project ? { name:"outline", projectId: project.id } : { name:"library" };
    if(route.name === "chat"){
      if(chatOrigin && chatOrigin.projectId === route.projectId) return parseRoute(chatOrigin.hash);
      return { name:"outline", projectId: route.projectId };
    }
    if(route.name === "sceneChat"){
      if(chatOrigin && project && chatOrigin.projectId === project.id) return parseRoute(chatOrigin.hash);
      return { name:"scene", sceneId: route.sceneId };
    }
    if(route.name === "outline") return { name:"library" };
    return null;
  }
  function goBack(){
    var parent = currentRoute && parentOf(currentRoute);
    if(!parent) return;
    if(navStack.length > 1 && navStack[navStack.length - 2] === formatRoute(parent)) history.back();
    else replaceRoute(parent);
  }

  async function go(route){
    var seq = ++goSeq;
    closeMenu();
    try{
      var wasScene = sceneShown();
      var leaving = wasScene && sceneEditor ? sceneEditor.current() : null;
      if(wasScene && sceneEditor) await sceneEditor.flush();
      if(seq !== goSeq) return;
      // Leaving a scene: refresh its digest in the background (skipped when the text is unchanged).
      // Staying on it (the scene route, or the split with its own chat) is not leaving.
      var stays = leaving && route.sceneId === leaving.id && (route.name === "scene" || (route.name === "sceneChat" && mqSplit.matches));
      if(leaving && digest && !stays) digest.queue(leaving.id);
      if(route.name === "library"){
        var projects = await library.renderLibrary();
        if(seq !== goSeq) return;
        if(storageUI) storageUI.refreshNotice(projects).catch(function(){});
        setHeader("Projects", "");
        show("library");
      } else if(route.name === "outline" || route.name === "chat"){
        if(!(await openProject(route.projectId))){ if(seq === goSeq) notFound(); return; }
        if(seq !== goSeq) return;
        if(route.name === "outline"){
          outline.setCurrent(null);
          var o = await outline.renderOutline(project.id);
          if(seq !== goSeq) return;
          setHeader(project.title, wordsLabel(o ? o.words : 0));
          show("outline");
        } else {
          await reloadActiveScene();
          if(seq !== goSeq) return;
          await loadThreadFor(route);
          await refreshChain();
          if(seq !== goSeq) return;
          if(!(await renderSidebar(null, seq))) return;
          showChat("chat");
        }
      } else if(route.name === "sceneChat"){
        var cs = await store.getScene(route.sceneId);
        if(!cs || !(await openProject(cs.projectId))){ if(seq === goSeq) notFound(); return; }
        if(seq !== goSeq) return;
        activeScene = cs;
        project.lastSceneId = cs.id;
        try{ await store.setLastScene(project.id, cs.id); }catch(e){}
        await loadThreadFor(route);
        await refreshChain();
        if(seq !== goSeq) return;
        var split = mqSplit.matches;
        if(split){
          var open = sceneEditor.current();
          if(!open || open.id !== cs.id) await sceneEditor.open(cs.id);
          if(seq !== goSeq) return;
          updateModeLabel();
        }
        if(!(await renderSidebar(cs.id, seq))) return;
        showChat(split ? "split" : "chat");
      } else if(route.name === "scene"){
        var s = await store.getScene(route.sceneId);
        if(!s || !(await openProject(s.projectId))){ if(seq === goSeq) notFound(); return; }
        if(seq !== goSeq) return;
        await sceneEditor.open(s.id);
        if(seq !== goSeq) return;
        if(!(await renderSidebar(s.id, seq))) return;
        setHeader(project.title, "");
        updateModeLabel();
        show("scene");
      }
      currentRoute = route;
      rememberRoute(formatRoute(route));
    }catch(e){
      toast("Something went wrong: " + ((e && e.message) ? e.message : "unknown error"));
    }
  }

  // Wide layout: the outline sidebar for the open project, with sceneId highlighted. Resolves false
  // when a newer navigation started meanwhile.
  async function renderSidebar(sceneId, seq){
    if(!mqWide.matches || !project) return true;
    outline.setCurrent(sceneId);
    await outline.renderOutline(project.id);
    return seq === goSeq;
  }

  function showChat(view){
    setHeader(project.title, "");
    show(view === "split" ? "split" : "chat");
    if(historyDirty) renderHistoryNow();
    refreshScope(); updateMeter(); refreshImport();
    stick = true; scrollBottom();
    if(!settings.apiKey && !settingsPrompted){ settingsPrompted = true; setTimeout(openSettings, 350); }
  }

  async function routeResolves(r){
    if(!r) return false;
    if(r.name === "library") return true;
    if(r.name === "scene" || r.name === "sceneChat") return !!(await store.getScene(r.sceneId));
    return !!(await store.getProject(r.projectId));
  }
  async function landingRoute(meta){
    if(location.hash && location.hash !== "#") return parseRoute(location.hash);
    if(meta.lastRoute){
      var last = parseRoute(meta.lastRoute);
      if(await routeResolves(last)) return last;
    }
    if(meta.currentProjectId && await store.getProject(meta.currentProjectId)) return { name:"outline", projectId: meta.currentProjectId };
    var projects = await store.listProjects();
    return projects.length ? { name:"outline", projectId: projects[0].id } : { name:"library" };
  }

  /* ===== Scene header: editing mode and menu ===== */
  function updateModeLabel(){
    var b = $("hdrMode");
    var write = (sceneEditor ? sceneEditor.mode() : settings.editorMode) === "write";
    b.textContent = write ? "Blocks" : "Write";
    b.setAttribute("aria-label", write ? "Switch to Blocks" : "Switch to Write");
    b.title = b.getAttribute("aria-label");
  }
  function setEditorMode(m){
    settings.editorMode = m === "write" ? "write" : "blocks";
    saveSettings();
    updateModeLabel();
    return sceneEditor.setMode(settings.editorMode).then(updateModeLabel, function(e){
      toast("Could not switch: " + ((e && e.message) || "unknown error"));
    });
  }
  function toggleEditorMode(){
    return setEditorMode((sceneEditor ? sceneEditor.mode() : settings.editorMode) === "write" ? "blocks" : "write");
  }

  async function sceneMenu(){
    var sc = sceneEditor && sceneEditor.current();
    if(!sc) return;
    var write = sceneEditor.mode() === "write";
    var act = await openMenu(sc.title || "Scene", [
      { act:"save-version", label:"Save version" },
      { act:"versions", label:"Versions…" },
      { act:"continue", label:"Continue writing" },
      { act:"mode", label: write ? "Switch to Blocks" : "Switch to Write" },
      { act:"summary", label:"Summary\u2026" },
      { act:"rename", label:"Rename scene" }
    ]);
    if(act === "save-version") sceneEditor.saveVersion();
    else if(act === "versions") sceneEditor.openVersions();
    else if(act === "continue") sceneEditor.runAction("continue", { atEnd: true });
    else if(act === "mode") toggleEditorMode();
    else if(act === "summary"){ if(summarySheet) summarySheet.open(sc); }
    else if(act === "rename"){
      var t = window.prompt("Scene title", $("sceneTitle").value || sc.title || "");
      if(t == null || !t.trim()) return;
      try{
        await sceneEditor.flush();
        var rec = await store.renameScene(sc.id, t);
        if(rec){
          sceneEditor.renamed(rec);
          if(activeScene && activeScene.id === rec.id) activeScene = Object.assign({}, activeScene, { title: rec.title });
          if(outlineShown() && project) outline.renderOutline(project.id);
        }
      }catch(e){ toast("Could not rename the scene"); }
    }
  }
  function headerMenu(){
    var v = document.body.dataset.view;
    if(v === "outline") outline.projectMenu();
    else if(v === "scene" || v === "split") sceneMenu();
  }

  /* ===== Export / import ===== */
  async function exportProject(pid, kind){
    try{
      if(project && project.id === pid && sceneEditor) await sceneEditor.flush();
      var data = await store.loadProjectData(pid);
      if(!data) throw new Error("Project not found");
      if(kind === "manuscript") await exportManuscript(data, { toast: toast });
      else{
        var how = await exportBundle(data, { toast: toast });
        if(how !== "cancelled" && storageUI) await storageUI.noteExported(pid);
      }
    }catch(e){
      toast((e && e.message) ? e.message : "Export failed");
    }
  }

  // A bundle whose project id is new is imported keeping its ids ("replace" with nothing to replace).
  async function importFile(file){
    try{
      var data = await readBundleFile(file, { toast: toast, uid: uid });
      var srcId = data && data.project && data.project.id;
      var existing = srcId ? await store.getProject(String(srcId)) : null;
      var mode = "replace";
      if(existing){
        var act = await openMenu("Project already exists", [
          { act:"copy", label:"Import as a copy" },
          { act:"replace", label:"Replace existing", danger:true },
          { act:"cancel", label:"Cancel" }
        ]);
        if(act !== "copy" && act !== "replace") return;
        mode = act;
        if(mode === "replace" && project && project.id === existing.id){
          if(sceneEditor) await sceneEditor.close();
          closeProject();
        }
      }
      var pid = await store.importProject(data, { mode: mode });
      var w = (data.warnings || []).length;
      toast("Imported" + (w ? " with " + w + (w === 1 ? " warning" : " warnings") : ""));
      await navigate({ name:"outline", projectId: pid });
    }catch(e){
      toast((e && e.message) ? e.message : "Import failed");
    }
  }

  /* ===== Startup ===== */
  async function start(){
    db = await openDb({
      onBlocked: function(){ toast("Close other Ownchat Write tabs to finish updating"); },
      onVersionChange: function(){ toast("Updated in another tab, reload"); }
    });
    store = createStore(db, { uid: uid });
    var meta = await store.init({ legacySystem: settings.system });
    digest = createDigest({
      loadScene: async function(id){
        var sc = await store.getScene(id);
        if(!sc) return null;
        var ch = sc.chapterId ? await store.getChapter(sc.chapterId) : null;
        return { scene: sc, chapterTitle: (ch && ch.title) || "" };
      },
      patchScene: store.patchScene,
      getBible: function(pid){ return project && project.id === pid ? bible : null; },
      setBible: function(pid, b){
        if(!project || project.id !== pid) return;
        bible = b;
        bibleChanged();
      },
      getSettings: function(){ return { apiKey: settings.apiKey, utilityModel: settings.utilityModel || DEFAULT_UTILITY_MODEL }; },
      callApi: callApi, uid: uid, now: Date.now,
      onSceneUpdated: onSceneUpdated,
      onStateChange: function(){ updateMeter(); if(summarySheet) summarySheet.refresh(); },
      onError: function(id, err, o){
        if(!(o && o.force)) return;
        var m = (err && err.message) || "unknown error";
        toast(/API key/.test(m) ? m : "Summary failed: " + m);
      }
    });
    summarySheet = initSummarySheet({ $: $, store: store, toast: toast, digest: digest, hashText: hashText,
      flush: function(){ return sceneEditor ? sceneEditor.flush() : Promise.resolve(); },
      onSaved: onSceneUpdated,
      confirm: function(msg){ return window.confirm(msg); } });

    initMenu({ $: $ });
    library = initLibrary({ $: $, store: store, toast: toast, openMenu: openMenu, go: navigate,
      exportProject: exportProject, importFile: importFile, deleteProject: deleteProject,
      onRenamed: function(pid){ if(project && project.id === pid) store.getProject(pid).then(function(p){ if(p && project && project.id === p.id) project = p; }); } });
    // In the split a scene row keeps the chat pane open: it opens that scene's chat beside its editor.
    function outlineGo(route, opts){
      if(currentView === "split" && route && route.name === "scene" && project){
        chatOrigin = { hash: formatRoute(route), projectId: project.id };
        return navigate({ name:"sceneChat", sceneId: route.sceneId }, opts);
      }
      return navigate(route, opts);
    }
    outline = initOutline({ $: $, store: store, toast: toast, openMenu: openMenu, go: outlineGo,
      exportProject: exportProject, deleteProject: deleteProject, openSettings: openSettings,
      onRendered: function(o){
        if(project && o.project && o.project.id === project.id && currentView === "outline") setHeader(project.title, wordsLabel(o.words));
      },
      onProjectRenamed: function(pid){
        store.getProject(pid).then(function(p){
          if(p && project && project.id === p.id){ project = p; if(currentView === "outline") setHeader(p.title, $("hdrSub").textContent); }
        });
      },
      onSceneRenamed: function(sid){ if(activeScene && activeScene.id === sid) store.getScene(sid).then(function(s){ if(s && activeScene && activeScene.id === s.id) activeScene = s; }); },
      onScenesDeleted: onScenesDeleted,
      openSummary: function(sc){ if(summarySheet) summarySheet.open(sc); } });
    sceneEditor = initSceneEditor({ $: $, store: store, toast: toast, uid: uid,
      openMenu: openMenu, callApi: callApi,
      getSettings: function(){ return settings; },
      getBible: function(){ return bible; },
      prompt: function(msg, def){ return window.prompt(msg, def == null ? "" : def); },
      confirm: function(msg){ return window.confirm(msg); },
      onOpened: function(s){ if(project && s.projectId === project.id){ activeScene = s; project.lastSceneId = s.id; } },
      onSaved: function(rec){
        if(activeScene && activeScene.id === rec.id) activeScene = rec;
        if(outlineShown()) refreshSidebarSoon();
      } });
    // Meta reads and writes go through main's queue so they cannot race the lastRoute saves.
    var metaStore = {
      getMeta: function(){ return metaQueue.then(function(){ return store.getMeta(); }); },
      setMeta: setMeta
    };
    storageUI = initStorageUI({ $: $, store: metaStore, toast: toast, requestPersistence: requestPersistence,
      exportProject: exportProject, now: Date.now,
      env: { ios: isIOS(navigator.userAgent, navigator.platform, navigator.maxTouchPoints),
             standalone: isStandalone(navigator, window.matchMedia.bind(window)) } });

    $("hdrBack").addEventListener("click", goBack);
    $("hdrMenu").addEventListener("click", headerMenu);
    $("hdrMode").addEventListener("click", toggleEditorMode);
    updateModeLabel();
    $("hdrChat").addEventListener("click", function(){
      if(!project) return;
      chatOrigin = { hash: formatRoute(currentRoute), projectId: project.id };
      var sc = sceneShown() && sceneEditor ? sceneEditor.current() : null;
      if(sc) navigate({ name:"sceneChat", sceneId: sc.id });
      else navigate({ name:"chat", projectId: project.id });
    });
    $("chatScopeScene").addEventListener("click", function(){ pickScope("scene"); });
    $("chatScopeProject").addEventListener("click", function(){ pickScope("project"); });
    $("sceneChip").addEventListener("click", toggleSceneInContext);
    $("openBible").addEventListener("click", function(){ if(sceneEditor) sceneEditor.flush(); });
    $("openSettings").addEventListener("click", function(){ if(sceneEditor) sceneEditor.flush(); });
    onMq(mqWide); onMq(mqSplit);
    window.addEventListener("hashchange", function(){
      noteNav(location.hash, false);
      go(parseRoute(location.hash));
    });

    var landing = await landingRoute(meta);
    var hash = formatRoute(landing);
    history.replaceState(null, "", hash);
    navStack = [hash];
    await go(landing);
    if(db.memory) toast("Storage unavailable; changes will not persist.");
    requestPersistence().catch(function(){});
    document.documentElement.dataset.ready = "1";
  }

  /* ===== Wire up ===== */
  // Escape closes the topmost open sheet (or the reader) through its own backdrop-click handler.
  // The generic menu handles Escape itself.
  function onEscape(e){
    if(e.key !== "Escape" || e.defaultPrevented) return;
    var top = null, topZ = -Infinity;
    document.querySelectorAll(".overlay.open").forEach(function(o){
      var z = parseInt(getComputedStyle(o).zIndex, 10) || 0;
      if(z >= topZ){ top = o; topZ = z; }
    });
    if(reader.classList.contains("open") && (!top || 50 >= topZ)){ closeReader(); return; }
    if(!top || top.id === "menuOverlay") return;
    top.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  }

  function init(){
    syncLayout();
    loadSettings(); updatePill();
    renderPresets($("presets"), setModel); renderPresets($("utilityPresets"), setUtility);
    renderStarters();
    installIcons();
    bibleUI = initBibleUI({ $: $, uid: uid, toast: toast,
      getBible: function(){ return bible; },
      setBible: function(b){ bible = b; },
      onChange: function(){ saveBible(); updateMeter(); refreshProposedBadge(); } });

    sendBtn.addEventListener("click", function(){
      if(isStreaming){ if(currentAbort) currentAbort.abort(); }
      else { send(); }
    });
    input.addEventListener("input", function(){ autoresize(); updateMeterSoon(); });
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

    $("setOpenBible").addEventListener("click", function(){ closeSettings(); openBible(); });
    $("importLegacy").addEventListener("click", importLegacy);
    ctxMeter.addEventListener("click", openCtx);
    $("ctxClose").addEventListener("click", closeCtx);
    ctxOverlay.addEventListener("click", function(e){ if(e.target === ctxOverlay) closeCtx(); });
    $("ctxSummarize").addEventListener("click", function(){
      var p = maybeSummarize(true);
      renderCtxSheet();
      p.then(function(){ if(ctxOverlay.classList.contains("open")) renderCtxSheet(); });
    });
    $("newChat").addEventListener("click", newChat);
    showEarlierBtn.addEventListener("click", showEarlier);
    document.addEventListener("keydown", onEscape);
    $("readerClose").addEventListener("click", closeReader);
    $("readerExport").addEventListener("click", function(){ exportMarkdown(currentReaderMd, slugFilename(currentReaderMd)); });

    if(window.visualViewport){
      window.visualViewport.addEventListener("resize", syncViewport);
      window.visualViewport.addEventListener("scroll", syncViewport);
      syncViewport();
    }
    window.addEventListener("orientationchange", function(){ setTimeout(syncViewport, 250); });

    autoresize();
    start().catch(function(err){
      toast("App failed to load: " + ((err && err.message) ? err.message : "storage error"));
    });
  }

  if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
