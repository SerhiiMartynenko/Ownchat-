// Versions sheet: the scene's saved versions, newest first. Tapping one opens the preview sheet in
// restore mode (diff of the version against the current text); Restore puts it back.
import { blocksToText } from "../scene.js";

var REASONS = {
  rewrite: "Before Rewrite", tighten: "Before Tighten", expand: "Before Expand", tone: "Before Tone",
  custom: "Before Custom", continue: "Before Continue", manual: "Saved manually",
  restore: "Before a restore", edit: "Before an edit"
};

function when(t){
  if(!t) return "";
  var d = new Date(t);
  try{
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }catch(e){ return d.toLocaleString(); }
}

// deps: {$, store, toast, preview, getScene(), getCurrentText(), beforeOpen() -> Promise, restore(versionId) -> Promise}
export function initVersions(deps){
  var $ = deps.$, store = deps.store;
  var overlay = $("versionsOverlay"), listEl = $("versionList"), emptyEl = $("versionsEmpty");
  var seq = 0;

  function row(v){
    var b = document.createElement("button");
    b.type = "button";
    b.className = "version-row";
    b.setAttribute("data-id", v.id);
    var w = document.createElement("span"); w.className = "version-when"; w.textContent = when(v.createdAt);
    var r = document.createElement("span"); r.className = "version-reason"; r.textContent = REASONS[v.reason] || v.reason || "Version";
    var n = Number(v.wordCount) || 0;
    var c = document.createElement("span"); c.className = "version-words"; c.textContent = n.toLocaleString() + (n === 1 ? " word" : " words");
    b.appendChild(w); b.appendChild(r); b.appendChild(c);
    b.addEventListener("click", function(){ preview(v); });
    return b;
  }

  async function open(){
    var my = ++seq;
    if(deps.beforeOpen) await deps.beforeOpen();
    var scene = deps.getScene();
    if(!scene || my !== seq) return;
    var list = [];
    try{ list = await store.listVersions(scene.id); }
    catch(e){ deps.toast("Could not load versions"); return; }
    if(my !== seq) return;
    listEl.textContent = "";
    list.forEach(function(v){ listEl.appendChild(row(v)); });
    emptyEl.hidden = list.length > 0;
    overlay.classList.add("open");
  }

  function close(){ seq++; overlay.classList.remove("open"); }
  function isOpen(){ return overlay.classList.contains("open"); }

  function preview(v){
    var p = deps.preview;
    p.open({
      title: "Version · " + when(v.createdAt),
      acceptLabel: "Restore",
      showDiff: true,
      original: deps.getCurrentText(),
      onAccept: function(){
        p.close();
        close();
        deps.restore(v.id);
      },
      onReject: function(){ p.close(); }
    });
    p.finish({ text: blocksToText(v.blocks) });
  }

  $("versionsClose").addEventListener("click", close);
  overlay.addEventListener("click", function(e){ if(e.target === overlay) close(); });

  return { open: open, close: close, isOpen: isOpen };
}
