// Scene text helpers: plain text <-> blocks, word count. Pure, no DOM.
import { uid as defaultUid } from "./util.js";

function str(v){ return typeof v==="string" ? v : (v==null ? "" : String(v)); }

// Split text into paragraphs. CRLF/CR are normalised; any run of newlines separates blocks;
// each block is trimmed and whitespace-only lines are dropped.
export function splitParagraphs(text){
  return str(text).replace(/\r\n?/g, "\n").split(/\n+/)
    .map(function(s){ return s.trim(); })
    .filter(function(s){ return s.length>0; });
}

// Turn text into [{id, text}], reusing ids from prevBlocks: the unchanged prefix and suffix
// (equal text) keep their ids, the changed middle reuses the old middle ids by position,
// and anything left over gets a fresh id. Ids are never duplicated.
export function textToBlocks(text, prevBlocks, uid){
  var mk=typeof uid==="function" ? uid : defaultUid;
  var texts=splitParagraphs(text);
  var prev=(Array.isArray(prevBlocks) ? prevBlocks : []).filter(function(b){
    return b && typeof b==="object" && typeof b.id==="string" && b.id;
  });
  var n=texts.length, m=prev.length;
  var ids=new Array(n);
  var p=0;
  while(p<n && p<m && texts[p]===str(prev[p].text)){ ids[p]=prev[p].id; p++; }
  var s=0;
  while(s<n-p && s<m-p && texts[n-1-s]===str(prev[m-1-s].text)){ ids[n-1-s]=prev[m-1-s].id; s++; }
  var midOld=prev.slice(p, m-s);
  for(var i=p; i<n-s; i++){
    var k=i-p;
    if(k<midOld.length) ids[i]=midOld[k].id;
  }
  var used=new Set();
  return texts.map(function(t, i){
    var id=ids[i];
    if(!id || used.has(id)){
      var guard=0;
      do { id=String(mk()); guard++; } while(used.has(id) && guard<1000);
      while(used.has(id)) id=id+"-"+i;
    }
    used.add(id);
    return { id:id, text:t };
  });
}

export function blocksToText(blocks){
  return (Array.isArray(blocks) ? blocks : []).map(function(b){ return str(b && b.text); }).join("\n\n");
}

// Whitespace-separated tokens that contain at least one letter or digit (any script).
export function countWords(text){
  var n=0;
  str(text).split(/\s+/).forEach(function(t){ if(t && /[\p{L}\p{N}]/u.test(t)) n++; });
  return n;
}
