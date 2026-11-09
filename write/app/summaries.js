// Rolling summary of older messages ("folding"). Pure helpers plus one async runner.
import { estimateTokens } from "./util.js";

export const SUMMARY_DEFAULTS = { triggerMessages:16, triggerTokens:12000, keepVerbatim:8, forceKeep:2, maxFoldTokens:12000, maxCharsPerMessage:6000, targetWords:500, maxTokens:1500 };

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
    "Output only the updated summary.";
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
  var cleaned=cleanSummary(res.content);
  if(!cleaned) return null;
  return { summary:cleaned, summarizedUpTo:plan.to, summarizedUpToId:messages[plan.to-1].id, model:args.model };
}
