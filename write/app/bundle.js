// Project bundle: a folder of Markdown files plus manifest.json, and a plain manuscript.
// Pure, no DOM. Zipping lives in export.js.
import { uid as defaultUid } from "./util.js";
import { normalizeBible } from "./bible.js";
import { textToBlocks, blocksToText, countWords, splitParagraphs } from "./scene.js";

export const BUNDLE_FORMAT = "ownchat-project";
export const BUNDLE_VERSION = 1;
export const THREAD_PATH = "chat/project-thread.json";
export const BRIEF_PATH = "bible/brief.md";
export const STYLE_PATH = "bible/style-guide.md";

const SCENE_KEYS = ["id","chapterId","order","title","summary"];
const CARD_KEYS = ["id","type","name","aliases","pinned","status"];

function str(v){ return typeof v==="string" ? v : (v==null ? "" : String(v)); }
function isObj(v){ return v!==null && typeof v==="object" && !Array.isArray(v); }
function num(v){ var n=Number(v); return isFinite(n) ? n : 0; }

/* ===== Slugs ===== */

export function slugify(text, fallback){
  var s=str(text).normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
  s=Array.from(s).slice(0, 40).join("").replace(/-+$/, "");
  return s || str(fallback);
}

function uniqueSlug(slug, used){
  var out=slug, i=2;
  while(used.has(out.toLowerCase())){ out=slug+"-"+i; i++; }
  used.add(out.toLowerCase());
  return out;
}

function numPrefix(i, count){
  return String(i+1).padStart(count>99 ? 3 : 2, "0");
}

/* ===== Front matter ===== */

export function formatFrontMatter(meta, keys, body){
  var lines=keys.map(function(k){
    var v=meta[k];
    return k+": "+(v===undefined ? "null" : JSON.stringify(v));
  });
  return "---\n"+lines.join("\n")+"\n---\n\n"+str(body)+"\n";
}

function stripOneTrailingNewline(s){ return s.endsWith("\n") ? s.slice(0, -1) : s; }

// Returns {meta, body, hasFrontMatter}. Front matter only when the text starts with "---\n".
export function parseFrontMatter(text){
  var t=str(text).replace(/\r\n?/g, "\n");
  if(!t.startsWith("---\n")) return { meta:{}, body:stripOneTrailingNewline(t), hasFrontMatter:false };
  var meta={}, pos=4;
  while(pos<=t.length){
    var nl=t.indexOf("\n", pos);
    var line=nl<0 ? t.slice(pos) : t.slice(pos, nl);
    if(line==="---"){
      var rest=nl<0 ? "" : t.slice(nl+1);
      if(rest.startsWith("\n")) rest=rest.slice(1);
      return { meta:meta, body:stripOneTrailingNewline(rest), hasFrontMatter:true };
    }
    var m=line.match(/^([A-Za-z][\w-]*):\s?(.*)$/);
    if(m){
      var raw=m[2];
      var val;
      try { val=JSON.parse(raw); } catch(e){ val=raw.trim(); }
      meta[m[1]]=val;
    }
    if(nl<0) break;
    pos=nl+1;
  }
  // No closing line: treat the whole file as body.
  return { meta:{}, body:stripOneTrailingNewline(t), hasFrontMatter:false };
}

/* ===== Build ===== */

function sortByOrder(list){
  return list.map(function(x, i){ return { x:x, i:i }; })
    .sort(function(a, b){ return (num(a.x.order)-num(b.x.order)) || (a.i-b.i); })
    .map(function(e){ return e.x; });
}

function omit(obj, keys){
  var out={};
  Object.keys(obj||{}).forEach(function(k){ if(keys.indexOf(k)<0) out[k]=obj[k]; });
  return out;
}

function resolveNow(now){
  if(typeof now==="function") return now();
  if(typeof now==="number") return now;
  return Date.now();
}

// data: {project, chapters, scenes, bible, thread}; opts: {now}
export function buildBundle(data, opts){
  var d=data||{};
  var project=Object.assign({}, d.project||{});
  var chapters=sortByOrder((d.chapters||[]).filter(isObj));
  var scenes=(d.scenes||[]).filter(isObj);
  var bible=isObj(d.bible) ? d.bible : {};
  var thread=isObj(d.thread) ? d.thread : { messages:[] };
  var exportedAt=new Date(resolveNow(opts && opts.now)).toISOString();

  var files={};
  files["manifest.json"]="";   // keep manifest first; filled in at the end

  // Bible
  files[BRIEF_PATH]=str(bible.brief)+"\n";
  files[STYLE_PATH]=str(bible.styleGuide)+"\n";
  var bibleUsed=new Set(["brief","style-guide"]);
  var cardEntries=(Array.isArray(bible.cards) ? bible.cards : []).filter(isObj).map(function(card){
    var type=str(card.type) || "note";
    var slug=uniqueSlug(type+"-"+slugify(card.name, type), bibleUsed);
    var file="bible/"+slug+".md";
    files[file]=formatFrontMatter({
      id:str(card.id), type:type, name:str(card.name),
      aliases:Array.isArray(card.aliases) ? card.aliases : [],
      pinned:!!card.pinned, status:str(card.status) || "approved"
    }, CARD_KEYS, card.body);
    return { id:str(card.id), createdAt:card.createdAt, updatedAt:card.updatedAt, file:file };
  });
  var bibleMeta=Object.assign(omit(bible, ["brief","styleGuide","cards","v","updatedAt"]), {
    v:bible.v==null ? 1 : bible.v,
    updatedAt:bible.updatedAt==null ? 0 : bible.updatedAt,
    brief:BRIEF_PATH, styleGuide:STYLE_PATH, cards:cardEntries
  });

  // Scenes, grouped by chapter in chapter order
  var sceneMetas=[];
  var chapterUsed=new Set();
  var known=new Set(chapters.map(function(c){ return c.id; }));
  function emitScenes(list, folder){
    var used=new Set();
    sortByOrder(list).forEach(function(sc, j, arr){
      var slug=uniqueSlug(slugify(sc.title, "scene"), used);
      var file=folder+"/"+numPrefix(j, arr.length)+"-"+slug+".md";
      var text=blocksToText(sc.blocks);
      files[file]=formatFrontMatter({
        id:str(sc.id), chapterId:sc.chapterId==null ? null : sc.chapterId,
        order:sc.order==null ? j : sc.order, title:str(sc.title), summary:str(sc.summary)
      }, SCENE_KEYS, text);
      sceneMetas.push(Object.assign(omit(sc, ["blocks"]), {
        blockIds:(Array.isArray(sc.blocks) ? sc.blocks : []).map(function(b){ return str(b && b.id); }),
        file:file
      }));
    });
  }
  chapters.forEach(function(ch, i){
    var slug=uniqueSlug(slugify(ch.title, "chapter"), chapterUsed);
    var folder="scenes/"+numPrefix(i, chapters.length)+"-"+slug;
    emitScenes(scenes.filter(function(s){ return s.chapterId===ch.id; }), folder);
  });
  var orphans=scenes.filter(function(s){ return !known.has(s.chapterId); });
  if(orphans.length) emitScenes(orphans, "scenes/unfiled");

  files[THREAD_PATH]=JSON.stringify(thread, null, 2)+"\n";

  var manifest={
    format:BUNDLE_FORMAT, version:BUNDLE_VERSION, exportedAt:exportedAt,
    project:project,
    chapters:chapters.map(function(c){ return Object.assign({}, c); }),
    scenes:sceneMetas,
    bible:bibleMeta,
    thread:THREAD_PATH
  };
  files["manifest.json"]=JSON.stringify(manifest, null, 2)+"\n";
  return { files:files, manifest:manifest };
}

/* ===== Parse ===== */

function normPath(p){
  var s=str(p).replace(/\\/g, "/");
  while(s.startsWith("./")) s=s.slice(2);
  s=s.replace(/^\/+/, "");
  return s;
}

function ignored(p){
  return p.startsWith("__MACOSX/") || p.indexOf("/__MACOSX/")>=0 ||
    p===".DS_Store" || p.endsWith("/.DS_Store") || p.endsWith("/");
}

function notBundle(){ return new Error("Not an Ownchat project bundle"); }

export function emptyThreadFor(project){
  return {
    id:str(project && project.threadId) || "default", messages:[], summary:"", summarizedUpTo:0,
    summarizedUpToId:null, summaryModel:"", summaryUpdatedAt:0, lastUsage:null, updatedAt:0
  };
}

// files: {path: string}; opts: {uid, now}
export function parseBundle(input, opts){
  var o=opts||{};
  var mk=typeof o.uid==="function" ? o.uid : defaultUid;
  var raw={};
  Object.keys(input||{}).forEach(function(k){
    var p=normPath(k);
    if(!p || ignored(p)) return;
    raw[p]=str(input[k]);
  });

  var root="";
  if(!("manifest.json" in raw)){
    var deep=Object.keys(raw).filter(function(p){ return /^[^/]+\/manifest\.json$/.test(p); });
    if(deep.length!==1) throw notBundle();
    root=deep[0].slice(0, -"manifest.json".length);
  }
  var files={};
  Object.keys(raw).forEach(function(p){
    if(root && !p.startsWith(root)) return;
    files[p.slice(root.length)]=raw[p];
  });

  var manifest;
  try { manifest=JSON.parse(files["manifest.json"]); } catch(e){ throw notBundle(); }
  if(!isObj(manifest) || manifest.format!==BUNDLE_FORMAT) throw notBundle();
  var ver=Number(manifest.version);
  if(!(ver>=1)) throw notBundle();
  if(ver>BUNDLE_VERSION) throw new Error("Made by a newer version of Ownchat Write");
  if(!isObj(manifest.project)) throw notBundle();

  var warnings=[];
  function readFile(path, what){
    var p=normPath(path);
    if(p && Object.prototype.hasOwnProperty.call(files, p)) return files[p];
    warnings.push("Missing file for "+what+(p ? " ("+p+")" : ""));
    return null;
  }

  var project=Object.assign({}, manifest.project);
  var chapters=(Array.isArray(manifest.chapters) ? manifest.chapters : [])
    .filter(function(c){ return isObj(c) && c.id!=null; })
    .map(function(c){ return Object.assign({}, c); });
  var chapterIds=new Set(chapters.map(function(c){ return c.id; }));

  var imported=null, importedCount=0;
  var scenes=(Array.isArray(manifest.scenes) ? manifest.scenes : [])
    .filter(function(s){ return isObj(s) && s.id!=null; })
    .map(function(meta){
      var scene=omit(meta, ["blockIds","file"]);
      var text=readFile(meta.file, "scene \""+str(meta.title || meta.id)+"\"");
      var body="";
      if(text!=null){
        var fm=parseFrontMatter(text);
        if(fm.hasFrontMatter){
          if("title" in fm.meta) scene.title=str(fm.meta.title);
          if("summary" in fm.meta) scene.summary=str(fm.meta.summary);
        }
        body=fm.body;
      }
      var blockIds=Array.isArray(meta.blockIds) ? meta.blockIds.map(str) : [];
      var paras=splitParagraphs(body);
      var blocks;
      if(blockIds.length===paras.length && new Set(blockIds).size===blockIds.length &&
         blockIds.every(function(id){ return id; })){
        blocks=paras.map(function(t, i){ return { id:blockIds[i], text:t }; });
      } else {
        blocks=textToBlocks(body, [], mk);
      }
      scene.blocks=blocks;
      scene.wordCount=countWords(blocksToText(blocks));
      if(scene.title==null) scene.title="";
      if(scene.summary==null) scene.summary="";
      if(!chapterIds.has(scene.chapterId)){
        if(!imported){
          var t=o.now ? (typeof o.now==="function" ? o.now() : o.now) : Date.now();
          imported={ id:mk(), projectId:project.id, order:chapters.length, title:"Imported", createdAt:t, updatedAt:t };
          chapters.push(imported);
          warnings.push("Some scenes had no chapter; they were put in \"Imported\"");
        }
        scene.chapterId=imported.id;
        scene.order=importedCount++;
      }
      return scene;
    });

  // Bible
  var bm=isObj(manifest.bible) ? manifest.bible : {};
  var brief=readFile(bm.brief || BRIEF_PATH, "the brief");
  var style=readFile(bm.styleGuide || STYLE_PATH, "the style guide");
  var cards=[];
  (Array.isArray(bm.cards) ? bm.cards : []).forEach(function(entry){
    if(!isObj(entry)) return;
    var text=readFile(entry.file, "card "+str(entry.id));
    if(text==null) return;
    var fm=parseFrontMatter(text);
    var meta=fm.meta;
    cards.push({
      id:str(entry.id || meta.id), type:meta.type, name:meta.name, aliases:meta.aliases,
      pinned:meta.pinned===true || meta.pinned==="true", status:meta.status,
      body:fm.body, createdAt:entry.createdAt, updatedAt:entry.updatedAt
    });
  });
  var extra=omit(bm, ["brief","styleGuide","cards","v","updatedAt"]);
  var normalized=normalizeBible(Object.assign({}, extra, {
    v:bm.v, updatedAt:bm.updatedAt,
    brief:brief==null ? "" : stripOneTrailingNewline(brief.replace(/\r\n?/g, "\n")),
    styleGuide:style==null ? "" : stripOneTrailingNewline(style.replace(/\r\n?/g, "\n")),
    cards:cards
  }));
  if(normalized.cards.length<cards.length) warnings.push("Skipped "+(cards.length-normalized.cards.length)+" card(s) without a name");
  var bible=Object.assign({}, extra, normalized);

  // Thread
  var thread=null;
  var tpath=typeof manifest.thread==="string" && manifest.thread ? manifest.thread : THREAD_PATH;
  var ttext=readFile(tpath, "the project chat");
  if(ttext!=null){
    try {
      var t=JSON.parse(ttext);
      if(isObj(t) && Array.isArray(t.messages)) thread=t;
      else warnings.push("The project chat file is not valid; started an empty chat");
    } catch(e){ warnings.push("The project chat file is not valid; started an empty chat"); }
  }
  if(!thread) thread=emptyThreadFor(project);

  return { project:project, chapters:chapters, scenes:scenes, bible:bible, thread:thread, warnings:warnings };
}

/* ===== Manuscript ===== */

export function buildManuscript(project, chapters, scenes){
  var parts=["# "+(str(project && project.title).trim() || "Untitled")];
  var list=(scenes||[]).filter(isObj);
  sortByOrder((chapters||[]).filter(isObj)).forEach(function(ch){
    parts.push("## "+(str(ch.title).trim() || "Untitled chapter"));
    var texts=sortByOrder(list.filter(function(s){ return s.chapterId===ch.id; }))
      .map(function(s){ return blocksToText(s.blocks); })
      .filter(function(t){ return t.trim(); });
    if(texts.length) parts.push(texts.join("\n\n* * *\n\n"));
  });
  return parts.join("\n\n")+"\n";
}
