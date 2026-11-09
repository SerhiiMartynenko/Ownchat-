// Pure block helpers for the blocks surface: commit an edit, selection ranges, replace/insert paragraphs,
// splice a substring and pick the context window around a target. Never mutates its input. No DOM.
import { uid as defaultUid } from "./util.js";
import { splitParagraphs, textToBlocks } from "./scene.js";

function str(v){ return typeof v==="string" ? v : (v==null ? "" : String(v)); }

function list(blocks){
  return (Array.isArray(blocks) ? blocks : []).filter(function(b){ return b && typeof b==="object"; })
    .map(function(b){ return Object.assign({}, b, { id:str(b.id), text:str(b.text) }); });
}

function isInt(n){ return typeof n==="number" && isFinite(n) && Math.floor(n)===n; }

// A fresh id not present in `used` (a Set); the id is added to `used`.
function freshId(mk, used){
  var id, guard=0;
  do { id=String(mk()); guard++; } while((!id || used.has(id)) && guard<1000);
  var base=id || "b", k=1;
  while(!id || used.has(id)){ id=base+"-"+k; k++; }
  used.add(id);
  return id;
}

// Commit the text of an edited block: no paragraphs removes the block, one updates its text (id kept),
// several replace it (the first keeps the id, the rest get fresh ids unique across the array).
// Unknown id: an unchanged copy.
export function commitEdit(blocks, id, text, uid){
  var mk=typeof uid==="function" ? uid : defaultUid;
  var out=list(blocks);
  var at=-1;
  for(var i=0; i<out.length; i++){ if(out[i].id===id){ at=i; break; } }
  if(at<0) return out;
  var paras=splitParagraphs(text);
  var used=new Set(out.map(function(b){ return b.id; }));
  var repl=paras.map(function(t, k){
    return k===0 ? Object.assign({}, out[at], { text:t }) : { id:freshId(mk, used), text:t };
  });
  return out.slice(0, at).concat(repl, out.slice(at+1));
}

export function rangeFromIndex(i){
  return isInt(i) && i>=0 ? { start:i, end:i } : null;
}

// Contiguous selection semantics for tapping block `index`:
// - no range: select just that block;
// - outside the range: extend the range to include it;
// - the only selected block: clear (null);
// - an end of a longer range: shrink that end by one;
// - strictly inside: shrink the nearer end so the index is excluded (equal distance: shrink the end side).
export function toggleInRange(range, index){
  if(!isInt(index) || index<0) return range ? { start:range.start, end:range.end } : null;
  if(!range || !isInt(range.start) || !isInt(range.end)) return { start:index, end:index };
  var start=Math.min(range.start, range.end), end=Math.max(range.start, range.end);
  if(index<start) return { start:index, end:end };
  if(index>end) return { start:start, end:index };
  if(start===end) return null;
  if(index===start) return { start:start+1, end:end };
  if(index===end) return { start:start, end:end-1 };
  if(index-start<end-index) return { start:index+1, end:end };
  return { start:start, end:index-1 };
}

// Clamp a range to [0, length-1] (start <= end); null when there is nothing to select.
export function normalizeRange(range, length){
  var n=isInt(length) ? length : 0;
  if(!range || typeof range!=="object" || n<=0) return null;
  var a=Number(range.start), b=Number(range.end);
  if(!isFinite(a) || !isFinite(b)) return null;
  a=Math.floor(a); b=Math.floor(b);
  if(a>b){ var t=a; a=b; b=t; }
  if(b<0 || a>n-1) return null;
  return { start:Math.max(0, a), end:Math.min(n-1, b) };
}

// Replace blocks[start..end] with the paragraphs of `text`. Unchanged paragraphs keep their ids
// (textToBlocks over the replaced slice); ids stay unique across the whole array. Empty text removes the range.
export function applyReplacement(blocks, range, text, uid){
  var mk=typeof uid==="function" ? uid : defaultUid;
  var out=list(blocks);
  var r=normalizeRange(range, out.length);
  if(!r) return out;
  var before=out.slice(0, r.start), after=out.slice(r.end+1);
  var used=new Set(before.concat(after).map(function(b){ return b.id; }));
  var repl=textToBlocks(text, out.slice(r.start, r.end+1), mk).map(function(b){
    var id=b.id;
    if(!id || used.has(id)) id=freshId(mk, used); else used.add(id);
    return { id:id, text:b.text };
  });
  return before.concat(repl, after);
}

// Insert the paragraphs of `text` after block `index` (-1/null/negative: at the start; >= length-1: append).
export function insertAfter(blocks, index, text, uid){
  var mk=typeof uid==="function" ? uid : defaultUid;
  var out=list(blocks);
  var paras=splitParagraphs(text);
  if(!paras.length) return out;
  var used=new Set(out.map(function(b){ return b.id; }));
  var add=paras.map(function(t){ return { id:freshId(mk, used), text:t }; });
  var at;
  if(!isInt(index) || index<0) at=0;
  else at=Math.min(index+1, out.length);
  return out.slice(0, at).concat(add, out.slice(at));
}

// Replace [start, end) of blockText with replacement. Offsets are clamped and swapped if reversed.
export function spliceSelection(blockText, start, end, replacement){
  var t=str(blockText), n=t.length;
  var a=Number(start), b=Number(end);
  a=isFinite(a) ? Math.max(0, Math.min(n, Math.floor(a))) : 0;
  b=isFinite(b) ? Math.max(0, Math.min(n, Math.floor(b))) : a;
  if(a>b){ var x=a; a=b; b=x; }
  return t.slice(0, a)+str(replacement)+t.slice(b);
}

// Context window for a selected range: up to n blocks before range.start and n after range.end.
// A null (or empty) range means "after the last block": before = the last n blocks, after = [].
export function windowAround(blocks, range, n){
  var out=list(blocks);
  var k=isInt(n) && n>=0 ? n : 2;
  var r=normalizeRange(range, out.length);
  if(!r) return { before: k ? out.slice(Math.max(0, out.length-k)) : [], after:[] };
  return { before:out.slice(Math.max(0, r.start-k), r.start), after:out.slice(r.end+1, r.end+1+k) };
}

// Context window for an insertion point after block `afterIndex` (-1: at the start):
// before = up to n blocks ending at afterIndex, after = up to n blocks from afterIndex+1.
export function insertionWindow(blocks, afterIndex, n){
  var out=list(blocks);
  var k=isInt(n) && n>=0 ? n : 2;
  var i=isInt(afterIndex) ? Math.max(-1, Math.min(afterIndex, out.length-1)) : out.length-1;
  return { before:out.slice(Math.max(0, i+1-k), i+1), after:out.slice(i+1, i+1+k) };
}
