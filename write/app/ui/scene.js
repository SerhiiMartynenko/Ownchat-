// Scene editor: one draft of blocks edited through either the blocks surface (ui/blocks.js, tap to edit,
// select for AI actions) or the plain "Write" textarea, with autosave and a live word count.
// Autosave: 700 ms after the last edit, at most every 5 s while typing, and on blur, page hide,
// tab hide and route changes (flush). Unchanged text is not saved; one save runs at a time and the
// latest text wins. AI actions open the preview sheet; Accept and Restore save through
// store.saveSceneWithVersion so the replaced text is kept as a version. The action bar acts on the
// blocks selection in Blocks mode and on the textarea's native selection in Write mode (see syncWriteBar).
// applyText puts a chat reply into the scene through the same apply path as Accept.
// selectionInfo tells the chat where the current selection sits in the scene text; deps.onSelectionChange
// is called (coalesced) when the selection appears, changes or clears, and when the scene or mode changes.
import { textToBlocks, blocksToText, countWords, splitParagraphs } from "../scene.js";
import { applyReplacement, insertAfter, spliceSelection, windowAround, insertionWindow, normalizeRange, selectionWindow, selectionSpan } from "../editor.js";
import { ACTIONS, TONES, ACTION_THINKING, buildActionRequest, cleanProse, looksLikeChat } from "../rewrite.js";
import { initBlocks } from "./blocks.js";
import { initPreview } from "./preview.js";
import { initVersions } from "./versions.js";

var DEBOUNCE_MS = 700;
var MAX_WAIT_MS = 5000;
var MODES = ["blocks", "write"];
var STALE = "The text changed. Run the action again.";

export function initSceneEditor(deps){
  var $ = deps.$, store = deps.store, toast = deps.toast, uid = deps.uid;
  var viewEl = $("viewScene");
  var titleEl = $("sceneTitle"), textEl = $("sceneText"), wordsEl = $("sceneWords"), savedEl = $("sceneSaved");
  var scene = null;            // the stored record being edited
  var savedText = "", savedTitle = "";
  var mode = MODES.indexOf(viewEl.getAttribute("data-mode")) >= 0 ? viewEl.getAttribute("data-mode") : "blocks";
  var timer = null, maxTimer = null, inflight = null, again = false, wordsRaf = 0;
  var job = null;              // running AI request {controller, partial}
  var barEl = $("blockBar");
  var writeSel = null;         // Write mode: last non-empty textarea selection {start, end, raw}

  var blocksUI = initBlocks({ listEl: $("blockList"), barEl: barEl, uid: uid,
    ownsBar: function(){ return mode === "write"; },
    onBarClose: closeWriteBar,
    onChange: function(){ wordsSoon(); schedule(); },
    onInput: function(){ wordsSoon(); schedule(); },
    onAction: function(act){ runAction(act); },
    onSelect: function(){ selectionSoon(); },
    onContinueAtEnd: function(){ runAction("continue", { atEnd: true }); } });
  var preview = initPreview({ $: $ });
  var versions = initVersions({ $: $, store: store, toast: toast, preview: preview,
    getScene: function(){ return scene; },
    getCurrentText: function(){ return blocksToText(draftBlocks()); },
    beforeOpen: function(){ blocksUI.commitEditing(); return flush(); },
    restore: restore });

  /* ----- Draft and status ----- */
  function draftBlocks(){
    if(!scene) return [];
    return mode === "write" ? textToBlocks(textEl.value, scene.blocks, uid) : blocksUI.getBlocks();
  }
  function draftText(){ return mode === "write" ? textEl.value : blocksToText(blocksUI.getBlocks()); }
  function setStatus(s){ savedEl.textContent = s; savedEl.setAttribute("data-state", s === "Saved" ? "saved" : s === "Edited" ? "edited" : "saving"); }
  function dirty(){ return !!scene && (blocksToText(draftBlocks()) !== savedText || titleEl.value !== savedTitle); }
  // The draft once: its blocks, its text and (Write mode) the raw textarea value it came from.
  function draftState(){
    if(!scene) return { blocks: [], text: "", raw: null };
    var raw = mode === "write" ? textEl.value : null;
    var blocks = mode === "write" ? textToBlocks(raw, scene.blocks, uid) : blocksUI.getBlocks();
    return { blocks: blocks, text: blocksToText(blocks), raw: raw };
  }
  // After a save of draft d: nothing was typed since (same mode, raw text and title) and it was stored.
  function unchangedSince(d, title){
    return d.raw !== null && mode === "write" && textEl.value === d.raw && titleEl.value === title &&
      savedText === d.text && savedTitle === title;
  }
  function showWords(){
    var n = scene ? countWords(draftText()) : 0;
    wordsEl.textContent = n.toLocaleString() + (n === 1 ? " word" : " words");
  }
  function wordsSoon(){
    if(wordsRaf) return;
    wordsRaf = requestAnimationFrame(function(){ wordsRaf = 0; showWords(); });
  }
  function clearTimers(){
    clearTimeout(timer); clearTimeout(maxTimer); timer = null; maxTimer = null;
  }
  function schedule(){
    if(!scene) return;
    setStatus("Edited");
    clearTimeout(timer);
    timer = setTimeout(save, DEBOUNCE_MS);
    if(!maxTimer) maxTimer = setTimeout(save, MAX_WAIT_MS);
  }

  function save(){
    clearTimers();
    if(!scene) return Promise.resolve();
    if(inflight){ again = true; return inflight; }
    var target = scene, title = titleEl.value;
    var d = draftState(), blocks = d.blocks, text = d.text;
    if(text === savedText && title === savedTitle){ setStatus("Saved"); return Promise.resolve(); }
    setStatus("Saving…");
    inflight = store.saveScene({ id: target.id, title: title.trim() || "Untitled scene", blocks: blocks, wordCount: countWords(text) })
      .then(function(rec){
        if(scene !== target) return;          // another scene was opened (or the text replaced) meanwhile
        savedText = text; savedTitle = title;
        if(rec){
          scene = rec;
          if(deps.onSaved) deps.onSaved(rec);
        }
      }, function(){
        toast("Could not save the scene");
      })
      .then(function(){
        inflight = null;
        if(again){ again = false; return save(); }
        if(scene) setStatus(unchangedSince(d, title) || !dirty() ? "Saved" : "Edited");
      });
    return inflight;
  }

  /* ----- Write-mode selection and bar ----- */
  // The bar shows while the textarea has a non-empty selection. The last one is kept in writeSel so a
  // bar press still has it if the textarea lost focus meanwhile; it is dropped when the selection
  // collapses while the textarea has focus (a blur alone keeps selectionStart/End, so it is no reason).
  function syncWriteBar(){
    if(mode !== "write") return;
    var a = textEl.selectionStart, b = textEl.selectionEnd;
    var has = !!scene && typeof a === "number" && a !== b;
    if(has) writeSel = { start: Math.min(a, b), end: Math.max(a, b), raw: textEl.value };
    else if(document.activeElement === textEl) writeSel = null;
    barEl.hidden = !has;
    selectionSoon();
  }
  // The selection an action or a chat reply applies to: the live one, else the kept one while the text
  // is unchanged.
  function currentWriteSel(){
    if(mode !== "write" || !scene) return null;
    var a = textEl.selectionStart, b = textEl.selectionEnd;
    if(typeof a === "number" && a !== b) return { start: Math.min(a, b), end: Math.max(a, b), raw: textEl.value };
    return writeSel && writeSel.raw === textEl.value ? writeSel : null;
  }
  function closeWriteBar(){
    var e = textEl.selectionEnd;
    if(typeof e === "number") try{ textEl.setSelectionRange(e, e); }catch(err){}
    writeSel = null;
    barEl.hidden = true;
    selectionSoon();
  }

  /* ----- Selection for the chat ----- */
  // Where the selection sits in the draft's scene text (see selectionSpan), or null. Reads only: no flush,
  // no commit, no ids allocated.
  function selectionInfo(){
    if(!scene) return null;
    var span;
    if(mode === "write"){
      var ws = currentWriteSel();
      if(!ws) return null;
      var blocks = splitParagraphs(ws.raw).map(function(t){ return { id: "", text: t }; });
      span = selectionSpan(blocks, ws);
    } else {
      var sel = blocksUI.getSelection();
      if(!sel.range && !sel.editing) return null;
      span = selectionSpan(blocksUI.getBlocks(), sel);
    }
    return span ? Object.assign({ sceneId: scene.id }, span) : null;
  }
  // A cheap signature of the selection; onSelectionChange fires (once per task) only when it changed.
  var selSig = "", selTimer = 0;
  function selectionSig(){
    if(!scene) return "";
    if(mode === "write"){
      var ws = currentWriteSel();
      return scene.id + "|w|" + (ws ? ws.start + ":" + ws.end + ":" + ws.raw.length : "");
    }
    var sel = blocksUI.getSelection();
    var r = sel.range ? sel.range.start + "-" + sel.range.end : "";
    var ed = sel.editing ? sel.editing.id + ":" + sel.editing.start + ":" + sel.editing.end + ":" + sel.editing.text.length : "";
    return scene.id + "|b|" + r + "|" + ed;
  }
  function selectionSoon(){
    if(selTimer || !deps.onSelectionChange) return;
    selTimer = setTimeout(function(){
      selTimer = 0;
      var sig = selectionSig();
      if(sig === selSig) return;
      selSig = sig;
      deps.onSelectionChange();
    }, 30);
  }

  /* ----- Surfaces ----- */
  function renderSurface(blocks){
    if(mode === "write"){
      textEl.value = blocksToText(blocks);
      textEl.scrollTop = 0;
      writeSel = null;
      barEl.hidden = true;
    } else {
      blocksUI.render(blocks);
    }
    selectionSoon();
  }

  // Takes a record written by the store (replace or restore) as the new saved state and shows it.
  function adopt(rec){
    scene = rec;
    savedText = blocksToText(rec.blocks);
    renderSurface(rec.blocks);
    showWords();
    setStatus(dirty() ? "Edited" : "Saved");
    if(deps.onSaved) deps.onSaved(rec);
  }

  async function setMode(next){
    if(MODES.indexOf(next) < 0 || next === mode){ viewEl.setAttribute("data-mode", mode); return mode; }
    if(!scene){ mode = next; viewEl.setAttribute("data-mode", mode); return mode; }
    blocksUI.commitEditing();
    // A blocks range does not carry over to Write mode (and vice versa): the bar starts hidden.
    blocksUI.clearSelection();
    var draft = draftBlocks();
    await flush();
    // Render from the saved record when nothing changed since (keeps the ids the store holds).
    if(blocksToText(draft) === savedText) draft = scene.blocks;
    mode = next;
    viewEl.setAttribute("data-mode", mode);
    renderSurface(draft);
    showWords();
    return mode;
  }
  function getMode(){ return mode; }

  /* ----- Open / close ----- */
  function stopJob(){
    if(job){ job.controller.abort(); job = null; }
  }
  function closeSheets(){
    stopJob();
    preview.close();
    versions.close();
  }

  // Loads a scene into the editor (saving the previous one first). Resolves with the scene or null.
  async function open(sceneId){
    closeSheets();
    blocksUI.commitEditing();
    await flush();
    var s = await store.getScene(sceneId);
    if(!s) return null;
    scene = s;
    savedTitle = s.title || "";
    savedText = blocksToText(s.blocks);
    titleEl.value = savedTitle;
    var want = deps.getSettings ? deps.getSettings().editorMode : mode;
    if(MODES.indexOf(want) >= 0) mode = want;
    viewEl.setAttribute("data-mode", mode);
    renderSurface(s.blocks);
    if(mode === "write") textEl.value = savedText;
    showWords();
    setStatus("Saved");
    try{ await store.setLastScene(s.projectId, s.id); }catch(e){}
    if(deps.onOpened) deps.onOpened(s);
    return s;
  }

  function flush(){ return save(); }
  function close(){
    closeSheets();
    blocksUI.commitEditing();
    var p = flush();
    return p.then(function(){ scene = null; selectionSoon(); });
  }
  function current(){ return scene; }
  function hasSelection(){
    if(!scene) return false;
    if(mode === "write") return !!currentWriteSel();
    var sel = blocksUI.getSelection();
    return !!(sel.range || sel.editing);
  }

  // The scene was renamed elsewhere (scene menu): take the stored title without a second save.
  function renamed(rec){
    if(!scene || !rec || rec.id !== scene.id) return;
    scene = Object.assign({}, scene, { title: rec.title, updatedAt: rec.updatedAt });
    savedTitle = rec.title || "";
    titleEl.value = savedTitle;
  }

  /* ----- Replace (Accept / Restore) and versions ----- */
  async function replaceBlocks(nextBlocks, opts){
    if(!scene) return null;
    blocksUI.commitEditing();
    await flush();
    var target = scene;
    var blocks = Array.isArray(nextBlocks) ? nextBlocks : [];
    var res = await store.saveSceneWithVersion({ id: target.id, blocks: blocks,
      wordCount: countWords(blocksToText(blocks)) }, { reason: (opts && opts.reason) || "edit" });
    if(!res) throw new Error("The scene no longer exists");
    if(scene !== target) return res;
    adopt(res.scene);
    return res;
  }

  async function restore(versionId){
    if(!scene) return;
    try{
      blocksUI.commitEditing();
      await flush();
      var target = scene;
      var res = await store.restoreVersion(versionId);
      if(!res) throw new Error("Version not found");
      if(scene === target) adopt(res.scene);
      toast("Restored · previous text saved as a version");
    }catch(e){
      toast("Could not restore: " + ((e && e.message) || "unknown error"));
    }
  }

  async function saveVersion(){
    if(!scene) return;
    try{
      blocksUI.commitEditing();
      await flush();
      var v = await store.addVersion(scene.id, "manual");
      toast(v ? "Version saved" : "No changes since the last version");
    }catch(e){
      toast("Could not save a version");
    }
  }

  function openVersions(){ return versions.open(); }

  /* ----- AI actions ----- */
  function ask(msg, def){
    var fn = deps.prompt || function(m, d){ return window.prompt(m, d == null ? "" : d); };
    var v = fn(msg, def);
    return v == null ? "" : String(v).trim();
  }

  // Works out what an action applies to, from a selection captured before any await.
  function deriveTarget(act, sel, blocks, opts){
    var isContinue = act === "continue";
    if(sel.write && !(isContinue && opts.atEnd)){
      var ws = sel.write;
      if(mode !== "write" || textEl.value !== ws.raw) return { error: "The text changed. Select the text again." };
      var win = selectionWindow(ws.raw, ws.start, ws.end, 2);
      if(isContinue){
        // blocks is textToBlocks(raw) here, so paraIndex indexes it directly.
        var w3 = insertionWindow(blocks, win.paraIndex, 2);
        return { kind: "insert", afterIndex: win.paraIndex, raw: ws.raw, before: w3.before, after: w3.after };
      }
      return { kind: "write", raw: ws.raw, start: win.start, end: win.end, text: win.text,
        before: win.before, after: win.after };
    }
    if(sel.editing && !(isContinue && opts.atEnd)){
      var ed = sel.editing;
      var idx = -1;
      for(var i = 0; i < blocks.length; i++){ if(blocks[i].id === ed.id){ idx = i; break; } }
      var paras = splitParagraphs(ed.text);
      var k = paras.length;
      var same = idx >= 0 && k > 0 && paras.every(function(p, j){ return blocks[idx + j] && blocks[idx + j].text === p; });
      if(!same) return { error: "The paragraph changed. Select the text again." };
      if(isContinue){
        var w0 = insertionWindow(blocks, idx + k - 1, 2);
        return { kind: "insert", afterIndex: idx + k - 1, before: w0.before, after: w0.after };
      }
      return { kind: "splice", id: ed.id, idx: idx, count: k, value: ed.text, start: ed.start, end: ed.end,
        text: ed.text.slice(ed.start, ed.end),
        before: blocks.slice(Math.max(0, idx - 2), idx).concat([{ text: ed.text.slice(0, ed.start) }]),
        after: [{ text: ed.text.slice(ed.end) }].concat(blocks.slice(idx + k, idx + k + 2)) };
    }
    var r = opts.atEnd ? null : normalizeRange(sel.range, blocks.length);
    if(isContinue){
      var at = r ? r.end : blocks.length - 1;
      var w1 = insertionWindow(blocks, at, 2);
      return { kind: "insert", afterIndex: at, before: w1.before, after: w1.after };
    }
    if(!r) return { error: "Select a paragraph first" };
    var w2 = windowAround(blocks, r, 2);
    return { kind: "range", range: r, text: blocksToText(blocks.slice(r.start, r.end + 1)),
      before: w2.before, after: w2.after };
  }

  // runAction(act, {instruction, tone, atEnd}): rewrite | tighten | expand | tone | custom | continue.
  async function runAction(act, opts){
    opts = opts || {};
    if(!scene || !ACTIONS[act]) return;
    var settings = deps.getSettings ? deps.getSettings() : {};
    if(!settings.apiKey){ toast("Add your OpenRouter key in Settings"); return; }
    // Captured before any await (the tone menu or the prompt can move focus and the selection).
    var sel = mode === "blocks" ? blocksUI.getSelection() : { range: null, editing: null, write: currentWriteSel() };
    if(act !== "continue" && !sel.range && !sel.editing && !sel.write){
      toast(mode === "write" ? "Select some text first" : "Select a paragraph first"); return;
    }

    var tone = opts.tone || "", instruction = opts.instruction || "";
    if(act === "tone" && !tone){
      var picked = await deps.openMenu("Tone", TONES.map(function(t){ return { act: t, label: t }; })
        .concat([{ act: "__custom", label: "Custom…" }]));
      if(!picked) return;
      tone = picked === "__custom" ? ask("Describe the tone") : picked;
      if(!tone) return;
    }
    if(act === "custom" && !instruction){
      instruction = ask("Instruction");
      if(!instruction) return;
    }

    blocksUI.commitEditing();
    await flush();
    if(!scene) return;
    var blocks = draftBlocks();
    var t = deriveTarget(act, sel, blocks, opts);
    if(t.error){ toast(t.error); return; }

    var ctx = { act: act, target: t, tone: tone, instruction: instruction, extra: "",
      sceneId: scene.id, sceneTitle: titleEl.value.trim() || scene.title || "" };
    start(ctx, true);
  }

  function start(ctx, first){
    var a = ACTIONS[ctx.act];
    var settings = deps.getSettings ? deps.getSettings() : {};
    var instruction = [ctx.instruction, ctx.extra].filter(function(s){ return s && s.trim(); }).join("\n");
    var isInsert = ctx.target.kind === "insert";
    var req;
    try{
      req = buildActionRequest({ action: ctx.act, instruction: instruction, tone: ctx.tone,
        target: isInsert ? null : { text: ctx.target.text },
        before: ctx.target.before, after: ctx.target.after,
        sceneTitle: ctx.sceneTitle, bible: deps.getBible ? deps.getBible() : {}, model: settings.model });
    }catch(e){
      if(first){ toast((e && e.message) || "Could not build the request"); return; }
      preview.error((e && e.message) || "Could not build the request");
      return;
    }
    stopJob();
    var my = { controller: new AbortController(), partial: "" };
    job = my;
    preview.open({
      title: a.label + (ctx.act === "tone" && ctx.tone ? " · " + ctx.tone : ""),
      acceptLabel: a.acceptLabel,
      showDiff: !isInsert,
      original: isInsert ? null : ctx.target.text,
      instruction: ctx.extra,
      onAccept: function(text){ accept(ctx, text); },
      onRetry: function(extra){ ctx.extra = extra || ""; start(ctx, false); },
      onStop: function(){ if(job === my) my.controller.abort(); },
      onReject: function(){ if(job === my) stopJob(); preview.close(); }
    });
    deps.callApi({ model: settings.model, messages: req.messages, thinking: ACTION_THINKING,
      signal: my.controller.signal,
      onReasoning: function(){ if(job === my) preview.noteReasoning(); },
      onContent: function(delta, full){
        if(job !== my) return;
        my.partial = full;
        preview.setStreaming(full);
      } })
      .then(function(res){
        if(job !== my) return;
        job = null;
        var raw = (res && res.content) || my.partial || "";
        var cleaned = cleanProse(raw).text;
        var warn = "";
        if(!cleaned) warn = res && res.aborted ? "Stopped before any text arrived. Retry." : "The model returned no text. Retry.";
        else if(looksLikeChat(cleaned, isInsert ? "" : ctx.target.text)) warn = "This looks like a reply, not prose. Retry or accept anyway.";
        else if(res && res.aborted) warn = "Stopped. You can accept the partial text.";
        preview.finish({ text: cleaned, warn: warn });
      })
      .catch(function(e){
        if(job !== my) return;
        job = null;
        preview.error((e && e.message) || "Request failed");
      });
  }

  async function accept(ctx, text){
    preview.close();
    if(!scene || scene.id !== ctx.sceneId) return;
    if(await applyTarget(ctx.target, text, ctx.act)){
      toast(ctx.target.kind === "insert" ? "Inserted · version saved" : "Applied · version saved");
    }
  }

  // Puts text into the scene at a target from deriveTarget (or {kind:"replace"} for the whole scene)
  // and saves it with a version. Resolves true when applied; on a stale target or a failed save it
  // shows a toast and resolves false. Shared by Accept and applyText (chat replies).
  async function applyTarget(t, text, reason){
    if(!scene) return false;
    var writeTarget = t.kind === "write" || (t.kind === "insert" && t.raw != null);
    if(writeTarget && (mode !== "write" || textEl.value !== t.raw)){ toast(STALE); return false; }
    var blocks = draftBlocks(), next;
    if(t.kind === "write"){
      next = textToBlocks(spliceSelection(t.raw, t.start, t.end, text), scene.blocks, uid);
    } else if(t.kind === "insert"){
      next = insertAfter(blocks, t.afterIndex, text, uid);
    } else if(t.kind === "replace"){
      next = textToBlocks(text, [], uid);
    } else if(t.kind === "range"){
      if(blocksToText(blocks.slice(t.range.start, t.range.end + 1)) !== t.text){ toast(STALE); return false; }
      next = applyReplacement(blocks, t.range, text, uid);
    } else {
      var value = spliceSelection(t.value, t.start, t.end, text);
      next = applyReplacement(blocks, { start: t.idx, end: t.idx + t.count - 1 }, value, uid);
    }
    // Write mode re-renders the textarea from the saved blocks: keep the reading position.
    var top = mode === "write" ? textEl.scrollTop : 0;
    try{
      await replaceBlocks(next, { reason: reason });
    }catch(e){
      toast("Could not apply: " + ((e && e.message) || "unknown error"));
      return false;
    }
    blocksUI.clearSelection();
    if(mode === "write"){
      var at = t.kind === "write" ? Math.min(t.start, textEl.value.length) : textEl.selectionEnd;
      try{ textEl.setSelectionRange(at, at); }catch(e2){}
      textEl.scrollTop = top;
      writeSel = null;
      barEl.hidden = true;
    }
    return true;
  }

  // A chat reply into the open scene. how: "selection" (the blocks range, the sentence selection or
  // the Write selection), "append" (after the last paragraph) or "replace" (the whole scene).
  // Resolves true when applied.
  async function applyText(text, how){
    if(!scene) return false;
    var sel = mode === "blocks" ? blocksUI.getSelection() : { range: null, editing: null, write: currentWriteSel() };
    blocksUI.commitEditing();
    await flush();
    if(!scene) return false;
    var blocks = draftBlocks(), t, reason;
    if(how === "selection"){
      t = deriveTarget("rewrite", sel, blocks, {});
      reason = "chat-selection";
    } else if(how === "replace"){
      t = { kind: "replace" };
      reason = "chat-replace";
    } else {
      t = { kind: "insert", afterIndex: blocks.length - 1 };
      reason = "chat-append";
    }
    if(t.error){ toast(t.error); return false; }
    return applyTarget(t, text, reason);
  }

  /* ----- Wiring ----- */
  textEl.addEventListener("input", function(){ wordsSoon(); schedule(); syncWriteBar(); });
  ["select", "keyup", "pointerup", "mouseup", "touchend", "focus", "selectionchange"].forEach(function(ev){
    textEl.addEventListener(ev, syncWriteBar);
  });
  document.addEventListener("selectionchange", syncWriteBar);
  titleEl.addEventListener("input", schedule);
  textEl.addEventListener("blur", function(){ if(dirty()) save(); });
  titleEl.addEventListener("blur", function(){ if(dirty()) save(); });
  titleEl.addEventListener("keydown", function(e){
    if(e.key !== "Enter") return;
    e.preventDefault();
    if(mode === "write") textEl.focus(); else titleEl.blur();
  });
  document.addEventListener("visibilitychange", function(){ if(document.visibilityState === "hidden") flush(); });
  window.addEventListener("pagehide", function(){ flush(); });
  viewEl.setAttribute("data-mode", mode);

  return { open: open, flush: flush, close: close, current: current, setMode: setMode, mode: getMode,
    replaceBlocks: replaceBlocks, runAction: runAction, saveVersion: saveVersion, openVersions: openVersions,
    renamed: renamed, hasSelection: hasSelection, applyText: applyText, selectionInfo: selectionInfo };
}
