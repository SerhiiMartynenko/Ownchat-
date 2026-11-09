// Story bible sheet and card editor (DOM). State lives in main.js; this module reads it via getBible()
// and hands new bibles back via setBible(), then calls onChange() to persist and refresh.
import { CARD_TYPES, normalizeBible, newCard, upsertCard, deleteCard, togglePin, parseAliases, acceptCard, listProposed } from "../bible.js";

var TYPE_HEADINGS = { character:"Characters", place:"Places", thread:"Threads", note:"Notes" };
var TYPE_SHORT = { character:"Char", place:"Place", thread:"Thread", note:"Note" };
var PIN_ICON = '<svg class="ic" viewBox="0 0 24 24"><path d="M12 17v5M9 3h6l-1 7 3 3H7l3-3z"/></svg>';

var api = null;   // set by initBibleUI

export function initBibleUI(deps){
  var $ = deps.$;
  var els = {
    overlay: $("bibleOverlay"), brief: $("bibleBrief"), style: $("bibleStyle"),
    addCard: $("bibleAddCard"), cards: $("bibleCards"), empty: $("bibleEmpty"), done: $("bibleDone"),
    cardOverlay: $("cardOverlay"), cardTitle: $("cardTitle"), cardType: $("cardType"),
    cardName: $("cardName"), cardAliases: $("cardAliases"), cardBody: $("cardBody"),
    cardPin: $("cardPin"), cardDelete: $("cardDelete"), cardCancel: $("cardCancel"), cardSave: $("cardSave")
  };
  var editingId = null;     // id of the card being edited, null for a new card
  var editing = null;       // the stored card being edited (keeps status, source, createdAt)

  function commit(next){ deps.setBible(next); deps.onChange(); }

  function setSeg(seg, v){
    seg.querySelectorAll("button").forEach(function(b){ b.classList.toggle("on", b.getAttribute("data-v") === v); });
  }
  function segValue(seg){
    var on = seg.querySelector("button.on");
    return on ? on.getAttribute("data-v") : "";
  }

  /* ----- Bible sheet ----- */
  function sourceText(card){
    var src = card.source;
    if(src && src.kind === "scene") return "from scene \u201c" + (src.sceneTitle || "Untitled scene") + "\u201d";
    if(src && src.kind === "chat") return "from chat";
    return "";
  }
  function proposedRow(card){
    var row = document.createElement("div");
    row.className = "card-row proposed";
    row.setAttribute("role", "button"); row.setAttribute("tabindex", "0"); row.setAttribute("data-id", card.id);
    row.innerHTML = '<span class="card-type"></span>' +
      '<span class="card-main"><span class="card-name"></span><span class="card-source"></span></span>' +
      '<span class="card-acts"><button type="button" class="card-act accept">Accept</button>' +
      '<button type="button" class="card-act dismiss">Dismiss</button></span>';
    row.querySelector(".card-type").textContent = TYPE_SHORT[card.type] || "Note";
    row.querySelector(".card-name").textContent = card.name;
    var src = row.querySelector(".card-source"), st = sourceText(card);
    if(st) src.textContent = st; else src.remove();
    row.querySelector(".card-act.accept").addEventListener("click", function(e){
      e.stopPropagation();
      commit(acceptCard(deps.getBible(), card.id));
      deps.toast("Card accepted");
      renderCards();
    });
    row.querySelector(".card-act.dismiss").addEventListener("click", function(e){
      e.stopPropagation();
      commit(deleteCard(deps.getBible(), card.id));
      deps.toast("Dismissed");
      renderCards();
    });
    row.addEventListener("click", function(){ openCardEditor(card); });
    row.addEventListener("keydown", function(e){
      if(e.target !== row) return;
      if(e.key === "Enter" || e.key === " "){ e.preventDefault(); openCardEditor(card); }
    });
    return row;
  }

  function renderCards(){
    var bible = deps.getBible();
    var all = bible.cards || [];
    var proposed = listProposed(bible);
    var cards = all.filter(function(c){ return c.status === "approved"; });
    els.cards.innerHTML = "";
    els.empty.hidden = cards.length + proposed.length > 0;
    if(proposed.length){
      var pw = document.createElement("div");
      pw.className = "card-group proposed";
      var ph = document.createElement("h4");
      ph.className = "card-group-title"; ph.textContent = "Proposed";
      pw.appendChild(ph);
      proposed.forEach(function(card){ pw.appendChild(proposedRow(card)); });
      els.cards.appendChild(pw);
    }
    CARD_TYPES.forEach(function(type){
      var group = cards.filter(function(c){ return c.type === type; })
        .sort(function(a, b){ return a.name.localeCompare(b.name); });
      if(!group.length) return;
      var wrap = document.createElement("div");
      wrap.className = "card-group";
      var h = document.createElement("h4");
      h.className = "card-group-title"; h.textContent = TYPE_HEADINGS[type];
      wrap.appendChild(h);
      group.forEach(function(card){
        var row = document.createElement("button");
        row.type = "button"; row.className = "card-row"; row.setAttribute("data-id", card.id);
        row.innerHTML = '<span class="card-type"></span>' +
          '<span class="card-main"><span class="card-name"></span><span class="card-aliases"></span></span>' +
          '<span class="card-pin" role="button" tabindex="0">' + PIN_ICON + '</span>';
        row.querySelector(".card-type").textContent = TYPE_SHORT[type];
        row.querySelector(".card-name").textContent = card.name;
        var al = row.querySelector(".card-aliases");
        if(card.aliases && card.aliases.length) al.textContent = card.aliases.join(", ");
        else al.remove();
        var pin = row.querySelector(".card-pin");
        pin.classList.toggle("on", !!card.pinned);
        pin.setAttribute("aria-pressed", card.pinned ? "true" : "false");
        pin.setAttribute("aria-label", card.pinned ? "Always included; tap to include on mention only" : "Included on mention; tap to always include");
        function onPin(e){
          e.stopPropagation(); e.preventDefault();
          commit(togglePin(deps.getBible(), card.id));
          renderCards();
        }
        pin.addEventListener("click", onPin);
        pin.addEventListener("keydown", function(e){ if(e.key === "Enter" || e.key === " ") onPin(e); });
        row.addEventListener("click", function(){ openCardEditor(card); });
        wrap.appendChild(row);
      });
      els.cards.appendChild(wrap);
    });
  }

  function openBible(){
    var bible = deps.getBible();
    els.brief.value = bible.brief || "";
    els.style.value = bible.styleGuide || "";
    renderCards();
    els.overlay.classList.add("open");
  }
  function saveTexts(){
    var bible = deps.getBible();
    if(els.brief.value === (bible.brief || "") && els.style.value === (bible.styleGuide || "")) return;
    commit(normalizeBible(Object.assign({}, bible, {
      brief: els.brief.value, styleGuide: els.style.value, updatedAt: Date.now()
    })));
  }
  function closeBible(){
    saveTexts();
    els.overlay.classList.remove("open");
  }

  /* ----- Card editor ----- */
  function openCardEditor(prefill){
    var p = prefill || {};
    var bible = deps.getBible();
    var existing = p.id ? (bible.cards || []).find(function(c){ return c.id === p.id; }) : null;
    editingId = existing ? existing.id : null;
    editing = existing || null;
    var isProposed = !!existing && existing.status === "proposed";
    els.cardTitle.textContent = isProposed ? "Proposed card" : existing ? "Edit card" : "New card";
    els.cardSave.textContent = isProposed ? "Accept" : "Save";
    els.cardDelete.textContent = isProposed ? "Dismiss" : "Delete";
    setSeg(els.cardType, CARD_TYPES.indexOf(p.type) >= 0 ? p.type : "character");
    els.cardName.value = p.name || "";
    els.cardAliases.value = Array.isArray(p.aliases) ? p.aliases.join(", ") : (p.aliases || "");
    els.cardBody.value = p.body || "";
    setSeg(els.cardPin, p.pinned ? "always" : "mention");
    els.cardDelete.hidden = !existing;
    els.cardOverlay.classList.add("open");
  }
  function closeCardEditor(){
    els.cardOverlay.classList.remove("open");
    editingId = null;
    editing = null;
    if(els.overlay.classList.contains("open")) renderCards();
  }
  function saveCard(){
    var name = els.cardName.value.trim();
    if(!name){ deps.toast("Name required"); els.cardName.focus(); return; }
    var prev = editingId ? editing : null;
    var wasProposed = !!prev && prev.status === "proposed";
    var card = newCard({
      id: editingId || undefined,
      type: segValue(els.cardType) || "character",
      name: name,
      aliases: parseAliases(els.cardAliases.value),
      body: els.cardBody.value,
      pinned: segValue(els.cardPin) === "always",
      status: wasProposed ? "approved" : (prev && prev.status) || "approved",
      source: prev ? prev.source : null
    }, deps.uid);
    if(prev && prev.createdAt) card.createdAt = prev.createdAt;
    commit(upsertCard(deps.getBible(), card));
    deps.toast(wasProposed ? "Card accepted" : editingId ? "Card saved" : "Card added");
    closeCardEditor();
  }
  function removeCard(){
    if(!editingId) return;
    var dismiss = !!editing && editing.status === "proposed";
    if(!dismiss && !window.confirm("Delete this card?")) return;
    commit(deleteCard(deps.getBible(), editingId));
    deps.toast(dismiss ? "Dismissed" : "Card deleted");
    closeCardEditor();
  }

  [els.cardType, els.cardPin].forEach(function(seg){
    seg.querySelectorAll("button").forEach(function(b){
      b.addEventListener("click", function(){ setSeg(seg, b.getAttribute("data-v")); });
    });
  });
  $("openBible").addEventListener("click", openBible);
  els.done.addEventListener("click", closeBible);
  els.overlay.addEventListener("click", function(e){ if(e.target === els.overlay) closeBible(); });
  els.addCard.addEventListener("click", function(){ openCardEditor({ type:"character", pinned:false }); });
  els.cardSave.addEventListener("click", saveCard);
  els.cardCancel.addEventListener("click", closeCardEditor);
  els.cardDelete.addEventListener("click", removeCard);
  els.cardOverlay.addEventListener("click", function(e){ if(e.target === els.cardOverlay) closeCardEditor(); });

  // Re-render after the bible changed elsewhere (digest, fold); the open card editor is left alone.
  function refresh(){ if(els.overlay.classList.contains("open")) renderCards(); }
  function hasProposed(){ return listProposed(deps.getBible()).length > 0; }

  api = { openBible: openBible, openCardEditor: openCardEditor, closeBible: closeBible, refresh: refresh, hasProposed: hasProposed };
  return api;
}

export function openBible(){ if(api) api.openBible(); }
export function openCardEditor(prefill){ if(api) api.openCardEditor(prefill); }
