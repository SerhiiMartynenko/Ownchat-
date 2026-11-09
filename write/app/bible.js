// Story bible: brief, style guide and cards. Pure helpers, no DOM.
import { uid } from "./util.js";

export const CARD_TYPES = ["character","place","thread","note"];

export function emptyBible(){
  return { id:"default", v:1, brief:"", styleGuide:"", cards:[], updatedAt:0 };
}

function str(v){ return typeof v==="string" ? v : (v==null ? "" : String(v)); }

function normalizeCard(raw){
  if(!raw || typeof raw!=="object") return null;
  var name=str(raw.name).trim();
  if(!name) return null;
  var aliases=Array.isArray(raw.aliases) ? parseAliases(raw.aliases.map(str).join("\n"))
    : parseAliases(str(raw.aliases));
  var now=Date.now();
  return {
    id: str(raw.id) || uid(),
    type: CARD_TYPES.indexOf(raw.type)>=0 ? raw.type : "note",
    name: name,
    aliases: aliases,
    body: str(raw.body),
    pinned: !!raw.pinned,
    status: typeof raw.status==="string" && raw.status ? raw.status : "approved",
    createdAt: Number(raw.createdAt) || now,
    updatedAt: Number(raw.updatedAt) || Number(raw.createdAt) || now
  };
}

export function normalizeBible(raw, legacySystem){
  if(raw==null){
    var b=emptyBible();
    b.styleGuide=str(legacySystem).trim();
    return b;
  }
  var out=emptyBible();
  if(typeof raw!=="object") return out;
  if(raw.id) out.id=str(raw.id);
  out.v=Number(raw.v) || 1;
  out.brief=str(raw.brief);
  out.styleGuide=str(raw.styleGuide);
  out.cards=(Array.isArray(raw.cards) ? raw.cards : []).map(normalizeCard).filter(Boolean);
  out.updatedAt=Number(raw.updatedAt) || 0;
  return out;
}

export function newCard(partial, idFn){
  var now=Date.now();
  var p=partial||{};
  var aliases=Array.isArray(p.aliases) ? parseAliases(p.aliases.map(str).join("\n")) : parseAliases(str(p.aliases));
  return {
    id: p.id || (idFn||uid)(),
    type: CARD_TYPES.indexOf(p.type)>=0 ? p.type : "note",
    name: str(p.name).trim(),
    aliases: aliases,
    body: str(p.body),
    pinned: !!p.pinned,
    status: p.status || "approved",
    createdAt: now,
    updatedAt: now
  };
}

function withCards(bible, cards){
  return Object.assign({}, bible, { cards: cards, updatedAt: Date.now() });
}

export function upsertCard(bible, card){
  var cards=(bible.cards||[]).slice();
  var i=cards.findIndex(function(c){ return c.id===card.id; });
  if(i>=0) cards[i]=Object.assign({}, card); else cards.push(Object.assign({}, card));
  return withCards(bible, cards);
}

export function deleteCard(bible, id){
  return withCards(bible, (bible.cards||[]).filter(function(c){ return c.id!==id; }));
}

export function togglePin(bible, id){
  return withCards(bible, (bible.cards||[]).map(function(c){
    return c.id===id ? Object.assign({}, c, { pinned: !c.pinned, updatedAt: Date.now() }) : c;
  }));
}

export function parseAliases(s){
  var out=[], seen={};
  str(s).split(/[,\n]/).forEach(function(part){
    var t=part.trim();
    if(!t) return;
    var k=t.toLowerCase();
    if(seen[k]) return;
    seen[k]=true; out.push(t);
  });
  return out;
}

export function cardTerms(card){
  var out=[];
  [card.name].concat(card.aliases||[]).forEach(function(t){
    var k=str(t).trim().toLowerCase();
    if(k.length>=2 && out.indexOf(k)<0) out.push(k);
  });
  return out;
}

function byName(a, b){ return a.card.name.localeCompare(b.card.name); }

export function matchCards(cards, scanText){
  var hay=str(scanText).toLowerCase();
  var pinned=[], matched=[];
  (cards||[]).forEach(function(card){
    if(card.status!=="approved") return;
    if(card.pinned){ pinned.push({ card:card, reason:"pinned", term:null, pos:Infinity }); return; }
    var nameKey=str(card.name).trim().toLowerCase();
    var best=null, maxPos=-1;
    cardTerms(card).forEach(function(term){
      var pos=hay.lastIndexOf(term);
      if(pos<0) return;
      if(pos>maxPos) maxPos=pos;
      var reason=term===nameKey ? "name" : "alias";
      if(!best || (reason==="name" && best.reason!=="name")) best={ reason:reason, term:term };
    });
    if(best) matched.push({ card:card, reason:best.reason, term:best.term, pos:maxPos });
  });
  pinned.sort(byName); matched.sort(byName);
  return pinned.concat(matched);
}

export function cardToText(card){
  var aliases=card.aliases||[];
  var head="### "+card.name+" ("+card.type+(aliases.length ? "; also: "+aliases.join(", ") : "")+")";
  var body=str(card.body).trim();
  return body ? head+"\n"+body : head;
}
