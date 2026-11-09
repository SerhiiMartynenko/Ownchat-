// Scene summary sheet: shows the stored digest of one scene, lets the author edit it or regenerate it.
// A hand-edited summary is stored with summaryModel "user" and the hash of the current scene text.
import { blocksToText } from "../scene.js";
import { relTime } from "./common.js";

// deps: {$, store, toast, digest, hashText, flush() -> Promise, onSaved(rec), confirm?(msg)}
export function initSummarySheet(deps){
  var $ = deps.$, store = deps.store, digest = deps.digest, hashText = deps.hashText;
  var overlay = $("summaryOverlay"), titleEl = $("summaryTitle"), statusEl = $("summaryStatus");
  var textEl = $("summaryText"), regenBtn = $("summaryRegenerate"), doneBtn = $("summaryDone");
  var seq = 0;
  var rec = null;          // the stored scene shown
  var baseline = "";       // the summary as filled in, to detect an edit
  var regenerating = false;

  function ask(msg){ return deps.confirm ? deps.confirm(msg) : window.confirm(msg); }
  function isOpen(){ return overlay.classList.contains("open"); }
  function edited(){ return textEl.value.trim() !== baseline.trim(); }

  function statusText(){
    if(!rec) return "";
    if(regenerating || digest.isRunning(rec.id)) return "Summarizing…";
    if(!(rec.summary || "").trim()) return "No summary yet";
    if(hashText(blocksToText(rec.blocks)) !== rec.summaryHash) return "Out of date — the text changed since";
    return "Updated " + relTime(rec.summaryUpdatedAt) + (rec.summaryModel === "user" ? " · by you" : "");
  }
  function showStatus(){
    statusEl.textContent = statusText();
    regenBtn.disabled = regenerating;
  }
  function fill(next, keepEdit){
    rec = next;
    titleEl.textContent = next.title ? "Summary · " + next.title : "Scene summary";
    if(!(keepEdit && edited())){
      baseline = next.summary || "";
      textEl.value = baseline;
    }
    showStatus();
  }

  async function open(scene){
    if(!scene || !scene.id) return;
    var my = ++seq;
    regenerating = false;
    try{ if(deps.flush) await deps.flush(); }catch(e){}
    var s = await store.getScene(scene.id);
    if(my !== seq) return;
    if(!s){ deps.toast("Scene not found"); return; }
    fill(s, false);
    overlay.classList.add("open");
  }

  // A newer record for the shown scene (digest finished, or saved elsewhere); a pending edit is kept.
  // Without a record only the status line is redrawn (the digest started or stopped).
  function refresh(next){
    if(!isOpen() || !rec) return;
    if(!next){ showStatus(); return; }
    if(next.id !== rec.id) return;
    store.getScene(next.id).then(function(s){
      if(!isOpen() || !rec || !s || s.id !== rec.id) return;
      fill(s, true);
    }, function(){});
  }

  async function regenerate(){
    if(!rec || regenerating) return;
    if(edited() && !ask("Replace your edit with a new summary?")) return;
    var my = seq, id = rec.id;
    regenerating = true;
    showStatus();
    try{
      if(deps.flush) await deps.flush();
      await digest.summarizeNow(id, { force: true });
      var s = await store.getScene(id);
      if(my !== seq) return;
      regenerating = false;
      if(s) fill(s, false);
      else showStatus();
    }catch(e){
      if(my === seq){ regenerating = false; showStatus(); }
    }
  }

  async function save(){
    if(!rec || !edited()) return;
    var id = rec.id, summary = textEl.value.trim();
    try{
      var cur = await store.getScene(id);
      if(!cur) return;
      var saved = await store.patchScene(id, { summary: summary, summaryHash: hashText(blocksToText(cur.blocks)),
        summaryUpdatedAt: Date.now(), summaryModel: "user" });
      if(saved && deps.onSaved) deps.onSaved(saved);
    }catch(e){
      deps.toast("Could not save the summary");
    }
  }

  function close(){
    if(!isOpen()) return;
    var p = save();
    seq++;
    regenerating = false;
    overlay.classList.remove("open");
    rec = null;
    return p;
  }

  regenBtn.addEventListener("click", regenerate);
  doneBtn.addEventListener("click", close);
  overlay.addEventListener("click", function(e){ if(e.target === overlay) close(); });

  return { open: open, close: close, refresh: refresh, isOpen: isOpen };
}
