// Project store over a db handle (see db.js). Pure: no DOM, testable with memoryHandle().
// Every multi-record change goes through handle.batch so it lands in one transaction.
import { uid as defaultUid, hashText } from "./util.js";
import { normalizeBible, emptyBible } from "./bible.js";
import { blocksToText, countWords } from "./scene.js";

// Per-scene cap on stored versions; older ones are pruned in the same batch that adds a new one.
export const MAX_VERSIONS_PER_SCENE = 30;

export function sceneThreadId(sceneId){ return "ts-" + sceneId; }

export function emptyThread(id, projectId){
  return { id: id || "default", projectId: projectId == null ? null : projectId,
    messages: [], summary: "", summarizedUpTo: 0, summarizedUpToId: null,
    summaryModel: "", summaryUpdatedAt: 0, lastUsage: null, updatedAt: 0,
    scope: "project", sceneId: null, includeScene: true };
}

function resetSummary(t){
  t.summary = ""; t.summarizedUpTo = 0; t.summarizedUpToId = null; t.summaryModel = ""; t.summaryUpdatedAt = 0;
}

// The selection a user message was sent with: plain strings, numbers and booleans only; null when unusable.
export function normalizeMessageSelection(sel){
  if(!sel || typeof sel !== "object" || Array.isArray(sel)) return null;
  var num = function(v){ var n = Number(v); return isFinite(n) && n >= 0 ? Math.floor(n) : 0; };
  var text = function(v, max){ return typeof v === "string" ? v.slice(0, max) : ""; };
  var out = { label: text(sel.label, 80), paraFrom: num(sel.paraFrom), paraTo: num(sel.paraTo), paraCount: num(sel.paraCount),
    partial: sel.partial === true, excerpt: text(sel.excerpt, 400) };
  return out.label ? out : null;
}

export function normalizeThread(rec){
  var src = rec && typeof rec === "object" ? rec : {};
  var t = Object.assign(emptyThread(src.id, src.projectId), src);
  if(!Array.isArray(t.messages)) t.messages = [];
  if(t.messages.some(function(m){ return m && typeof m === "object" && "selection" in m; })){
    t.messages = t.messages.map(function(m){
      if(!m || typeof m !== "object" || !("selection" in m)) return m;
      var c = Object.assign({}, m), sel = normalizeMessageSelection(m.selection);
      if(sel) c.selection = sel; else delete c.selection;
      return c;
    });
  }
  t.summary = typeof t.summary === "string" ? t.summary : "";
  t.summarizedUpTo = Math.max(0, Number(t.summarizedUpTo) || 0);
  if(t.summarizedUpTo > 0){
    var m = t.messages[t.summarizedUpTo - 1];
    if(!m || m.id !== t.summarizedUpToId) resetSummary(t);
  }
  if(typeof t.scope !== "string" || !t.scope) t.scope = "project";
  t.sceneId = typeof t.sceneId === "string" && t.sceneId ? t.sceneId : null;
  if(t.scope === "scene" && !t.sceneId) t.scope = "project";
  t.includeScene = t.includeScene !== false;
  return t;
}

function str(v){ return typeof v === "string" ? v : (v == null ? "" : String(v)); }
function arr(v){ return Array.isArray(v) ? v : []; }
function byOrder(a, b){ return (a.order || 0) - (b.order || 0); }
function put(store, value){ return { type: "put", store: store, value: value }; }
function del(store, id){ return { type: "del", store: store, id: id }; }
function patchOp(store, id, fn){ return { type: "patch", store: store, id: id, fn: fn }; }

// Per-project totals kept on the project record so the library does not read every scene:
// project.stats = { chapters, scenes, words }. Maintained by every change below (applied inside the
// change's own transaction) and recomputed when missing or inconsistent (listProjects, getOutline).
function emptyStats(){ return { chapters: 0, scenes: 0, words: 0 }; }
function count(n){ return typeof n === "number" && isFinite(n) && n >= 0 && Math.floor(n) === n; }
export function validStats(st){
  return !!st && typeof st === "object" && count(st.chapters) && count(st.scenes) && count(st.words);
}
function sameStats(a, b){ return validStats(a) && a.chapters === b.chapters && a.scenes === b.scenes && a.words === b.words; }
// Adds deltas to valid stats; invalid stats stay invalid (the next listProjects recomputes them).
function bumpStats(p, d){
  if(!validStats(p.stats)) return;
  p.stats = { chapters: Math.max(0, p.stats.chapters + (d.chapters || 0)), scenes: Math.max(0, p.stats.scenes + (d.scenes || 0)),
    words: Math.max(0, p.stats.words + (d.words || 0)) };
}
function statsOf(chapters, scenes){
  var st = emptyStats();
  st.chapters = chapters.length;
  scenes.forEach(function(s){ st.scenes++; st.words += wordsOf(s); });
  return st;
}

// Hash of a scene's text (blocksToText), stored as scene.textHash on every save of its blocks so the
// outline and the story-so-far can tell stale summaries without hashing every scene. Older records
// without it are hashed on the fly.
export function sceneTextHash(s){
  return s && typeof s.textHash === "string" && s.textHash ? s.textHash : hashText(blocksToText(normalizeBlocks(s && s.blocks)));
}
function withTextHash(s){ s.textHash = hashText(blocksToText(s.blocks)); return s; }

function normalizeBlocks(blocks){
  return arr(blocks).filter(function(b){ return b && typeof b === "object"; })
    .map(function(b){ return { id: str(b.id), text: str(b.text) }; });
}

function normalizeScene(raw){
  var s = Object.assign({}, raw);
  s.title = str(s.title);
  s.blocks = normalizeBlocks(s.blocks);
  s.summary = str(s.summary);
  s.summaryHash = str(s.summaryHash);
  s.summaryUpdatedAt = Math.max(0, Number(s.summaryUpdatedAt) || 0);
  s.summaryModel = str(s.summaryModel);
  s.wordCount = Math.max(0, Number(s.wordCount) || 0);
  s.textHash = str(s.textHash);
  delete s.stale;     // derived by getOutline, never stored
  return s;
}

function normalizeVersion(raw){
  var v = Object.assign({}, raw);
  v.blocks = normalizeBlocks(v.blocks);
  v.wordCount = wordsOf(v);
  v.reason = str(v.reason);
  v.createdAt = Number(v.createdAt) || 0;
  return v;
}

// Newest first; ties broken by id (descending) so the order is stable.
function byNewest(a, b){
  return (b.createdAt - a.createdAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

function wordsOf(rec){
  var n = rec && rec.wordCount;
  return typeof n === "number" && isFinite(n) ? Math.max(0, n) : countWords(blocksToText(rec && rec.blocks));
}

export function createStore(handle, deps){
  deps = deps || {};
  var uid = deps.uid || defaultUid;
  var now = deps.now || Date.now;
  var db = handle;

  function bibleFor(project, raw){
    var b = normalizeBible(raw);
    if(raw == null) b.id = project.bibleId;
    b.projectId = project.id;
    return b;
  }

  function threadFor(project, raw){
    var t = raw == null ? emptyThread(project.threadId, project.id) : normalizeThread(raw);
    t.projectId = project.id;
    return t;
  }

  async function getMeta(){
    var m = await db.get("meta", "app");
    return Object.assign({ id: "app", schema: 2, migratedV1At: 0, currentProjectId: null, lastRoute: "" }, m || {});
  }

  async function setMeta(patch){
    var m = Object.assign(await getMeta(), patch || {}, { id: "app" });
    await db.put("meta", m);
    return m;
  }

  async function init(opts){
    opts = opts || {};
    var meta = await getMeta();
    if(meta.migratedV1At) return meta;
    var t = now();
    var projects = await db.getAll("projects");
    if(projects.length){
      meta.migratedV1At = t;
      meta.schema = 2;
      if(!meta.currentProjectId || !projects.some(function(p){ return p.id === meta.currentProjectId; })){
        projects.sort(function(a, b){ return (b.updatedAt || 0) - (a.updatedAt || 0); });
        meta.currentProjectId = projects[0].id;
      }
      await db.put("meta", meta);
      return meta;
    }
    var rawBible = await db.get("bible", "default");
    var rawThread = await db.get("threads", "default");
    var pid = uid();
    var project = { id: pid, title: "My project", bibleId: "default", threadId: "default",
      lastSceneId: null, createdAt: t, updatedAt: t, stats: emptyStats() };
    var bible = normalizeBible(rawBible, opts.legacySystem);
    bible.id = "default";
    bible.projectId = pid;
    var thread = threadFor(project, rawThread);
    thread.id = "default";
    meta.schema = 2;
    meta.migratedV1At = t;
    meta.currentProjectId = pid;
    await db.batch([put("bible", bible), put("threads", thread), put("projects", project), put("meta", meta)]);
    return meta;
  }

  function countBy(store, index, value){
    if(typeof db.count === "function") return db.count(store, index, value);
    return db.getAllBy(store, index, value).then(function(l){ return l.length; });
  }

  // Writes recomputed stats onto the project record (nothing else changes, updatedAt included).
  function storeStats(pid, st){
    return db.patch("projects", pid, function(p){ p.stats = st; return p; }).catch(function(){});
  }

  async function recomputeStats(pid){
    var chapters = await db.getAllBy("chapters", "projectId", pid);
    var scenes = await db.getAllBy("scenes", "projectId", pid);
    var st = statsOf(chapters, scenes);
    await storeStats(pid, st);
    return st;
  }

  // Stored stats are trusted when their chapter and scene counts match the records (counted without
  // reading them); otherwise, or when missing, they are recomputed from the project's records and saved.
  async function statsFor(p){
    if(validStats(p.stats)){
      var n = await Promise.all([countBy("chapters", "projectId", p.id), countBy("scenes", "projectId", p.id)]);
      if(n[0] === p.stats.chapters && n[1] === p.stats.scenes) return { chapters: n[0], scenes: n[1], words: p.stats.words };
    }
    return recomputeStats(p.id);
  }

  async function listProjects(){
    var projects = await db.getAll("projects");
    var stats = await Promise.all(projects.map(statsFor));
    return projects.map(function(p, i){ return Object.assign({}, p, { stats: stats[i] }); })
      .sort(function(a, b){ return (b.updatedAt || 0) - (a.updatedAt || 0); });
  }

  function getProject(id){ return db.get("projects", id); }

  async function createProject(title){
    var t = now(), pid = uid();
    while(await db.get("projects", pid)) pid = uid();
    var project = { id: pid, title: str(title).trim() || "Untitled project", bibleId: "b-" + pid,
      threadId: "t-" + pid, lastSceneId: null, createdAt: t, updatedAt: t, stats: emptyStats() };
    var bible = Object.assign(emptyBible(), { id: project.bibleId, projectId: pid });
    var thread = emptyThread(project.threadId, pid);
    await db.batch([put("projects", project), put("bible", bible), put("threads", thread)]);
    return project;
  }

  async function renameProject(id, title){
    var t = now();
    return db.patch("projects", id, function(p){
      p.title = str(title).trim() || p.title;
      p.updatedAt = t;
      return p;
    });
  }

  async function sceneDeleteOps(scenes){
    var ops = [];
    for(var i = 0; i < scenes.length; i++){
      var versions = await db.getAllBy("versions", "sceneId", scenes[i].id);
      versions.forEach(function(v){ ops.push(del("versions", v.id)); });
      ops.push(del("threads", sceneThreadId(scenes[i].id)));
      ops.push(del("scenes", scenes[i].id));
    }
    return ops;
  }

  async function projectDeleteOps(p){
    var ops = [];
    var chapters = await db.getAllBy("chapters", "projectId", p.id);
    var scenes = await db.getAllBy("scenes", "projectId", p.id);
    ops = ops.concat(await sceneDeleteOps(scenes));
    chapters.forEach(function(c){ ops.push(del("chapters", c.id)); });
    if(p.bibleId) ops.push(del("bible", p.bibleId));
    var threadIds = (await db.getAllBy("threads", "projectId", p.id)).map(function(t){ return t.id; });
    if(p.threadId) threadIds.push(p.threadId);
    threadIds.filter(function(id, i){ return threadIds.indexOf(id) === i; })
      .forEach(function(id){ ops.push(del("threads", id)); });
    ops.push(del("projects", p.id));
    return ops;
  }

  async function deleteProject(id){
    var p = await db.get("projects", id);
    if(!p) return false;
    var ops = await projectDeleteOps(p);
    var meta = await db.get("meta", "app");
    if(meta && meta.currentProjectId === id){
      meta.currentProjectId = null;
      ops.push(put("meta", meta));
    }
    await db.batch(ops);
    return true;
  }

  async function chaptersOf(pid){ return (await db.getAllBy("chapters", "projectId", pid)).sort(byOrder); }
  async function scenesOf(chapterId){ return (await db.getAllBy("scenes", "chapterId", chapterId)).sort(byOrder); }

  // Scenes carry textHash (filled in for older records) and stale: a summary exists and was written
  // for other text. The loaded records also heal the project's stored stats when they drifted.
  async function getOutline(pid){
    var project = await db.get("projects", pid);
    if(!project) return null;
    var chapters = await chaptersOf(pid);
    var scenes = await db.getAllBy("scenes", "projectId", pid);
    scenes.forEach(function(s){
      s.textHash = sceneTextHash(s);
      s.stale = !!str(s.summary).trim() && s.textHash !== str(s.summaryHash);
    });
    var st = statsOf(chapters, scenes);
    if(!sameStats(project.stats, st)){ project.stats = st; await storeStats(pid, st); }
    return { project: project, chapters: chapters.map(function(c){
      return Object.assign({}, c, { scenes: scenes.filter(function(s){ return s.chapterId === c.id; }).sort(byOrder) });
    }) };
  }

  // The project update of a change: a patch op (applied inside the change's transaction, so concurrent
  // changes cannot overwrite each other's stats) with a fresh updatedAt, optional stat deltas and mutate.
  async function touchOps(pid, t, mutate, delta){
    return [patchOp("projects", pid, function(p){
      if(mutate) mutate(p);
      if(delta) bumpStats(p, delta);
      p.updatedAt = t;
      return p;
    })];
  }

  // Renumber a sorted sibling list densely; returns puts for changed records.
  function renumber(store, list){
    var ops = [];
    list.forEach(function(r, i){ if(r.order !== i){ r.order = i; ops.push(put(store, r)); } });
    return ops;
  }

  async function addChapter(pid, title){
    if(!(await db.get("projects", pid))) return null;
    var t = now();
    var siblings = await chaptersOf(pid);
    var ch = { id: uid(), projectId: pid, order: siblings.length,
      title: str(title).trim() || "Chapter " + (siblings.length + 1), createdAt: t, updatedAt: t };
    await db.batch([put("chapters", ch)].concat(await touchOps(pid, t, null, { chapters: 1 })));
    return ch;
  }

  async function renameChapter(id, title){
    var ch = await db.get("chapters", id);
    if(!ch) return null;
    var t = now();
    ch.title = str(title).trim() || ch.title;
    ch.updatedAt = t;
    await db.batch([put("chapters", ch)].concat(await touchOps(ch.projectId, t)));
    return ch;
  }

  async function deleteChapter(id){
    var ch = await db.get("chapters", id);
    if(!ch) return false;
    var t = now();
    var scenes = await scenesOf(id);
    var ops = await sceneDeleteOps(scenes);
    ops.push(del("chapters", id));
    var rest = (await chaptersOf(ch.projectId)).filter(function(c){ return c.id !== id; });
    ops = ops.concat(renumber("chapters", rest));
    var ids = scenes.map(function(s){ return s.id; });
    var words = scenes.reduce(function(a, s){ return a + wordsOf(s); }, 0);
    ops = ops.concat(await touchOps(ch.projectId, t, function(p){
      if(p.lastSceneId && ids.indexOf(p.lastSceneId) >= 0) p.lastSceneId = null;
    }, { chapters: -1, scenes: -scenes.length, words: -words }));
    await db.batch(ops);
    return true;
  }

  async function moveChapter(id, dir){
    var ch = await db.get("chapters", id);
    if(!ch) return false;
    var list = await chaptersOf(ch.projectId);
    var i = list.findIndex(function(c){ return c.id === id; });
    var j = i + (dir < 0 ? -1 : 1);
    if(j < 0 || j >= list.length) return false;
    var tmp = list[i]; list[i] = list[j]; list[j] = tmp;
    var t = now();
    var ops = renumber("chapters", list);
    await db.batch(ops.concat(await touchOps(ch.projectId, t)));
    return true;
  }

  async function addScene(chapterId, title){
    var ch = await db.get("chapters", chapterId);
    if(!ch) return null;
    var t = now();
    var siblings = await scenesOf(chapterId);
    var sc = { id: uid(), projectId: ch.projectId, chapterId: chapterId, order: siblings.length,
      title: str(title).trim() || "Scene " + (siblings.length + 1), blocks: [], summary: "", summaryHash: "",
      summaryUpdatedAt: 0, summaryModel: "", wordCount: 0, textHash: hashText(""), createdAt: t, updatedAt: t };
    await db.batch([put("scenes", sc)].concat(await touchOps(ch.projectId, t, null, { scenes: 1 })));
    return sc;
  }

  async function renameScene(id, title){
    var sc = await db.get("scenes", id);
    if(!sc) return null;
    var t = now();
    sc.title = str(title).trim() || sc.title;
    sc.updatedAt = t;
    await db.batch([put("scenes", sc)].concat(await touchOps(sc.projectId, t)));
    return sc;
  }

  async function deleteScene(id){
    var sc = await db.get("scenes", id);
    if(!sc) return false;
    var t = now();
    var ops = await sceneDeleteOps([sc]);
    var rest = (await scenesOf(sc.chapterId)).filter(function(s){ return s.id !== id; });
    ops = ops.concat(renumber("scenes", rest));
    ops = ops.concat(await touchOps(sc.projectId, t, function(p){
      if(p.lastSceneId === id) p.lastSceneId = null;
    }, { scenes: -1, words: -wordsOf(sc) }));
    await db.batch(ops);
    return true;
  }

  // Moves within the chapter; at a chapter edge it moves to the end of the previous chapter
  // (dir < 0) or the start of the next one (dir > 0). No-op at the book edges.
  async function moveScene(id, dir){
    var sc = await db.get("scenes", id);
    if(!sc) return false;
    var up = dir < 0;
    var list = await scenesOf(sc.chapterId);
    var i = list.findIndex(function(s){ return s.id === id; });
    var j = i + (up ? -1 : 1);
    var t = now(), ops;
    if(j >= 0 && j < list.length){
      var tmp = list[i]; list[i] = list[j]; list[j] = tmp;
      ops = renumber("scenes", list);
    }else{
      var chapters = await chaptersOf(sc.projectId);
      var ci = chapters.findIndex(function(c){ return c.id === sc.chapterId; });
      var target = chapters[ci + (up ? -1 : 1)];
      if(ci < 0 || !target) return false;
      var from = list.filter(function(s){ return s.id !== id; });
      var to = await scenesOf(target.id);
      var moved = list[i];
      moved.chapterId = target.id;
      moved.updatedAt = t;
      if(up) to.push(moved); else to.unshift(moved);
      ops = renumber("scenes", from).concat(renumber("scenes", to));
      if(!ops.some(function(op){ return op.value === moved; })) ops.push(put("scenes", moved));
    }
    await db.batch(ops.concat(await touchOps(sc.projectId, t)));
    return true;
  }

  async function getScene(id){
    var sc = await db.get("scenes", id);
    return sc ? normalizeScene(sc) : sc;
  }

  // Saves content fields; structural fields (projectId, chapterId, order, createdAt) come from the
  // stored record so a stale copy cannot undo a move. Returns null if the scene no longer exists.
  async function saveScene(scene){
    if(!scene || !scene.id) return null;
    var cur = await db.get("scenes", scene.id);
    if(!cur) return null;
    var t = now();
    var next = withTextHash(normalizeScene(Object.assign({}, cur, scene, {
      id: cur.id, projectId: cur.projectId, chapterId: cur.chapterId, order: cur.order,
      createdAt: cur.createdAt, updatedAt: t })));
    await db.batch([put("scenes", next)].concat(await touchOps(cur.projectId, t, null, { words: next.wordCount - wordsOf(cur) })));
    return next;
  }

  // Summary fields only, in one transaction; never touches blocks or the project record.
  var SUMMARY_FIELDS = ["summary", "summaryHash", "summaryUpdatedAt", "summaryModel"];
  async function patchScene(id, fields){
    var f = fields || {};
    var t = now();
    var rec = await db.patch("scenes", id, function(cur){
      var next = Object.assign({}, cur);
      SUMMARY_FIELDS.forEach(function(k){ if(k in f) next[k] = f[k]; });
      next.updatedAt = t;
      return normalizeScene(next);
    });
    return rec ? normalizeScene(rec) : null;
  }

  function getChapter(id){ return db.get("chapters", id); }

  // Scenes in outline order; scenes whose chapter is missing go last.
  async function orderedScenes(pid){
    var chapters = await chaptersOf(pid);
    var pos = {};
    chapters.forEach(function(c, i){ pos[c.id] = i; });
    var scenes = (await db.getAllBy("scenes", "projectId", pid)).map(normalizeScene).sort(function(a, b){
      var pa = a.chapterId in pos ? pos[a.chapterId] : chapters.length;
      var pb = b.chapterId in pos ? pos[b.chapterId] : chapters.length;
      return (pa - pb) || byOrder(a, b);
    });
    return { chapters: chapters, scenes: scenes };
  }

  async function listSceneSummaries(pid){
    if(!(await db.get("projects", pid))) return [];
    var o = await orderedScenes(pid);
    var titles = {};
    o.chapters.forEach(function(c){ titles[c.id] = str(c.title); });
    return o.scenes.map(function(s){
      return { id: s.id, chapterId: s.chapterId, chapterTitle: titles[s.chapterId] || "", order: s.order,
        title: s.title, summary: s.summary, summaryHash: s.summaryHash, summaryUpdatedAt: s.summaryUpdatedAt,
        summaryModel: s.summaryModel, wordCount: s.wordCount,
        textHash: sceneTextHash(s), stale: s.summary ? sceneTextHash(s) !== s.summaryHash : false };
    });
  }

  async function listVersions(sceneId){
    return (await db.getAllBy("versions", "sceneId", sceneId)).map(normalizeVersion).sort(byNewest);
  }

  async function getVersion(id){
    var v = await db.get("versions", id);
    return v ? normalizeVersion(v) : v;
  }

  // Snapshot of the stored scene `cur` given its versions (newest first). Returns
  // { version, ops }: version is null when the newest version already holds the same text, or
  // when opts.skipEmpty and the scene has no blocks and no versions. ops = put of the version
  // (if any) plus dels of the oldest versions beyond MAX_VERSIONS_PER_SCENE.
  function snapshotOps(cur, existing, reason, t, opts){
    var blocks = normalizeBlocks(cur.blocks);
    var text = blocksToText(blocks);
    var version = null;
    var dup = existing.length > 0 && blocksToText(existing[0].blocks) === text;
    var empty = opts && opts.skipEmpty && blocks.length === 0 && existing.length === 0;
    if(!dup && !empty){
      var id = uid();
      while(existing.some(function(v){ return v.id === id; })) id = uid();
      version = { id: id, sceneId: cur.id, projectId: cur.projectId, blocks: blocks,
        wordCount: wordsOf(cur), reason: str(reason), createdAt: t };
    }
    var all = version ? [version].concat(existing) : existing;
    var ops = version ? [put("versions", version)] : [];
    all.slice(MAX_VERSIONS_PER_SCENE).reverse().forEach(function(v){ ops.push(del("versions", v.id)); });
    return { version: version, ops: ops };
  }

  // Snapshots the stored scene as a version. Null for an unknown scene or a duplicate snapshot.
  async function addVersion(sceneId, reason){
    var cur = await db.get("scenes", sceneId);
    if(!cur) return null;
    var snap = snapshotOps(cur, await listVersions(sceneId), reason, now());
    if(!snap.version) return null;
    await db.batch(snap.ops);
    return snap.version;
  }

  // saveScene plus a snapshot of the text it replaces, in one batch: [put version, put scene,
  // put project, ...del pruned versions]. Returns { scene, version } (version null when skipped)
  // or null when the scene no longer exists.
  async function saveSceneWithVersion(scene, opts){
    if(!scene || !scene.id) return null;
    var cur = await db.get("scenes", scene.id);
    if(!cur) return null;
    var t = now();
    var snap = snapshotOps(cur, await listVersions(cur.id), opts && opts.reason, t, { skipEmpty: true });
    var merged = Object.assign({}, cur, scene, {
      id: cur.id, projectId: cur.projectId, chapterId: cur.chapterId, order: cur.order,
      createdAt: cur.createdAt, updatedAt: t });
    if(scene.wordCount == null) merged.wordCount = countWords(blocksToText(normalizeBlocks(merged.blocks)));
    var next = withTextHash(normalizeScene(merged));
    var ops = (snap.version ? [snap.ops[0]] : []).concat([put("scenes", next)],
      await touchOps(cur.projectId, t, null, { words: next.wordCount - wordsOf(cur) }), snap.version ? snap.ops.slice(1) : snap.ops);
    await db.batch(ops);
    return { scene: next, version: snap.version };
  }

  // Puts a version's text back; the current text is snapshotted first (reason "restore").
  async function restoreVersion(versionId){
    var v = await getVersion(versionId);
    if(!v) return null;
    return saveSceneWithVersion({ id: v.sceneId, blocks: v.blocks, wordCount: wordsOf(v) }, { reason: "restore" });
  }

  async function getBible(project){
    if(!project) return null;
    return bibleFor(project, await db.get("bible", project.bibleId));
  }

  async function saveBible(pid, bible){
    var b = normalizeBible(bible);
    if(bible && bible.id) b.id = str(bible.id);
    b.projectId = pid;
    await db.put("bible", b);
    return b;
  }

  async function getThread(project){
    if(!project) return null;
    return threadFor(project, await db.get("threads", project.threadId));
  }

  async function saveThread(pid, thread){
    var t = Object.assign({}, thread, { projectId: pid });
    await db.put("threads", t);
    return t;
  }

  // Absent record means an empty thread; ids and scope always follow the scene.
  async function getSceneThread(scene){
    if(!scene || !scene.id) return null;
    var id = sceneThreadId(scene.id);
    var raw = await db.get("threads", id);
    var t = raw == null ? emptyThread(id, scene.projectId) : normalizeThread(raw);
    t.id = id;
    t.projectId = scene.projectId;
    t.scope = "scene";
    t.sceneId = scene.id;
    return t;
  }

  async function setLastScene(pid, sid){
    return db.patch("projects", pid, function(p){ p.lastSceneId = sid || null; return p; });
  }

  // Everything a bundle needs: { project, bible, thread, chapters, scenes, sceneThreads } sorted by
  // outline order. sceneThreads holds only stored threads of scenes that still exist.
  async function loadProjectData(pid){
    var project = await db.get("projects", pid);
    if(!project) return null;
    var o = await orderedScenes(pid);
    var idx = {};
    o.scenes.forEach(function(s, i){ idx[s.id] = i; });
    var sceneThreads = (await db.getAllBy("threads", "projectId", pid)).map(normalizeThread)
      .filter(function(t){ return t.scope === "scene" && t.sceneId in idx; })
      .sort(function(a, b){ return idx[a.sceneId] - idx[b.sceneId]; });
    return { project: project, bible: await getBible(project), thread: await getThread(project),
      chapters: o.chapters, scenes: o.scenes, sceneThreads: sceneThreads };
  }

  // mode "copy" (default): new ids for project/chapters/scenes/bible/thread; suffix " (imported)"
  // unless opts.suffix === false. mode "replace": keeps ids, removes the existing project first.
  async function importProject(data, opts){
    opts = opts || {};
    var mode = opts.mode === "replace" ? "replace" : "copy";
    data = data && typeof data === "object" ? data : {};
    var src = data.project && typeof data.project === "object" ? data.project : {};
    var t = now();
    var ops = [];
    var pid;
    if(mode === "copy" || !src.id){
      pid = uid();
      while(await db.get("projects", pid)) pid = uid();
    }else{
      pid = str(src.id);
      var existing = await db.get("projects", pid);
      if(existing) ops = ops.concat(await projectDeleteOps(existing));
    }
    var keep = mode === "replace";
    var chapterIds = {}, sceneIds = {};
    var chapters = arr(data.chapters).filter(function(c){ return c && typeof c === "object"; })
      .slice().sort(byOrder).map(function(c, i){
        var id = keep && c.id ? str(c.id) : uid();
        if(c.id != null) chapterIds[str(c.id)] = id;
        return Object.assign({}, c, { id: id, projectId: pid, order: i, title: str(c.title),
          createdAt: Number(c.createdAt) || t, updatedAt: Number(c.updatedAt) || t });
      });
    var perChapter = {};
    arr(data.scenes).forEach(function(s){
      if(!s || typeof s !== "object") return;
      var cid = chapterIds[str(s.chapterId)];
      if(!cid) return; // orphan scene: its chapter is not in the bundle
      (perChapter[cid] = perChapter[cid] || []).push(s);
    });
    var scenes = [];
    Object.keys(perChapter).forEach(function(cid){
      perChapter[cid].sort(byOrder).forEach(function(s, i){
        var id = keep && s.id ? str(s.id) : uid();
        if(s.id != null) sceneIds[str(s.id)] = id;
        scenes.push(withTextHash(normalizeScene(Object.assign({}, s, { id: id, projectId: pid, chapterId: cid, order: i,
          createdAt: Number(s.createdAt) || t, updatedAt: Number(s.updatedAt) || t }))));
      });
    });
    var title = str(src.title).trim() || "Imported project";
    if(mode === "copy" && opts.suffix !== false) title += " (imported)";
    var bibleId = keep ? str(src.bibleId || (data.bible && data.bible.id)) || "b-" + pid : "b-" + pid;
    var threadId = keep ? str(src.threadId || (data.thread && data.thread.id)) || "t-" + pid : "t-" + pid;
    var project = Object.assign({}, src, { id: pid, title: title, bibleId: bibleId, threadId: threadId,
      lastSceneId: sceneIds[str(src.lastSceneId)] || null,
      createdAt: Number(src.createdAt) || t, updatedAt: t, stats: statsOf(chapters, scenes) });
    var bible = normalizeBible(data.bible && typeof data.bible === "object" ? data.bible : {});
    bible.id = bibleId;
    bible.projectId = pid;
    var thread = normalizeThread(Object.assign({}, data.thread && typeof data.thread === "object" ? data.thread : {},
      { id: threadId, projectId: pid }));
    ops.push(put("projects", project), put("bible", bible), put("threads", thread));
    chapters.forEach(function(c){ ops.push(put("chapters", c)); });
    scenes.forEach(function(s){ ops.push(put("scenes", s)); });
    // Scene threads follow their scene's (possibly new) id; unmapped ones are dropped.
    var threadSeen = {};
    arr(data.sceneThreads).forEach(function(st){
      if(!st || typeof st !== "object" || st.sceneId == null) return;
      var sid = sceneIds[str(st.sceneId)];
      if(!sid || threadSeen[sid]) return;
      threadSeen[sid] = true;
      ops.push(put("threads", normalizeThread(Object.assign({}, st, { id: sceneThreadId(sid), projectId: pid,
        scope: "scene", sceneId: sid }))));
    });
    await db.batch(ops);
    return pid;
  }

  return {
    init: init, getMeta: getMeta, setMeta: setMeta,
    listProjects: listProjects, getProject: getProject, createProject: createProject,
    renameProject: renameProject, deleteProject: deleteProject,
    getOutline: getOutline, addChapter: addChapter, renameChapter: renameChapter,
    deleteChapter: deleteChapter, moveChapter: moveChapter,
    addScene: addScene, renameScene: renameScene, deleteScene: deleteScene, moveScene: moveScene,
    getScene: getScene, saveScene: saveScene, patchScene: patchScene, getChapter: getChapter,
    listSceneSummaries: listSceneSummaries, getSceneThread: getSceneThread,
    listVersions: listVersions, getVersion: getVersion, addVersion: addVersion,
    saveSceneWithVersion: saveSceneWithVersion, restoreVersion: restoreVersion,
    getBible: getBible, saveBible: saveBible, getThread: getThread, saveThread: saveThread,
    setLastScene: setLastScene, loadProjectData: loadProjectData, importProject: importProject
  };
}
