// Story bible sheet and card editor (DOM). State lives in main.js; this module reads it via getBible()
// and hands new bibles back via setBible(), then calls onChange() to persist and refresh.
import { CARD_TYPES, normalizeBible, newCard, upsertCard, deleteCard, togglePin, parseAliases } from "../bible.js";

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
  var editingCreatedAt = 0;

  function commit(next){ deps.setBible(next); deps.onChange(); }

  function setSeg(seg, v){
    seg.querySelectorAll("button").forEach(function(b){ b.classList.toggle("on", b.getAttribute("data-v") === v); });
  }
  function segValue(seg){
    var on = seg.querySelector("button.on");
    return on ? on.getAttribute("data-v") : "";
  }

  /* ----- Bible sheet ----- */
  function renderCards(){
    var bible = deps.getBible();
    var cards = bible.cards || [];
    els.cards.innerHTML = "";
    els.empty.hidden = cards.length > 0;
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
    editingCreatedAt = existing ? existing.createdAt : 0;
    els.cardTitle.textContent = existing ? "Edit card" : "New card";
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
    if(els.overlay.classList.contains("open")) renderCards();
  }
  function saveCard(){
    var name = els.cardName.value.trim();
    if(!name){ deps.toast("Name required"); els.cardName.focus(); return; }
    var card = newCard({
      id: editingId || undefined,
      type: segValue(els.cardType) || "character",
      name: name,
      aliases: parseAliases(els.cardAliases.value),
      body: els.cardBody.value,
      pinned: segValue(els.cardPin) === "always"
    }, deps.uid);
    if(editingId && editingCreatedAt) card.createdAt = editingCreatedAt;
    commit(upsertCard(deps.getBible(), card));
    deps.toast(editingId ? "Card saved" : "Card added");
    closeCardEditor();
  }
  function removeCard(){
    if(!editingId) return;
    if(!window.confirm("Delete this card?")) return;
    commit(deleteCard(deps.getBible(), editingId));
    deps.toast("Card deleted");
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

  api = { openBible: openBible, openCardEditor: openCardEditor, closeBible: closeBible };
  return api;
}

export function openBible(){ if(api) api.openBible(); }
export function openCardEditor(prefill){ if(api) api.openCardEditor(prefill); }
