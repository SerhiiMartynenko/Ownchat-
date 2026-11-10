// Blocks surface: the scene as a list of paragraph rows. Tap a paragraph to edit it in place; tap its
// handle (or long-press the row) to select a contiguous range for AI actions. The array of blocks held
// here is the draft while the scene view is in blocks mode; ui/scene.js owns saving.
import { commitEdit, toggleInRange, normalizeRange } from "../editor.js";
import { blocksToText } from "../scene.js";

var LONG_PRESS_MS = 450;
var MOVE_TOLERANCE_PX = 8;

export function initBlocks(opts){
  var listEl = opts.listEl, barEl = opts.barEl, uid = opts.uid;
  var footer = listEl.querySelector(".block-footer");
  var hint = footer ? footer.querySelector(".block-hint") : null;
  var blocks = [];
  var range = null;          // {start, end} indices into blocks, or null
  var editing = null;        // {id, row, ta}
  var press = null;          // long-press tracking {timer, x, y, row}
  var suppressClick = false; // the click after a long-press must not edit or toggle again
  var barPressing = false;   // a bar button is being pressed: keep the editing textarea and its selection
  var barSnapshot = null;    // editing selection captured when a bar button was pressed

  /* ----- DOM ----- */
  function makeRow(b){
    var row = document.createElement("div");
    row.className = "block";
    row.setAttribute("data-id", b.id);
    var text = document.createElement("div");
    text.className = "block-text";
    text.textContent = b.text;
    var handle = document.createElement("button");
    handle.type = "button";
    handle.className = "block-handle";
    handle.setAttribute("aria-label", "Select paragraph");
    row.appendChild(text);
    row.appendChild(handle);
    return row;
  }
  function rows(){ return Array.prototype.slice.call(listEl.querySelectorAll(".block")); }
  function indexOfId(id){
    for(var i = 0; i < blocks.length; i++){ if(blocks[i].id === id) return i; }
    return -1;
  }
  function updateHint(){ if(hint) hint.hidden = blocks.length > 0; }

  function render(next){
    var top = listEl.scrollTop;
    editing = null; range = null; barSnapshot = null;
    blocks = (Array.isArray(next) ? next : []).map(function(b){ return { id: String(b.id), text: String(b.text == null ? "" : b.text) }; });
    rows().forEach(function(r){ r.remove(); });
    var frag = document.createDocumentFragment();
    blocks.forEach(function(b){ frag.appendChild(makeRow(b)); });
    listEl.insertBefore(frag, footer);
    updateHint();
    paint();
    listEl.scrollTop = top;
  }

  /* ----- Selection ----- */
  function editSelection(){
    if(!editing) return null;
    var ta = editing.ta, s = ta.selectionStart, e = ta.selectionEnd;
    if(typeof s !== "number" || s === e) return null;
    return { id: editing.id, start: s, end: e, text: ta.value, selected: ta.value.slice(s, e) };
  }
  function paint(){
    var r = normalizeRange(range, blocks.length);
    range = r;
    rows().forEach(function(row, i){ row.classList.toggle("selected", !!r && i >= r.start && i <= r.end); });
    updateBar();
    if(opts.onSelect) opts.onSelect();
  }
  // In Write mode ui/scene.js owns the bar (it follows the textarea selection), so the blocks state
  // (a range left over from blocks mode, a paint after Accept) must not show or hide it then.
  function updateBar(){
    if(opts.ownsBar && opts.ownsBar()) return;
    barEl.hidden = !(range || editSelection() || (barPressing && barSnapshot));
  }
  function toggleIndex(i){
    range = toggleInRange(range, i);
    paint();
  }
  function clearSelection(){
    range = null; barSnapshot = null;
    if(editing){
      var ta = editing.ta;
      if(ta.selectionStart !== ta.selectionEnd) ta.setSelectionRange(ta.selectionEnd, ta.selectionEnd);
    }
    paint();
  }
  function getSelection(){
    var ed = editSelection();
    if(!ed && barSnapshot && editing && barSnapshot.id === editing.id) ed = barSnapshot;
    return { range: range ? { start: range.start, end: range.end } : null, editing: ed,
      editingId: editing ? editing.id : null };
  }

  /* ----- Editing ----- */
  function grow(ta){ ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; }

  function startEdit(row){
    var i = indexOfId(row.getAttribute("data-id"));
    if(i < 0) return;
    var ta = document.createElement("textarea");
    ta.className = "block-edit";
    ta.rows = 1;
    ta.value = blocks[i].text;
    ta.setAttribute("aria-label", "Paragraph");
    row.insertBefore(ta, row.querySelector(".block-handle"));
    row.classList.add("editing");
    editing = { id: blocks[i].id, row: row, ta: ta };
    ta.addEventListener("input", function(){ grow(ta); if(opts.onInput) opts.onInput(); });
    ta.addEventListener("blur", function(){
      if(barPressing) return;
      if(editing && editing.ta === ta) commitEditing();
    });
    ta.addEventListener("keydown", function(e){ if(e.key === "Escape"){ e.preventDefault(); ta.blur(); } });
    grow(ta);
    // Focus inside the tap handler so iOS shows the keyboard.
    ta.focus();
    var n = ta.value.length;
    try{ ta.setSelectionRange(n, n); }catch(e){}
    updateBar();
  }

  // Ends in-place editing: the textarea's text replaces the block (split on blank lines, removed when
  // empty). Only the edited row is patched so a tap on another row stays valid.
  function commitEditing(){
    if(!editing) return false;
    var ed = editing;
    editing = null; barSnapshot = null;
    var before = blocks;
    var at = indexOfId(ed.id);
    var next = commitEdit(before, ed.id, ed.ta.value, uid);
    var count = next.length - before.length + 1;    // rows that replace the edited one
    blocks = next;
    var frag = document.createDocumentFragment();
    if(at >= 0) next.slice(at, at + count).forEach(function(b){ frag.appendChild(makeRow(b)); });
    if(ed.row.parentNode) ed.row.parentNode.replaceChild(frag, ed.row);
    updateHint();
    paint();
    var changed = before.length !== next.length || blocksToText(before) !== blocksToText(next);
    if(changed && opts.onChange) opts.onChange(getBlocks());
    return changed;
  }

  function getBlocks(){
    if(editing) return commitEdit(blocks, editing.id, editing.ta.value, uid);
    return blocks.map(function(b){ return { id: b.id, text: b.text }; });
  }

  // Appends an empty paragraph in editing state (removed again on commit if left empty).
  function focusNew(){
    commitEditing();
    range = null;
    var b = { id: String(uid()), text: "" };
    while(indexOfId(b.id) >= 0) b.id = String(uid());
    blocks = blocks.concat([b]);
    var row = makeRow(b);
    listEl.insertBefore(row, footer);
    updateHint();
    paint();
    startEdit(row);
    row.scrollIntoView({ block: "nearest" });
  }

  /* ----- Pointer handling ----- */
  function rowOf(target){ return target && target.closest ? target.closest(".block") : null; }
  function cancelPress(){ if(press){ clearTimeout(press.timer); press = null; } }

  listEl.addEventListener("pointerdown", function(e){
    suppressClick = false;
    cancelPress();
    var row = rowOf(e.target);
    if(!row || e.target.closest("textarea")) return;
    if(e.button != null && e.button > 0) return;
    var p = { x: e.clientX, y: e.clientY, row: row, timer: 0 };
    p.timer = setTimeout(function(){
      if(press !== p) return;
      press = null;
      suppressClick = true;
      if(editing && editing.row !== row) commitEditing();
      if(editing) return;                      // long-press on the row being edited: leave it to the OS
      var i = indexOfId(row.getAttribute("data-id"));
      if(i >= 0) toggleIndex(i);
      if(navigator.vibrate) try{ navigator.vibrate(10); }catch(err){}
    }, LONG_PRESS_MS);
    press = p;
  });
  // A handle press must not blur the textarea first (the blur commit would replace the row under the
  // pointer); the click handler commits instead.
  listEl.addEventListener("mousedown", function(e){ if(e.target.closest(".block-handle") && editing) e.preventDefault(); });
  listEl.addEventListener("pointermove", function(e){
    if(!press) return;
    var dx = e.clientX - press.x, dy = e.clientY - press.y;
    if(dx * dx + dy * dy >= MOVE_TOLERANCE_PX * MOVE_TOLERANCE_PX) cancelPress();
  });
  listEl.addEventListener("pointerup", cancelPress);
  listEl.addEventListener("pointercancel", cancelPress);
  listEl.addEventListener("contextmenu", function(e){
    if(rowOf(e.target) && !e.target.closest("textarea")) e.preventDefault();
  });

  listEl.addEventListener("click", function(e){
    if(suppressClick){ suppressClick = false; return; }
    var row = rowOf(e.target);
    if(!row) return;
    if(e.target.closest(".block-handle")){
      if(editing) commitEditing();
      var i = indexOfId(row.getAttribute("data-id"));
      if(i >= 0) toggleIndex(i);
      return;
    }
    if(!e.target.closest(".block-text")) return;
    if(range){
      var j = indexOfId(row.getAttribute("data-id"));
      if(j >= 0) toggleIndex(j);
      return;
    }
    if(editing && editing.row === row) return;
    if(editing) commitEditing();
    startEdit(row);
  });

  /* ----- Bar and footer ----- */
  // Pressing a bar button must not blur the editing textarea (that would commit and lose the
  // sentence selection), so the default focus change is prevented and the selection captured.
  function barDown(e){
    if(!e.target.closest("button")) return;
    barSnapshot = editSelection() || barSnapshot;
    barPressing = true;
    if(e.type === "mousedown") e.preventDefault();
  }
  barEl.addEventListener("pointerdown", barDown);
  barEl.addEventListener("mousedown", barDown);
  document.addEventListener("pointerup", function(){ setTimeout(function(){ barPressing = false; }, 0); });
  barEl.addEventListener("click", function(e){
    var btn = e.target.closest("button");
    barPressing = false;
    if(!btn) return;
    if(btn.id === "blockBarClose" && opts.ownsBar && opts.ownsBar()){ if(opts.onBarClose) opts.onBarClose(); return; }
    if(btn.id === "blockBarClose"){ clearSelection(); if(editing) editing.ta.focus(); return; }
    var act = btn.getAttribute("data-act");
    if(act && opts.onAction) opts.onAction(act);
  });
  document.addEventListener("selectionchange", function(){ if(editing){ updateBar(); if(opts.onSelect) opts.onSelect(); } });

  var addBtn = footer && footer.querySelector("#blockAdd");
  var contBtn = footer && footer.querySelector("#blockContinue");
  if(addBtn) addBtn.addEventListener("click", focusNew);
  if(contBtn) contBtn.addEventListener("click", function(){ commitEditing(); if(opts.onContinueAtEnd) opts.onContinueAtEnd(); });

  return { render: render, getBlocks: getBlocks, getSelection: getSelection, clearSelection: clearSelection,
    commitEditing: commitEditing, focusNew: focusNew };
}
