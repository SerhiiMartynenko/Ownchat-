// Preview sheet for AI actions and version restores: streams the model's text, then shows a word diff
// against the original (or the clean text) with Accept / Retry / Reject / Stop. Model output only ever
// reaches the DOM through textContent and text nodes.
import { diffWords } from "../diff.js";
import { countWords } from "../scene.js";

export function initPreview(deps){
  var $ = deps.$;
  var els = {
    overlay: $("previewOverlay"), title: $("previewTitle"), stats: $("previewStats"),
    toggle: $("previewDiffToggle"), body: $("previewBody"), warn: $("previewWarn"),
    instruction: $("previewInstruction"), reject: $("previewReject"), retry: $("previewRetry"),
    stop: $("previewStop"), accept: $("previewAccept")
  };
  var cur = null;    // {o, text, streaming, diff, reasoning}
  var raf = 0;
  var startedAt = 0;
  var ticker = 0;    // interval that shows progress while waiting for the first words

  function stopTicker(){ if(ticker){ clearInterval(ticker); ticker = 0; } }
  function tick(){
    if(!cur || !cur.streaming || cur.text) return;
    var secs = Math.floor((Date.now() - startedAt) / 1000);
    els.stats.textContent = secs < 1 ? "" : (cur.reasoning ? "Thinking… " : "Waiting for the model… ") + secs + "s";
  }

  function setWarn(msg){ els.warn.textContent = msg || ""; els.warn.hidden = !msg; }

  function words(n){ return n.toLocaleString() + (n === 1 ? " word" : " words"); }
  function renderStats(){
    if(!cur || cur.streaming){ els.stats.textContent = cur && cur.text ? "+ " + words(countWords(cur.text)) : ""; return; }
    var after = countWords(cur.text);
    if(cur.o.original == null || cur.o.stats === "added") els.stats.textContent = "+ " + words(after);
    else els.stats.textContent = countWords(cur.o.original).toLocaleString() + " → " + words(after);
  }

  function renderBody(){
    if(!cur) return;
    var body = els.body;
    body.textContent = "";
    if(cur.streaming){
      body.appendChild(document.createTextNode(cur.text));
      var caret = document.createElement("span");
      caret.className = "caret";
      body.appendChild(caret);
    } else if(cur.diff && cur.o.original != null){
      diffWords(cur.o.original, cur.text).forEach(function(op){
        if(op.type === "eq"){ body.appendChild(document.createTextNode(op.text)); return; }
        var span = document.createElement("span");
        span.className = op.type === "ins" ? "ins" : "del";
        span.textContent = op.text;
        body.appendChild(span);
      });
    } else {
      body.textContent = cur.text;
    }
    renderStats();
  }

  function syncButtons(){
    var streaming = !!(cur && cur.streaming);
    els.stop.hidden = !streaming;
    els.accept.disabled = streaming || !(cur && cur.text && cur.text.trim());
    var canRetry = !!(cur && cur.o.onRetry);
    els.retry.hidden = !canRetry;
    els.instruction.hidden = !canRetry;
    els.toggle.hidden = !(cur && cur.o.showDiff && !streaming && cur.text && cur.text.trim());
    els.toggle.textContent = cur && cur.diff ? "Clean" : "Diff";
  }

  // o: {title, acceptLabel, showDiff, original, stats, instruction, onAccept(text), onRetry(extra),
  // onStop(), onReject()}. Opens (or restarts) the sheet in the streaming state.
  function open(o){
    if(raf){ cancelAnimationFrame(raf); raf = 0; }
    stopTicker();
    cur = { o: o || {}, text: "", streaming: true, diff: !!(o && o.showDiff), reasoning: false };
    startedAt = Date.now();
    els.title.textContent = cur.o.title || "Preview";
    els.accept.textContent = cur.o.acceptLabel || "Accept";
    if(cur.o.instruction != null) els.instruction.value = cur.o.instruction;
    setWarn("");
    renderBody();
    syncButtons();
    els.overlay.classList.add("open");
    ticker = setInterval(tick, 250);
  }

  // The model is reasoning before it writes: the waiting line says so.
  function noteReasoning(){
    if(!cur || !cur.streaming) return;
    cur.reasoning = true;
    if(!cur.text) tick();
  }

  function setStreaming(text){
    if(!cur || !cur.streaming) return;
    cur.text = String(text || "");
    if(raf) return;
    raf = requestAnimationFrame(function(){
      raf = 0;
      if(!cur || !cur.streaming) return;
      renderBody();
      els.body.scrollTop = els.body.scrollHeight;
    });
  }

  function finish(r){
    if(!cur) return;
    if(raf){ cancelAnimationFrame(raf); raf = 0; }
    stopTicker();
    cur.streaming = false;
    cur.text = String((r && r.text) || "");
    // Nothing arrived: show an empty body (not the original crossed out) next to the warning.
    if(!cur.text.trim()) cur.diff = false;
    setWarn(r && r.warn);
    renderBody();
    els.body.scrollTop = 0;
    syncButtons();
  }

  function error(msg){
    if(!cur) return;
    if(raf){ cancelAnimationFrame(raf); raf = 0; }
    stopTicker();
    cur.streaming = false;
    cur.text = "";
    cur.diff = false;
    els.body.textContent = "";
    renderStats();
    setWarn(msg || "Something went wrong.");
    syncButtons();
  }

  function close(){
    if(raf){ cancelAnimationFrame(raf); raf = 0; }
    stopTicker();
    cur = null;
    els.overlay.classList.remove("open");
    els.instruction.blur();
  }

  function isOpen(){ return !!cur; }

  function reject(){
    if(!cur) return;
    var o = cur.o;
    if(o.onReject) o.onReject(); else close();
  }

  els.toggle.addEventListener("click", function(){
    if(!cur || cur.streaming) return;
    cur.diff = !cur.diff;
    renderBody();
    syncButtons();
  });
  els.stop.addEventListener("click", function(){ if(cur && cur.streaming && cur.o.onStop) cur.o.onStop(); });
  els.accept.addEventListener("click", function(){
    if(!cur || cur.streaming || !cur.text.trim()) return;
    if(cur.o.onAccept) cur.o.onAccept(cur.text);
  });
  els.retry.addEventListener("click", function(){
    if(cur && cur.o.onRetry) cur.o.onRetry(els.instruction.value.trim());
  });
  els.reject.addEventListener("click", reject);
  els.overlay.addEventListener("click", function(e){ if(e.target === els.overlay) reject(); });
  els.instruction.addEventListener("keydown", function(e){
    if(e.key === "Enter"){ e.preventDefault(); els.retry.click(); }
  });

  return { open: open, setStreaming: setStreaming, finish: finish, error: error, close: close, isOpen: isOpen,
    noteReasoning: noteReasoning };
}
