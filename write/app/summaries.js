// Rolling summary of older messages ("folding") and scene digests, both with proposed facts.
// Pure helpers plus two async runners.
import { estimateTokens, hashText } from "./util.js";

export const SUMMARY_DEFAULTS = { triggerMessages:16, triggerTokens:12000, keepVerbatim:8, forceKeep:2, maxFoldTokens:12000, maxCharsPerMessage:6000, targetWords:500, maxTokens:1500 };

export const SCENE_SUMMARY_DEFAULTS = { minWords:40, targetWords:120, maxTokens:700, maxChars:40000 };
export const FACTS_HEADING = "### Proposed facts";
export const SCENE_SENTINEL = "digest of one scene";

const MIDDLE_OMITTED = "\n\n[… middle of the scene omitted]\n\n";

function factsInstruction(names, what){
  return "After "+what+", output a line exactly `"+FACTS_HEADING+"` followed by bullets "+
    "`- [character|place|thread] Name: one-sentence fact` for new durable facts about characters, places or plot threads "+
    "that are not already in the story bible ("+(names.length ? names.join(", ") : "(none)")+"), or `- none`.";
}

function est(msgs){
  return msgs.reduce(function(a, m){ return a+estimateTokens(m && m.content); }, 0);
}

export function planFold(messages, summarizedUpTo, opts, force){
  var o=Object.assign({}, SUMMARY_DEFAULTS, opts||{});
  messages=messages||[];
  var from=Math.max(0, Number(summarizedUpTo)||0);
  var unfolded=messages.slice(from);
  if(!force && unfolded.length<=o.triggerMessages && est(unfolded)<=o.triggerTokens) return null;
  var to=messages.length-(force ? o.forceKeep : o.keepVerbatim);
  var isUserAt=function(i){ return i<messages.length && messages[i].role==="user"; };
  while(to>from && !isUserAt(to)) to--;
  while(est(messages.slice(from, to))>o.maxFoldTokens && to-from>2){
    var c=to-1;
    while(c>from && !isUserAt(c)) c--;
    if(c-from<2) break;
    to=c;
  }
  if(to-from<2) return null;
  return { from:from, to:to };
}

export function formatForSummary(msg, maxChars){
  var limit=maxChars||SUMMARY_DEFAULTS.maxCharsPerMessage;
  var user=msg.role==="user";
  var text=user && typeof msg.display==="string" && msg.display ? msg.display : String(msg.content||"");
  if(text.length>limit) text=text.slice(0, limit)+" […truncated]";
  return (user ? "[Author]: " : "[Assistant]: ")+text;
}

export function buildSummaryRequest(args){
  var names=(args.cardNames||[]).filter(Boolean);
  var words=args.targetWords||SUMMARY_DEFAULTS.targetWords;
  var maxChars=args.maxChars||SUMMARY_DEFAULTS.maxCharsPerMessage;
  var system="You maintain a running summary of a conversation between an author and an AI writing partner working on fiction. "+
    "Merge the new messages into the existing summary. "+
    "Keep: the author's intent and goals, decisions and constraints, style instructions, facts established about characters, places and plot, "+
    "what was drafted (key beats, not the full prose), and open questions or requests. "+
    "Drop pleasantries. "+
    "Don't repeat facts already in the story bible: "+(names.length ? names.join(", ") : "(none)")+". "+
    "Use the conversation's language. "+
    "Format: short bullets under `Intent & decisions`, `Story facts`, `Drafts so far`, `Open threads`. "+
    "At most "+words+" words; compress older points if needed. "+
    "Output the updated summary. "+factsInstruction(names, "the summary");
  var user="Current summary:\n"+(args.summary || "(none)")+
    "\n\nNew messages to fold in, oldest first:\n"+
    (args.slice||[]).map(function(m){ return formatForSummary(m, maxChars); }).join("\n\n");
  return [{ role:"system", content:system }, { role:"user", content:user }];
}

export function cleanSummary(text){
  var t=String(text||"").trim();
  var fence=t.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  if(fence) t=fence[1].trim();
  var lines=t.split("\n");
  if(lines.length && /^(here is|here's|here are)\b.*\bsummary\b.*:\s*$/i.test(lines[0].trim())) lines.shift();
  t=lines.join("\n").trim();
  fence=t.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  if(fence) t=fence[1].trim();
  return t;
}

// Scene digest request. Over maxChars, the middle of the scene is cut out.
export function buildSceneSummaryRequest(args){
  var names=(args.cardNames||[]).filter(Boolean);
  var words=args.targetWords||SCENE_SUMMARY_DEFAULTS.targetWords;
  var maxChars=args.maxChars||SCENE_SUMMARY_DEFAULTS.maxChars;
  var text=String(args.text||"");
  if(text.length>maxChars){
    var head=Math.floor(maxChars/2);
    text=text.slice(0, head)+MIDDLE_OMITTED+text.slice(text.length-(maxChars-head));
  }
  var system="You write the "+SCENE_SENTINEL+" of a work of fiction for a story-so-far chain. "+
    "Write in the past tense. "+
    "Cover, in order: events, outcomes, decisions, changes in relationships and knowledge, and new durable facts. "+
    "No commentary, no quoted prose and no headings in the summary. "+
    "At most "+words+" words. "+
    "Use the scene's language. "+
    factsInstruction(names, "the summary");
  var user="Chapter: "+String(args.chapterTitle||"")+"\nScene: "+String(args.title||"")+
    "\n\nPrevious summary (may be out of date):\n"+(String(args.previousSummary||"").trim() || "(none)")+
    "\n\nScene text:\n"+text;
  return [{ role:"system", content:system }, { role:"user", content:user }];
}

var FACTS_LINE=/^\s{0,3}(?:#{1,6}\s*|\*\*)?proposed facts\**\s*:?\s*$/i;
var FACT_BULLET=/^[-*•]\s*\[([^\]]+)\]\s*([^:]{1,60}):\s*(.+)$/;
var FACT_TYPES={ character:"character", place:"place", thread:"thread", "plot thread":"thread" };

// Split a reply into the summary and the proposed facts after the last "Proposed facts" line.
export function parseSummaryReply(text){
  var t=String(text||"").trim();
  var fence=t.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  if(fence) t=fence[1].trim();
  var lines=t.split("\n"), at=-1;
  for(var i=lines.length-1; i>=0; i--){ if(FACTS_LINE.test(lines[i])){ at=i; break; } }
  if(at<0) return { summary:cleanSummary(t), facts:[] };
  var facts=[];
  lines.slice(at+1).forEach(function(line){
    var m=line.trim().match(FACT_BULLET);
    if(!m) return;
    var type=FACT_TYPES[m[1].trim().toLowerCase().replace(/\s+/g, " ")];
    var name=m[2].trim(), body=m[3].trim();
    if(!type || !name || !body) return;
    facts.push({ type:type, name:name, body:body });
  });
  return { summary:cleanSummary(lines.slice(0, at).join("\n")), facts:facts };
}

export async function runSceneSummary(args){
  var o=Object.assign({}, SCENE_SUMMARY_DEFAULTS, args.opts||{});
  var text=String(args.text||"");
  var res=await args.callApi({
    model: args.model,
    messages: buildSceneSummaryRequest({
      title: args.title,
      chapterTitle: args.chapterTitle,
      text: text,
      previousSummary: args.previousSummary,
      cardNames: args.cardNames,
      targetWords: o.targetWords,
      maxChars: o.maxChars
    }),
    thinking: "off",
    maxTokens: o.maxTokens,
    signal: args.signal
  });
  if(!res || res.aborted) return null;
  var parsed=parseSummaryReply(res.content);
  if(!parsed.summary) return null;
  return { summary:parsed.summary, facts:parsed.facts, hash:hashText(text), model:args.model };
}

export async function runFold(args){
  var o=Object.assign({}, SUMMARY_DEFAULTS, args.opts||{});
  var messages=args.messages||[];
  var plan=planFold(messages, args.summarizedUpTo, o, args.force);
  if(!plan) return null;
  var res=await args.callApi({
    model: args.model,
    messages: buildSummaryRequest({
      summary: args.summary,
      slice: messages.slice(plan.from, plan.to),
      cardNames: args.cardNames,
      targetWords: o.targetWords,
      maxChars: o.maxCharsPerMessage
    }),
    thinking: "off",
    maxTokens: o.maxTokens,
    signal: args.signal
  });
  if(!res || res.aborted) return null;
  var parsed=parseSummaryReply(res.content);
  if(!parsed.summary) return null;
  return { summary:parsed.summary, summarizedUpTo:plan.to, summarizedUpToId:messages[plan.to-1].id, model:args.model,
    facts:parsed.facts };
}
