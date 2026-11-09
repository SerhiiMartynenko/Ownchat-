// Scene editor: one draft of blocks edited through either the blocks surface (ui/blocks.js, tap to edit,
// select for AI actions) or the plain "Write" textarea, with autosave and a live word count.
// Autosave: 700 ms after the last edit, at most every 5 s while typing, and on blur, page hide,
// tab hide and route changes (flush). Unchanged text is not saved; one save runs at a time and the
// latest text wins. AI actions open the preview sheet; Accept and Restore save through
// store.saveSceneWithVersion so the replaced text is kept as a version.
import { textToBlocks, blocksToText, countWords, splitParagraphs } from "../scene.js";
import { applyReplacement, insertAfter, spliceSelection, windowAround, insertionWindow, normalizeRange } from "../editor.js";
import { ACTIONS, TONES, buildActionRequest, cleanProse, looksLikeChat } from "../rewrite.js";
import { initBlocks } from "./blocks.js";
import { initPreview } from "./preview.js";
import { initVersions } from "./versions.js";

var DEBOUNCE_MS = 700;
var MAX_WAIT_MS = 5000;
var MODES = ["blocks", "write"];

export function initSceneEditor(deps){
  var $ = deps.$, store = deps.store, toast = deps.toast, uid = deps.uid;
  var viewEl = $("viewScene");
  var titleEl = $("sceneTitle"), textEl = $("sceneText"), wordsEl = $("sceneWords"), savedEl = $("sceneSaved");
  var scene = null;            // the stored record being edited
  var savedText = "", savedTitle = "";
  var mode = MODES.indexOf(viewEl.getAttribute("data-mode")) >= 0 ? viewEl.getAttribute("data-mode") : "blocks";
  var timer = null, maxTimer = null, inflight = null, again = false, wordsRaf = 0;
  var job = null;              // running AI request {controller, partial}

  var blocksUI = initBlocks({ listEl: $("blockList"), barEl: $("blockBar"), uid: uid,
    onChange: function(){ wordsSoon(); schedule(); },
    onInput: function(){ wordsSoon(); schedule(); },
    onAction: function(act){ runAction(act); },
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
    if(!dirty()){ setStatus("Saved"); return Promise.resolve(); }
    var target = scene, title = titleEl.value;
    var blocks = draftBlocks(), text = blocksToText(blocks);
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
        if(scene) setStatus(dirty() ? "Edited" : "Saved");
      });
    return inflight;
  }

  /* ----- Surfaces ----- */
  function renderSurface(blocks){
    if(mode === "write"){
      textEl.value = blocksToText(blocks);
      textEl.scrollTop = 0;
    } else {
      blocksUI.render(blocks);
    }
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
    return p.then(function(){ scene = null; });
  }
  function current(){ return scene; }

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
    if(mode !== "blocks" && act !== "continue"){ toast("Switch to Blocks to select text"); return; }
    var sel = mode === "blocks" ? blocksUI.getSelection() : { range: null, editing: null };
    if(act !== "continue" && !sel.range && !sel.editing){ toast("Select a paragraph first"); return; }

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
    deps.callApi({ model: settings.model, messages: req.messages, thinking: settings.thinking,
      signal: my.controller.signal,
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
    if(!scene || scene.id !== ctx.sceneId){ preview.close(); return; }
    var blocks = draftBlocks();
    var t = ctx.target, next;
    if(t.kind === "insert"){
      next = insertAfter(blocks, t.afterIndex, text, uid);
    } else if(t.kind === "range"){
      if(blocksToText(blocks.slice(t.range.start, t.range.end + 1)) !== t.text){
        toast("The text changed. Run the action again."); preview.close(); return;
      }
      next = applyReplacement(blocks, t.range, text, uid);
    } else {
      var value = spliceSelection(t.value, t.start, t.end, text);
      next = applyReplacement(blocks, { start: t.idx, end: t.idx + t.count - 1 }, value, uid);
    }
    preview.close();
    try{
      await replaceBlocks(next, { reason: ctx.act });
      blocksUI.clearSelection();
      toast(t.kind === "insert" ? "Inserted · version saved" : "Applied · version saved");
    }catch(e){
      toast("Could not apply: " + ((e && e.message) || "unknown error"));
    }
  }

  /* ----- Wiring ----- */
  textEl.addEventListener("input", function(){ wordsSoon(); schedule(); });
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
    renamed: renamed };
}
