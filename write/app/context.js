// Assembles the request messages from the story bible, the rolling summary and recent messages.
// Pure, no DOM.
import { estimateTokens } from "./util.js";
import { matchCards, cardToText } from "./bible.js";

export const CONTEXT_DEFAULTS = { totalBudget:24000, cardBudget:6000, maxVerbatim:24, scanMessages:4, msgOverhead:4 };

function s(v){ return typeof v==="string" ? v : ""; }

function systemText(brief, style){
  brief=s(brief).trim(); style=s(style).trim();
  if(style && !brief) return style;
  if(style && brief) return "## Style guide\n"+style+"\n\n## Brief\n"+brief;
  if(brief) return "## Brief\n"+brief;
  return "";
}

export function assembleContext(args){
  var model=s(args.model), bible=args.bible||{}, thread=args.thread||{}, draft=args.draft;
  var o=Object.assign({}, CONTEXT_DEFAULTS, args.options||{});
  var all=Array.isArray(thread.messages) ? thread.messages : [];

  // Current message and history.
  var current=null, history;
  if(typeof draft==="string"){
    // Meter preview: every message is history; an empty draft means no current message.
    current=draft!=="" ? { role:"user", content:draft } : null;
    history=all;
  } else if(all.length){
    var last=all[all.length-1];
    if(last.role!=="user") throw new Error("last message must be from the user");
    current={ role:"user", content:s(last.content) };
    history=all.slice(0, -1);
  } else {
    history=[];
  }
  var curTokens=current ? estimateTokens(current.content)+o.msgOverhead : 0;

  // Layer A: style guide & brief.
  var textA=systemText(bible.brief, bible.styleGuide);
  var tokA=estimateTokens(textA);

  // Layer B: story bible cards.
  var scanParts=[current ? current.content : ""];
  history.slice(Math.max(0, history.length-o.scanMessages)).forEach(function(m){ scanParts.push(s(m.content)); });
  var picked=matchCards(bible.cards||[], scanParts.join("\n")).map(function(m){
    return { m:m, tokens:estimateTokens(cardToText(m.card)) };
  });
  var dropped=[], cardsOver=false;
  var sum=function(){ return picked.reduce(function(a, p){ return a+p.tokens; }, 0); };
  while(sum()>o.cardBudget){
    var victim=-1;
    picked.forEach(function(p, i){
      if(p.m.reason==="pinned") return;
      if(victim<0 || p.m.pos<picked[victim].m.pos) victim=i;
    });
    if(victim<0){ cardsOver=true; break; }
    dropped.push({ id:picked[victim].m.card.id, name:picked[victim].m.card.name });
    picked.splice(victim, 1);
  }
  var textB=picked.length ? "## Story bible\n"+picked.map(function(p){ return cardToText(p.m.card); }).join("\n\n") : "";
  var tokB=estimateTokens(textB);

  // Layer C: rolling summary.
  var summary=s(thread.summary).trim();
  var textC=summary ? "## Earlier in this conversation (summary; those messages are not shown)\n"+summary : "";
  var tokC=estimateTokens(textC);

  // Layer D: verbatim recent messages.
  var upTo=Math.max(0, Math.min(Number(thread.summarizedUpTo)||0, history.length));
  var unfolded=history.slice(upTo);
  var fixed=tokA+tokB+tokC+curTokens;
  var over=fixed>o.totalBudget;
  var remaining=o.totalBudget-fixed;
  var recent=[], tokD=0;
  if(!over){
    for(var i=unfolded.length-1; i>=0 && recent.length<o.maxVerbatim; i--){
      var t=estimateTokens(s(unfolded[i].content))+o.msgOverhead;
      if(tokD+t>remaining) break;
      recent.unshift({ m:unfolded[i], tokens:t });
      tokD+=t;
    }
    while(recent.length && recent[0].m.role!=="user"){ tokD-=recent[0].tokens; recent.shift(); }
  }

  // Output messages.
  var layers=[textA, textB, textC].filter(Boolean);
  var anthropic=/^anthropic\//i.test(model);
  var messages=[];
  if(layers.length){
    messages.push({ role:"system", content: anthropic
      ? layers.map(function(text){ return { type:"text", text:text, cache_control:{ type:"ephemeral" } }; })
      : layers.join("\n\n") });
  }
  recent.forEach(function(r){ messages.push({ role:r.m.role, content:s(r.m.content) }); });
  if(current) messages.push(current);

  var breakdown={
    layers:[
      { key:"system", label:"Style guide & brief", tokens:tokA },
      { key:"cards", label:"Story bible", tokens:tokB,
        cards:picked.map(function(p){ return { id:p.m.card.id, name:p.m.card.name, reason:p.m.reason, tokens:p.tokens }; }),
        dropped:dropped, overBudget:cardsOver },
      { key:"summary", label:"Summary", tokens:tokC, folded:upTo },
      { key:"recent", label:"Recent messages", tokens:tokD, count:recent.length, droppedUnsummarized:unfolded.length-recent.length },
      { key:"current", label:"Current message", tokens:curTokens }
    ],
    total:0,
    budget:o.totalBudget,
    overBudget: over || cardsOver,
    cacheBreakpoints: anthropic ? layers.length : 0
  };
  breakdown.total=breakdown.layers.reduce(function(a, l){ return a+l.tokens; }, 0);
  return { messages:messages, breakdown:breakdown };
}
