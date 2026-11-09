// Word-level diff for the AI preview: LCS over word, punctuation-run and whitespace tokens. Pure, no DOM.
import { countWords } from "./scene.js";

export const DIFF_CELL_CAP = 4e6;

function str(v){ return typeof v==="string" ? v : (v==null ? "" : String(v)); }

function tokenize(text){ return str(text).match(/\s+|[^\s]+/g) || []; }

function push(out, type, text){
  if(!text) return;
  var last=out[out.length-1];
  if(last && last.type===type) last.text+=text;
  else out.push({ type:type, text:text });
}

// Within each run of changes between two "eq" ops, all deletions come first and all insertions after,
// so the preview reads "old words, new words" instead of an interleaved patchwork. Whitespace-only matches
// sitting between two changes are folded into the change for the same reason.
function group(raw){
  var merged=[];
  raw.forEach(function(op){ push(merged, op.type, op.text); });
  var ops=[];
  merged.forEach(function(op, i){
    if(op.type==="eq" && i>0 && i<merged.length-1 && /^\s+$/.test(op.text)){
      ops.push({ type:"del", text:op.text }, { type:"ins", text:op.text });
    } else ops.push(op);
  });
  var out=[], dels="", ins="";
  function flush(){ push(out, "del", dels); push(out, "ins", ins); dels=""; ins=""; }
  ops.forEach(function(op){
    if(op.type==="eq"){ flush(); push(out, "eq", op.text); }
    else if(op.type==="del") dels+=op.text;
    else ins+=op.text;
  });
  flush();
  return out;
}

// diffWords(a, b) -> [{type:"eq"|"del"|"ins", text}]. Concatenating eq+del texts gives a, eq+ins gives b.
// The common prefix and suffix are matched first; the LCS table covers only the middle. When the middle is
// larger than DIFF_CELL_CAP cells, the middle is reported as one deletion plus one insertion.
export function diffWords(a, b){
  var A=tokenize(a), B=tokenize(b);
  var p=0;
  while(p<A.length && p<B.length && A[p]===B[p]) p++;
  var s=0;
  while(s<A.length-p && s<B.length-p && A[A.length-1-s]===B[B.length-1-s]) s++;
  var ops=[];
  ops.push({ type:"eq", text:A.slice(0, p).join("") });
  var MA=A.slice(p, A.length-s), MB=B.slice(p, B.length-s);
  var n=MA.length, m=MB.length;
  if(n && m && n*m<=DIFF_CELL_CAP){
    // Intern tokens so the inner loop compares integers.
    var dict=new Map(), ia=new Int32Array(n), ib=new Int32Array(m);
    var intern=function(t){ var k=dict.get(t); if(k===undefined){ k=dict.size; dict.set(t, k); } return k; };
    for(var i=0; i<n; i++) ia[i]=intern(MA[i]);
    for(var j=0; j<m; j++) ib[j]=intern(MB[j]);
    // L[i*(m+1)+j] = LCS length of MA[i..] and MB[j..].
    var W=m+1, L=new Uint32Array((n+1)*W);
    for(i=n-1; i>=0; i--){
      for(j=m-1; j>=0; j--){
        L[i*W+j]= ia[i]===ib[j] ? L[(i+1)*W+j+1]+1 : Math.max(L[(i+1)*W+j], L[i*W+j+1]);
      }
    }
    i=0; j=0;
    while(i<n && j<m){
      if(ia[i]===ib[j]){ ops.push({ type:"eq", text:MA[i] }); i++; j++; }
      else if(L[(i+1)*W+j]>=L[i*W+j+1]){ ops.push({ type:"del", text:MA[i] }); i++; }
      else { ops.push({ type:"ins", text:MB[j] }); j++; }
    }
    for(; i<n; i++) ops.push({ type:"del", text:MA[i] });
    for(; j<m; j++) ops.push({ type:"ins", text:MB[j] });
  } else {
    ops.push({ type:"del", text:MA.join("") });
    ops.push({ type:"ins", text:MB.join("") });
  }
  ops.push({ type:"eq", text:A.slice(A.length-s).join("") });
  return group(ops);
}

// Word counts of the inserted and deleted text (countWords from scene.js).
export function diffStats(ops){
  var ins="", del="";
  (Array.isArray(ops) ? ops : []).forEach(function(op){
    if(!op) return;
    if(op.type==="ins") ins+=" "+str(op.text)+" ";
    else if(op.type==="del") del+=" "+str(op.text)+" ";
  });
  return { inserted:countWords(ins), deleted:countWords(del) };
}
