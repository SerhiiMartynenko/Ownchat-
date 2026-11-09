// Small shared helpers. Pure, no DOM.

export function uid(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,7); }

// Rough token estimate: ~4 ASCII chars per token, ~2 non-ASCII (Cyrillic etc.) per token.
export function estimateTokens(str){
  if(!str) return 0;
  var ascii=0, other=0;
  for(const ch of String(str)){
    if(ch.codePointAt(0)>0x7f) other++; else ascii++;
  }
  return Math.ceil(ascii/4 + other/2);
}

// FNV-1a 32-bit hash over UTF-16 code units; returns 8 lowercase hex chars.
export function hashText(text){
  var s=String(text==null?"":text);
  var h=0x811c9dc5;
  for(var i=0;i<s.length;i++){
    h^=s.charCodeAt(i);
    h=Math.imul(h,0x01000193)>>>0;
  }
  return h.toString(16).padStart(8,"0");
}
