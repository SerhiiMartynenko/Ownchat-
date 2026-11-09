// Scene editor: a plain textarea with autosave and a live word count.
// Autosave: 700 ms after the last edit, at most every 5 s while typing, and on blur, page hide,
// tab hide and route changes (flush). Unchanged text is not saved; one save runs at a time and the
// latest text wins.
import { textToBlocks, blocksToText, countWords } from "../scene.js";

var DEBOUNCE_MS = 700;
var MAX_WAIT_MS = 5000;

export function initSceneEditor(deps){
  var $ = deps.$, store = deps.store, toast = deps.toast;
  var titleEl = $("sceneTitle"), textEl = $("sceneText"), wordsEl = $("sceneWords"), savedEl = $("sceneSaved");
  var scene = null;            // the stored record being edited
  var savedText = "", savedTitle = "";
  var timer = null, maxTimer = null, inflight = null, again = false, wordsRaf = 0;

  function setStatus(s){ savedEl.textContent = s; savedEl.setAttribute("data-state", s === "Saved" ? "saved" : s === "Edited" ? "edited" : "saving"); }
  function dirty(){ return !!scene && (textEl.value !== savedText || titleEl.value !== savedTitle); }
  function showWords(){
    var n = countWords(textEl.value);
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
    var target = scene, text = textEl.value, title = titleEl.value;
    var blocks = textToBlocks(text, target.blocks, deps.uid);
    setStatus("Saving…");
    inflight = store.saveScene({ id: target.id, title: title.trim() || "Untitled scene", blocks: blocks, wordCount: countWords(text) })
      .then(function(rec){
        if(scene !== target) return;          // another scene was opened meanwhile
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

  // Loads a scene into the editor (saving the previous one first). Resolves with the scene or null.
  async function open(sceneId){
    await flush();
    var s = await store.getScene(sceneId);
    if(!s) return null;
    scene = s;
    savedTitle = s.title || "";
    savedText = blocksToText(s.blocks);
    titleEl.value = savedTitle;
    textEl.value = savedText;
    textEl.scrollTop = 0;
    showWords();
    setStatus("Saved");
    try{ await store.setLastScene(s.projectId, s.id); }catch(e){}
    if(deps.onOpened) deps.onOpened(s);
    return s;
  }

  function flush(){ return save(); }
  function close(){ var p = flush(); return p.then(function(){ scene = null; }); }
  function current(){ return scene; }

  textEl.addEventListener("input", function(){ wordsSoon(); schedule(); });
  titleEl.addEventListener("input", schedule);
  textEl.addEventListener("blur", function(){ if(dirty()) save(); });
  titleEl.addEventListener("blur", function(){ if(dirty()) save(); });
  titleEl.addEventListener("keydown", function(e){ if(e.key === "Enter"){ e.preventDefault(); textEl.focus(); } });
  document.addEventListener("visibilitychange", function(){ if(document.visibilityState === "hidden") flush(); });
  window.addEventListener("pagehide", function(){ flush(); });

  return { open: open, flush: flush, close: close, current: current };
}
