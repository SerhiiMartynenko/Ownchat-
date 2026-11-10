// AI actions on a passage of a scene (rewrite, tighten, expand, tone, custom, continue): request assembly
// and a guard that cleans the model's reply into plain prose. Pure, no DOM.
import { estimateTokens } from "./util.js";
import { matchCards, cardToText, normalizeBible } from "./bible.js";
import { isAnthropic } from "./api.js";

export const REWRITE_DEFAULTS = { cardBudget:4000, windowBudget:3000 };

// Editing actions (rewrite, tighten, expand, tone, custom, continue) always run without extended thinking so
// the preview answers fast; the chat keeps the user's thinking setting.
export const ACTION_THINKING = "off";

export const TONES = ["Darker","Lighter","More tense","More intimate","More lyrical","Plainer"];

// The e2e mock recognises an action request by this phrase; keep it in RULES.
export const RULES_SENTINEL = "Return ONLY the replacement prose";

export const RULES = "You are editing a scene of a novel for its author. You get the text around the passage for "+
  "context, the target passage and an instruction; apply the instruction to the target only (for a continuation, "+
  "write only the new passage). "+RULES_SENTINEL+". No preamble, no commentary, no quotation marks around the "+
  "text, no Markdown fences. Keep paragraph breaks as blank lines. Keep the point of view, tense and names unless "+
  "the instruction says otherwise.";

const TONE_PLACEHOLDER = "{tone}";

export const ACTIONS = {
  rewrite: { key:"rewrite", label:"Rewrite", acceptLabel:"Accept",
    instruction:"Rewrite the target. Keep its meaning, events and facts; improve flow, rhythm and word choice. "+
      "Keep it about the same length." },
  tighten: { key:"tighten", label:"Tighten", acceptLabel:"Accept",
    instruction:"Tighten the target: cut roughly a quarter of the words and remove redundancy, but keep every "+
      "plot-relevant detail." },
  expand: { key:"expand", label:"Expand", acceptLabel:"Accept",
    instruction:"Expand the target: deepen it with sensory detail, interiority or beats, to about one and a half "+
      "to two times its length. Invent no new plot facts." },
  tone: { key:"tone", label:"Tone", acceptLabel:"Accept",
    instruction:"Shift the tone of the target: "+TONE_PLACEHOLDER+"." },
  // The user's instruction is used verbatim as the instruction.
  custom: { key:"custom", label:"Custom", acceptLabel:"Accept", instruction:"" },
  continue: { key:"continue", label:"Continue", acceptLabel:"Insert",
    instruction:"Write the next passage of the scene: two to four paragraphs, about 150 to 300 words, continuing "+
      "from the text before. If text follows, lead into it. Never repeat the given text." }
};

export const ACTION_ORDER = ["rewrite","tighten","expand","tone","custom","continue"];

function s(v){ return typeof v==="string" ? v : (v==null ? "" : String(v)); }

function blockTexts(blocks){
  return (Array.isArray(blocks) ? blocks : []).map(function(b){
    return typeof b==="string" ? b : s(b && b.text);
  }).filter(function(t){ return t.trim().length>0; });
}

function joined(texts){ return texts.join("\n\n"); }

// Compose the instruction section: the base instruction, then any additional instruction.
function instructionText(action, instruction, tone){
  var extra=s(instruction).trim();
  if(action==="custom") return extra;
  var base=ACTIONS[action].instruction;
  if(action==="tone") base=base.replace(TONE_PLACEHOLDER, s(tone).trim());
  return extra ? base+"\nAdditional instruction: "+extra : base;
}

export function buildActionRequest(args){
  var a=args && typeof args==="object" ? args : {};
  var action=s(a.action);
  if(!Object.prototype.hasOwnProperty.call(ACTIONS, action)) throw new Error("Unknown action: "+(action || "(none)"));
  var o=Object.assign({}, REWRITE_DEFAULTS, a.options||{});
  var isContinue=action==="continue";
  var target=isContinue ? "" : s(a.target && typeof a.target==="object" ? a.target.text : a.target);
  if(!isContinue && !target.trim()) throw new Error("Select some text for "+ACTIONS[action].label+".");
  if(action==="custom" && !s(a.instruction).trim()) throw new Error("Custom needs an instruction.");
  if(action==="tone" && !s(a.tone).trim()) throw new Error("Tone needs a tone.");
  var bible=normalizeBible(a.bible && typeof a.bible==="object" ? a.bible : {});
  var model=s(a.model);

  // Window: drop whole blocks from the far ends (the end farther from the target, in blocks; ties drop
  // from the start of the text before) until before+after fit windowBudget. The target is never trimmed.
  var before=blockTexts(a.before), after=blockTexts(a.after);
  var droppedBefore=0, droppedAfter=0;
  var winTokens=function(){ return estimateTokens(joined(before))+estimateTokens(joined(after)); };
  while((before.length || after.length) && winTokens()>o.windowBudget){
    if(before.length>=after.length){ before.shift(); droppedBefore++; }
    else { after.pop(); droppedAfter++; }
  }
  var textBefore=joined(before), textAfter=joined(after);

  // Part A: rules, style guide, brief.
  var partA=RULES;
  var style=s(bible.styleGuide).trim(), brief=s(bible.brief).trim();
  if(style) partA+="\n\n## Style guide\n"+style;
  if(brief) partA+="\n\n## Brief\n"+brief;

  // Part B: story bible cards matched in the window and target; pinned first; over budget, drop unpinned
  // cards matched earliest in the text first (as context.js does).
  var picked=matchCards(bible.cards, [textBefore, target, textAfter].join("\n")).map(function(m){
    return { m:m, tokens:estimateTokens(cardToText(m.card)) };
  });
  var dropped=[], cardsOver=false;
  var sum=function(){ return picked.reduce(function(x, p){ return x+p.tokens; }, 0); };
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
  var partB=picked.length ? "## Story bible\n"+picked.map(function(p){ return cardToText(p.m.card); }).join("\n\n") : "";

  var parts=[partA, partB].filter(Boolean);
  var anthropic=isAnthropic(model);
  var system={ role:"system", content: anthropic
    ? parts.map(function(text){ return { type:"text", text:text, cache_control:{ type:"ephemeral" } }; })
    : parts.join("\n\n") };

  // User message.
  var title=s(a.sceneTitle).trim();
  var instr=instructionText(action, a.instruction, a.tone);
  var secTitle=title ? "## Scene: "+title : "";
  var secBefore=textBefore ? "## Text before\n"+textBefore : "";
  var secTarget=isContinue ? "" : "## Target\n"+target;
  var secAfter=textAfter ? "## Text after\n"+textAfter : "";
  var secInstr="## Instruction\n"+instr;
  var user=[secTitle, secBefore, secTarget, secAfter, secInstr].filter(Boolean).join("\n\n");

  var layers=[
    { key:"system", label:"Rules, style guide & brief", tokens:estimateTokens(partA) },
    { key:"cards", label:"Story bible", tokens:estimateTokens(partB),
      cards:picked.map(function(p){ return { id:p.m.card.id, name:p.m.card.name, reason:p.m.reason, tokens:p.tokens }; }),
      dropped:dropped, overBudget:cardsOver },
    { key:"before", label:"Text before", tokens:estimateTokens(secTitle ? secTitle+"\n\n"+secBefore : secBefore),
      blocks:before.length, droppedBlocks:droppedBefore },
    { key:"target", label:"Target", tokens:estimateTokens(secTarget) },
    { key:"after", label:"Text after", tokens:estimateTokens(secAfter), blocks:after.length, droppedBlocks:droppedAfter },
    { key:"instruction", label:"Instruction", tokens:estimateTokens(secInstr) }
  ];
  var breakdown={
    layers:layers,
    total:layers.reduce(function(x, l){ return x+l.tokens; }, 0),
    truncated: droppedBefore+droppedAfter>0,
    cacheBreakpoints: anthropic ? parts.length : 0
  };
  return { messages:[system, { role:"user", content:user }], breakdown:breakdown };
}

// --- Prose guard ---------------------------------------------------------------------------------------

var FENCE_RE=/^```[^\n]*\n([\s\S]*?)\n?```$/;
var PREAMBLE_RE=/^(here is|here's|here’s|here are|sure|certainly|of course|okay|ok|absolutely|below is|rewritten|revised|tightened|expanded|continued|continuation|the (rewritten|revised|tightened|expanded|continued|new) (version|text|passage))\b/i;
var CHATTER_RE=/^(let me know|i hope this|would you like|feel free)\b/i;

// Strip the usual wrappers a chat model puts around prose. Returns {text, flags}; each strip adds a flag:
// "fence", "preamble", "chatter", "quotes", "blank-lines". The preamble rule is deliberately conservative:
// a single first line of at most 120 chars that ends with ":" and starts like a chat preamble, when more
// lines follow, so prose such as "She said only this:" is never touched.
export function cleanProse(text){
  var flags=[];
  var t=s(text).replace(/\r\n?/g, "\n").trim();
  var m=t.match(FENCE_RE);
  if(m){ t=m[1].trim(); flags.push("fence"); }
  var lines=t.split("\n");
  var first=lines[0].trim();
  if(lines.length>1 && first.length<=120 && /:$/.test(first) && PREAMBLE_RE.test(first)){
    lines.shift(); flags.push("preamble");
    t=lines.join("\n").trim();
    m=t.match(FENCE_RE);
    if(m){ t=m[1].trim(); if(flags.indexOf("fence")<0) flags.push("fence"); }
    lines=t.split("\n");
  }
  var chatter=false;
  while(lines.length){
    var last=lines[lines.length-1].trim();
    if(!last || (chatter && /^(-{3,}|\*{3,}|_{3,})$/.test(last))){ lines.pop(); continue; }
    if(CHATTER_RE.test(last)){ lines.pop(); chatter=true; continue; }
    break;
  }
  if(chatter){ flags.push("chatter"); t=lines.join("\n").trim(); }
  // Wrapping quotes: only when the quote characters occur nowhere else, so dialogue stays intact.
  var pairs=[["\"","\""],["“","”"]];
  for(var i=0; i<pairs.length; i++){
    var q=pairs[i];
    if(t.length>=2 && t[0]===q[0] && t[t.length-1]===q[1]){
      var inner=t.slice(1, -1);
      if(inner.indexOf(q[0])<0 && inner.indexOf(q[1])<0){ t=inner.trim(); flags.push("quotes"); break; }
    }
  }
  var collapsed=t.replace(/\n{3,}/g, "\n\n");
  if(collapsed!==t){ t=collapsed; flags.push("blank-lines"); }
  return { text:t.trim(), flags:flags };
}

var CHAT_START_RE=/^(?:I |I'm |I’m |(?:Sure|Certainly|Of course|As an AI|Here is|Here's|Here’s)\b)/;
var CHAT_ANY_RE=/\b(?:I can't|I can’t|I cannot|I'm unable|I’m unable|as an AI|language model)\b/i;

// Heuristic: does the reply read like a chat answer rather than prose? Used only to warn in the preview.
// Known false positive: first-person prose that starts with "I " (e.g. "I walked to the door.") is flagged;
// the preview merely warns and the author can still accept it.
export function looksLikeChat(text, targetText){
  var t=cleanProse(text).text;
  if(!t) return true;
  if(CHAT_START_RE.test(t)) return true;
  if(CHAT_ANY_RE.test(t)) return true;
  var sentences=t.split(/(?<=[.!?…])\s+/);
  var lastSentence=sentences[sentences.length-1];
  if(/\?$/.test(lastSentence) && /\byou\b/i.test(lastSentence)) return true;
  var target=s(targetText).trim();
  if(target.length>200 && t.length<0.15*target.length) return true;
  return false;
}
