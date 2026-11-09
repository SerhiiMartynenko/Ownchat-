// Assembles the request messages from the story bible, the story so far, the current scene, the rolling summary
// and recent messages.
// Pure, no DOM.
import { estimateTokens } from "./util.js";
import { matchCards, cardToText } from "./bible.js";

export const CONTEXT_DEFAULTS = { totalBudget:24000, cardBudget:6000, maxVerbatim:24, scanMessages:4, msgOverhead:4, sceneBudget:8000, storyBudget:6000 };

export const SCENE_OMITTED_MARKER="[… earlier part of this scene omitted]\n\n";
export const STORY_OMITTED_MARKER="[… earlier scenes omitted]\n\n";

function s(v){ return typeof v==="string" ? v : ""; }

function systemText(brief, style){
  brief=s(brief).trim(); style=s(style).trim();
  if(style && !brief) return style;
  if(style && brief) return "## Style guide\n"+style+"\n\n## Brief\n"+brief;
  if(brief) return "## Brief\n"+brief;
  return "";
}

// Layer S: the current scene. Over budget, whole paragraphs are dropped from the start, then characters from
// the start of the last remaining paragraph, so the end of the scene (nearest the cursor) is kept.
function sceneLayer(scene, budget){
  if(!scene || typeof scene!=="object") return { text:"", title:"", included:false, truncated:false, omittedTokens:0 };
  var title=s(scene.title).trim(), body=s(scene.text).trim();
  var heading="## Current scene: "+(title || "Untitled");
  var full=body ? heading+"\n"+body : heading;
  if(estimateTokens(full)<=budget) return { text:full, title:title, included:true, truncated:false, omittedTokens:0 };
  var prefix=heading+"\n"+SCENE_OMITTED_MARKER;
  var paras=body.split("\n\n");
  while(paras.length>1 && estimateTokens(prefix+paras.join("\n\n"))>budget) paras.shift();
  var kept=paras.join("\n\n");
  if(estimateTokens(prefix+kept)>budget){
    // Cut code points from the start of the last paragraph: smallest cut that fits (estimate is monotonic).
    var chars=Array.from(kept), lo=0, hi=chars.length;
    while(lo<hi){
      var mid=(lo+hi)>>1;
      if(estimateTokens(prefix+chars.slice(mid).join(""))<=budget) hi=mid; else lo=mid+1;
    }
    kept=chars.slice(lo).join("");
  }
  var omitted=body.slice(0, body.length-kept.length);
  return { text:prefix+kept, title:title, included:true, truncated:true, omittedTokens:estimateTokens(omitted) };
}

// Layer SF: summaries of earlier scenes, oldest first. Over budget, the earliest entries are dropped whole;
// the last entry is always kept.
function storyLayer(list, budget){
  var entries=(Array.isArray(list) ? list : []).filter(function(e){
    return e && typeof e==="object" && s(e.summary).trim();
  }).map(function(e){
    var title=s(e.title).trim() || "Untitled", ch=s(e.chapterTitle).trim();
    var head="### "+(ch ? ch+" · "+title : title)+(e.stale ? " (summary may be out of date)" : "");
    return { text:head+"\n"+s(e.summary).trim(), stale:!!e.stale };
  });
  if(!entries.length) return { text:"", count:0, dropped:0, stale:0 };
  var heading="## Story so far\n";
  var build=function(list, marker){
    return heading+(marker ? STORY_OMITTED_MARKER : "")+list.map(function(e){ return e.text; }).join("\n\n");
  };
  var kept=entries.slice(), text=build(kept, false);
  while(kept.length>1 && estimateTokens(text)>budget){
    kept.shift();
    text=build(kept, true);
  }
  return { text:text, count:kept.length, dropped:entries.length-kept.length,
    stale:kept.filter(function(e){ return e.stale; }).length };
}

export function assembleContext(args){
  var model=s(args.model), bible=args.bible||{}, thread=args.thread||{}, draft=args.draft;
  var o=Object.assign({}, CONTEXT_DEFAULTS, args.options||{});
  var S=sceneLayer(args.scene, o.sceneBudget);
  var SF=storyLayer(args.storySoFar, o.storyBudget);
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
  if(S.included) scanParts.unshift(s(args.scene.text));
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

  var tokSF=estimateTokens(SF.text);
  var tokS=estimateTokens(S.text);

  // Layer C: rolling summary.
  var summary=s(thread.summary).trim();
  var textC=summary ? "## Earlier in this conversation (summary; those messages are not shown)\n"+summary : "";
  var tokC=estimateTokens(textC);

  // Layer D: verbatim recent messages.
  var upTo=Math.max(0, Math.min(Number(thread.summarizedUpTo)||0, history.length));
  var unfolded=history.slice(upTo);
  var fixed=tokA+tokB+tokSF+tokS+tokC+curTokens;
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
  var layers=[textA, textB, SF.text, S.text, textC].filter(Boolean);
  var anthropic=/^anthropic\//i.test(model);
  // At most 4 cache breakpoints: with all five layers present, A and B share one part.
  var parts=layers.length===5 ? [textA+"\n\n"+textB].concat(layers.slice(2)) : layers;
  var messages=[];
  if(layers.length){
    messages.push({ role:"system", content: anthropic
      ? parts.map(function(text){ return { type:"text", text:text, cache_control:{ type:"ephemeral" } }; })
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
      { key:"story", label:"Story so far", tokens:tokSF, count:SF.count, dropped:SF.dropped, stale:SF.stale },
      { key:"scene", label:"Current scene", tokens:tokS, title:S.title, included:S.included,
        truncated:S.truncated, omittedTokens:S.omittedTokens },
      { key:"summary", label:"Summary", tokens:tokC, folded:upTo },
      { key:"recent", label:"Recent messages", tokens:tokD, count:recent.length, droppedUnsummarized:unfolded.length-recent.length },
      { key:"current", label:"Current message", tokens:curTokens }
    ],
    total:0,
    budget:o.totalBudget,
    overBudget: over || cardsOver,
    cacheBreakpoints: anthropic ? parts.length : 0
  };
  breakdown.total=breakdown.layers.reduce(function(a, l){ return a+l.tokens; }, 0);
  return { messages:messages, breakdown:breakdown };
}
