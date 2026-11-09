import test from "node:test";
import assert from "node:assert/strict";
import { memoryHandle } from "./db.js";
import { createStore, emptyThread, normalizeThread, sceneThreadId, sceneTextHash, validStats, MAX_VERSIONS_PER_SCENE } from "./store.js";
import { hashText } from "./util.js";
import { blocksToText } from "./scene.js";

function setup(){
  const h = memoryHandle();
  let n = 0, t = 1000;
  const store = createStore(h, { uid: () => "id" + (++n), now: () => ++t });
  return { h, store };
}

async function book(store){
  const p = await store.createProject("Book");
  const c1 = await store.addChapter(p.id, "One");
  const c2 = await store.addChapter(p.id, "Two");
  const a = await store.addScene(c1.id, "A");
  const b = await store.addScene(c1.id, "B");
  const c = await store.addScene(c2.id, "C");
  return { p, c1, c2, a, b, c };
}

const titles = (o) => o.chapters.map((c) => c.title + ":" + c.scenes.map((s) => s.title + s.order).join(","));

test("memory handle: getAll, getAllBy and batch", async () => {
  const h = memoryHandle();
  await h.batch([
    { type: "put", store: "scenes", value: { id: "s1", chapterId: "c1" } },
    { type: "put", store: "scenes", value: { id: "s2", chapterId: "c2" } },
    { type: "put", store: "scenes", value: { id: "s3", chapterId: "c1" } },
    { type: "del", store: "scenes", id: "s3" }
  ]);
  assert.deepEqual((await h.getAll("scenes")).map((s) => s.id).sort(), ["s1", "s2"]);
  assert.deepEqual((await h.getAllBy("scenes", "chapterId", "c1")).map((s) => s.id), ["s1"]);
  const got = await h.get("scenes", "s1");
  got.chapterId = "x";
  assert.equal((await h.get("scenes", "s1")).chapterId, "c1");
  await assert.rejects(h.batch([{ type: "bogus", store: "scenes" }]));
});

test("fresh install creates one project adopting the default ids", async () => {
  const { h, store } = setup();
  const meta = await store.init({ legacySystem: "  Be terse. " });
  const list = await store.listProjects();
  assert.equal(list.length, 1);
  const p = list[0];
  assert.equal(p.title, "My project");
  assert.equal(p.bibleId, "default");
  assert.equal(p.threadId, "default");
  assert.equal(p.lastSceneId, null);
  assert.equal(meta.currentProjectId, p.id);
  assert.equal(meta.schema, 2);
  assert.ok(meta.migratedV1At > 0);
  const bible = await h.get("bible", "default");
  assert.equal(bible.styleGuide, "Be terse.");
  assert.equal(bible.projectId, p.id);
  const thread = await h.get("threads", "default");
  assert.equal(thread.projectId, p.id);
  assert.equal(thread.scope, "project");
  assert.equal(thread.includeScene, true);
  assert.deepEqual(thread.messages, []);
  assert.deepEqual(await store.getMeta(), await h.get("meta", "app"));
});

test("v1 records are adopted intact", async () => {
  const { h, store } = setup();
  const messages = [{ id: "m1", role: "user", content: "hi" }, { id: "m2", role: "assistant", content: "yo" }];
  await h.put("threads", { id: "default", messages, summary: "S", summarizedUpTo: 1, summarizedUpToId: "m1",
    summaryModel: "x", summaryUpdatedAt: 5, lastUsage: { prompt: 3 }, updatedAt: 9 });
  await h.put("bible", { id: "default", v: 1, brief: "Brief", styleGuide: "Old style",
    cards: [{ id: "k1", name: "Liz", type: "character", aliases: ["Lizzie"] }], updatedAt: 7 });
  await store.init({ legacySystem: "ignored" });
  const [p] = await store.listProjects();
  const t = await store.getThread(p);
  assert.deepEqual(t.messages, messages);
  assert.equal(t.summary, "S");
  assert.equal(t.summarizedUpTo, 1);
  assert.deepEqual(t.lastUsage, { prompt: 3 });
  assert.equal(t.projectId, p.id);
  assert.equal(t.id, "default");
  const b = await store.getBible(p);
  assert.equal(b.styleGuide, "Old style");
  assert.equal(b.brief, "Brief");
  assert.equal(b.cards[0].id, "k1");
  assert.deepEqual(b.cards[0].aliases, ["Lizzie"]);
  assert.equal(b.projectId, p.id);
  assert.equal((await h.get("threads", "default")).summary, "S");
});

test("init is idempotent and recovers a missing flag", async () => {
  const { store } = setup();
  await store.init({});
  await store.init({});
  await store.init({});
  assert.equal((await store.listProjects()).length, 1);

  const h2 = memoryHandle();
  const s2 = createStore(h2);
  const p = await s2.createProject("Existing");
  const meta = await s2.init({ legacySystem: "x" });
  assert.ok(meta.migratedV1At > 0);
  assert.equal(meta.currentProjectId, p.id);
  assert.equal((await s2.listProjects()).length, 1);
  assert.equal(await h2.get("bible", "default"), undefined);
});

test("after deleting all projects init does not recreate one", async () => {
  const { store } = setup();
  const meta = await store.init({});
  await store.deleteProject(meta.currentProjectId);
  assert.equal((await store.getMeta()).currentProjectId, null);
  await store.init({});
  assert.equal((await store.listProjects()).length, 0);
});

test("createProject makes bible and thread with unique ids", async () => {
  const { h, store } = setup();
  const a = await store.createProject("A");
  const b = await store.createProject("  ");
  assert.notEqual(a.id, b.id);
  assert.equal(b.title, "Untitled project");
  assert.equal(a.bibleId, "b-" + a.id);
  assert.equal(a.threadId, "t-" + a.id);
  assert.equal((await h.get("bible", a.bibleId)).projectId, a.id);
  const t = await h.get("threads", a.threadId);
  assert.deepEqual(t, emptyThread("t-" + a.id, a.id));
  // A uid collision is skipped.
  const h2 = memoryHandle();
  let calls = 0;
  const s2 = createStore(h2, { uid: () => (++calls <= 2 ? "same" : "other" + calls) });
  const x = await s2.createProject("X");
  const y = await s2.createProject("Y");
  assert.notEqual(x.id, y.id);
});

test("listProjects sorts by updatedAt desc with stats", async () => {
  const { store } = setup();
  const { p, a, c } = await book(store);
  const other = await store.createProject("Other");
  let list = await store.listProjects();
  assert.deepEqual(list.map((x) => x.title), ["Other", "Book"]);
  assert.deepEqual(list[0].stats, { chapters: 0, scenes: 0, words: 0 });
  await store.saveScene({ ...a, wordCount: 10 });
  await store.saveScene({ ...c, wordCount: 5 });
  list = await store.listProjects();
  assert.equal(list[0].id, p.id);
  assert.deepEqual(list[0].stats, { chapters: 2, scenes: 3, words: 15 });
  await store.renameProject(other.id, "Renamed");
  list = await store.listProjects();
  assert.equal(list[0].title, "Renamed");
});

test("chapters: add, rename, move with edges, delete with cascade and renumber", async () => {
  const { h, store } = setup();
  const { p, c1, c2, a } = await book(store);
  const c3 = await store.addChapter(p.id, "");
  assert.equal(c3.title, "Chapter 3");
  assert.equal(c3.order, 2);
  assert.equal(await store.moveChapter(c1.id, -1), false);
  assert.equal(await store.moveChapter(c3.id, 1), false);
  assert.equal(await store.moveChapter(c1.id, 1), true);
  let o = await store.getOutline(p.id);
  assert.deepEqual(o.chapters.map((c) => c.title + c.order), ["Two0", "One1", "Chapter 32"]);
  await store.renameChapter(c2.id, "Deux");
  await h.put("versions", { id: "v1", sceneId: a.id });
  await store.setLastScene(p.id, a.id);
  assert.equal(await store.deleteChapter(c1.id), true);
  o = await store.getOutline(p.id);
  assert.deepEqual(o.chapters.map((c) => c.title + c.order), ["Deux0", "Chapter 31"]);
  assert.equal(await h.get("scenes", a.id), undefined);
  assert.equal(await h.get("versions", "v1"), undefined);
  assert.equal((await store.getProject(p.id)).lastSceneId, null);
  assert.equal(await store.addChapter("nope", "x"), null);
});

test("scenes: add, move within, across chapters, book edges, delete", async () => {
  const { store } = setup();
  const { p, c1, c2, a, b, c } = await book(store);
  const empty = await store.addChapter(p.id, "Three");
  assert.equal(await store.moveScene(a.id, -1), false);
  assert.equal(await store.moveScene(b.id, -1), true);
  assert.deepEqual(titles(await store.getOutline(p.id)), ["One:B0,A1", "Two:C0", "Three:"]);
  assert.equal(await store.moveScene(a.id, 1), true); // crosses into Two at the start
  assert.deepEqual(titles(await store.getOutline(p.id)), ["One:B0", "Two:A0,C1", "Three:"]);
  assert.equal(await store.moveScene(a.id, -1), true); // back to the end of One
  assert.deepEqual(titles(await store.getOutline(p.id)), ["One:B0,A1", "Two:C0", "Three:"]);
  assert.equal(await store.moveScene(c.id, 1), true); // into the empty chapter
  assert.deepEqual(titles(await store.getOutline(p.id)), ["One:B0,A1", "Two:", "Three:C0"]);
  assert.equal(await store.moveScene(c.id, 1), false); // book edge
  assert.equal((await store.getScene(c.id)).chapterId, empty.id);
  const d = await store.addScene(c1.id, "");
  assert.equal(d.title, "Scene 3");
  assert.equal(d.order, 2);
  assert.equal(d.projectId, p.id);
  await store.renameScene(d.id, "D");
  await store.setLastScene(p.id, b.id);
  assert.equal(await store.deleteScene(b.id), true);
  assert.deepEqual(titles(await store.getOutline(p.id)), ["One:A0,D1", "Two:", "Three:C0"]);
  assert.equal((await store.getProject(p.id)).lastSceneId, null);
  await store.setLastScene(p.id, a.id);
  await store.deleteScene(d.id);
  assert.equal((await store.getProject(p.id)).lastSceneId, a.id);
  void c2;
});

test("saveScene bumps project.updatedAt and keeps structure", async () => {
  const { store } = setup();
  const { p, c2, a } = await book(store);
  const before = (await store.getProject(p.id)).updatedAt;
  const stale = await store.getScene(a.id);
  await store.moveScene(a.id, 1);
  await store.moveScene(a.id, 1); // now in chapter Two
  const saved = await store.saveScene({ ...stale, blocks: [{ id: "x", text: "Hello there" }], wordCount: 2 });
  assert.equal(saved.chapterId, c2.id);
  const got = await store.getScene(a.id);
  assert.deepEqual(got.blocks, [{ id: "x", text: "Hello there" }]);
  assert.equal(got.wordCount, 2);
  assert.ok((await store.getProject(p.id)).updatedAt > before);
  assert.equal(await store.saveScene({ id: "gone" }), null);
});

test("bible and thread save re-set projectId", async () => {
  const { store } = setup();
  const p = await store.createProject("P");
  const b = await store.getBible(p);
  b.brief = "Hi";
  b.projectId = "wrong";
  await store.saveBible(p.id, b);
  const b2 = await store.getBible(p);
  assert.equal(b2.brief, "Hi");
  assert.equal(b2.projectId, p.id);
  assert.equal(b2.id, p.bibleId);
  const t = await store.getThread(p);
  t.messages.push({ id: "m", role: "user", content: "x" });
  await store.saveThread(p.id, { ...t, projectId: null });
  const t2 = await store.getThread(p);
  assert.equal(t2.messages.length, 1);
  assert.equal(t2.projectId, p.id);
  assert.equal(normalizeThread({ messages: [], summarizedUpTo: 3, summary: "s" }).summary, "");
  await store.setMeta({ lastRoute: "#/library" });
  assert.equal((await store.getMeta()).lastRoute, "#/library");
});

test("deleteProject cascades and leaves other projects", async () => {
  const { h, store } = setup();
  const { p, a } = await book(store);
  const keep = await book(store);
  await h.put("versions", { id: "v", sceneId: a.id });
  await store.setMeta({ currentProjectId: keep.p.id });
  assert.equal(await store.deleteProject(p.id), true);
  assert.ok((await h.getAll("scenes")).every((r) => r.projectId === keep.p.id));
  assert.ok((await h.getAll("chapters")).every((r) => r.projectId === keep.p.id));
  assert.equal((await h.getAllBy("scenes", "projectId", p.id)).length, 0);
  assert.equal((await h.getAllBy("chapters", "projectId", p.id)).length, 0);
  assert.equal(await h.get("versions", "v"), undefined);
  assert.equal(await h.get("bible", p.bibleId), undefined);
  assert.equal(await h.get("threads", p.threadId), undefined);
  assert.equal((await store.listProjects()).length, 1);
  assert.equal((await store.getOutline(keep.p.id)).chapters.length, 2);
  assert.equal((await store.getMeta()).currentProjectId, keep.p.id);
  assert.equal(await store.deleteProject("nope"), false);
});

test("importProject copy: new ids, consistent references, suffix", async () => {
  const { h, store } = setup();
  const { p, a } = await book(store);
  await store.setLastScene(p.id, a.id);
  const t = await store.getThread(p);
  t.messages.push({ id: "msg1", role: "user", content: "hi" });
  await store.saveThread(p.id, t);
  const b = await store.getBible(p);
  b.cards = [{ id: "card1", name: "Liz" }];
  await store.saveBible(p.id, b);
  const data = await store.loadProjectData(p.id);
  assert.deepEqual(data.scenes.map((s) => s.title), ["A", "B", "C"]);

  const nid = await store.importProject(data, { mode: "copy" });
  assert.notEqual(nid, p.id);
  const np = await store.getProject(nid);
  assert.equal(np.title, "Book (imported)");
  assert.equal(np.bibleId, "b-" + nid);
  assert.equal(np.threadId, "t-" + nid);
  const o = await store.getOutline(nid);
  assert.deepEqual(titles(o), ["One:A0,B1", "Two:C0"]);
  const oldIds = new Set([...data.chapters, ...data.scenes].map((r) => r.id));
  for(const c of o.chapters){
    assert.ok(!oldIds.has(c.id));
    for(const s of c.scenes){ assert.ok(!oldIds.has(s.id)); assert.equal(s.projectId, nid); assert.equal(s.chapterId, c.id); }
  }
  assert.equal(np.lastSceneId, o.chapters[0].scenes[0].id);
  const nt = await store.getThread(np);
  assert.equal(nt.messages[0].id, "msg1");
  assert.equal(nt.projectId, nid);
  const nb = await store.getBible(np);
  assert.equal(nb.cards[0].id, "card1");
  assert.equal(nb.projectId, nid);
  // Original untouched.
  assert.deepEqual(titles(await store.getOutline(p.id)), ["One:A0,B1", "Two:C0"]);
  assert.equal((await h.getAll("scenes")).length, 6);

  const quiet = await store.importProject(data, { mode: "copy", suffix: false });
  assert.equal((await store.getProject(quiet)).title, "Book");
  const minimal = await store.importProject({ project: { title: "" } });
  assert.equal((await store.getProject(minimal)).title, "Imported project (imported)");
  assert.deepEqual((await store.getOutline(minimal)).chapters, []);
});

test("importProject replace keeps ids and removes stale records", async () => {
  const { h, store } = setup();
  const { p, c1, a, b } = await book(store);
  const other = await book(store);
  const data = await store.loadProjectData(p.id);
  data.project.title = "Book v2";
  data.scenes = data.scenes.filter((s) => s.id !== b.id);
  data.scenes.find((s) => s.id === a.id).wordCount = 42;
  data.bible.brief = "New brief";
  await store.addScene(c1.id, "Extra");
  const id = await store.importProject(data, { mode: "replace" });
  assert.equal(id, p.id);
  const np = await store.getProject(p.id);
  assert.equal(np.title, "Book v2");
  assert.equal(np.bibleId, p.bibleId);
  assert.deepEqual(titles(await store.getOutline(p.id)), ["One:A0", "Two:C0"]);
  assert.equal((await store.getScene(a.id)).wordCount, 42);
  assert.equal(await h.get("scenes", b.id), undefined);
  assert.equal((await store.getBible(np)).brief, "New brief");
  assert.equal((await store.listProjects()).length, 2);
  assert.deepEqual(titles(await store.getOutline(other.p.id)), ["One:A0,B1", "Two:C0"]);
  // Replace with an id that does not exist yet imports keeping ids.
  data.project.id = "fresh";
  data.chapters = []; data.scenes = [];
  data.project.bibleId = "b-fresh"; data.project.threadId = "t-fresh";
  assert.equal(await store.importProject(data, { mode: "replace" }), "fresh");
  assert.equal((await store.getProject("fresh")).title, "Book v2");
});

// ---- versions ----

const blk = (...texts) => texts.map((t, i) => ({ id: "b" + i, text: t }));
const texts = (blocks) => blocks.map((b) => b.text);

test("saveSceneWithVersion snapshots the previous blocks with the reason", async () => {
  const { h, store } = setup();
  const { p, a } = await book(store);
  await store.saveScene({ id: a.id, blocks: blk("One two.", "Three."), wordCount: 3 });
  const before = (await store.getProject(p.id)).updatedAt;
  const res = await store.saveSceneWithVersion({ id: a.id, projectId: "x", order: 9,
    blocks: blk("New text here.") }, { reason: "rewrite" });
  assert.deepEqual(texts(res.scene.blocks), ["New text here."]);
  assert.equal(res.scene.wordCount, 3); // computed when missing
  assert.equal(res.scene.projectId, p.id);
  assert.equal(res.scene.order, 0);
  assert.ok(res.scene.updatedAt > before);
  const v = res.version;
  assert.equal(v.sceneId, a.id);
  assert.equal(v.projectId, p.id);
  assert.equal(v.reason, "rewrite");
  assert.equal(v.wordCount, 3);
  assert.deepEqual(v.blocks, blk("One two.", "Three."));
  assert.equal(v.createdAt, res.scene.updatedAt);
  assert.deepEqual(await h.get("versions", v.id), v);
  assert.deepEqual(await store.getVersion(v.id), v);
  assert.equal((await store.getProject(p.id)).updatedAt, res.scene.updatedAt);
  const got = await store.getScene(a.id);
  assert.deepEqual(texts(got.blocks), ["New text here."]);
  const kept = await store.saveSceneWithVersion({ id: a.id, blocks: blk("x"), wordCount: 7 }, { reason: "edit" });
  assert.equal(kept.scene.wordCount, 7);
  assert.equal(await store.saveSceneWithVersion({ id: "gone", blocks: [] }, { reason: "edit" }), null);
  assert.equal(await store.getVersion("nope"), undefined);
});

test("saveSceneWithVersion skips duplicate and empty snapshots", async () => {
  const { store } = setup();
  const { a } = await book(store);
  // Empty scene with no versions: nothing to snapshot.
  const r0 = await store.saveSceneWithVersion({ id: a.id, blocks: blk("Hello.") }, { reason: "continue" });
  assert.equal(r0.version, null);
  assert.equal((await store.listVersions(a.id)).length, 0);
  const r1 = await store.saveSceneWithVersion({ id: a.id, blocks: blk("Bye.") }, { reason: "rewrite" });
  assert.ok(r1.version);
  // Newest version is "Hello."; current is "Bye." -> snapshot.
  const m = await store.addVersion(a.id, "manual");
  assert.deepEqual(texts(m.blocks), ["Bye."]);
  // Current text equals the newest version -> skipped.
  const r2 = await store.saveSceneWithVersion({ id: a.id, blocks: blk("Third.") }, { reason: "tone" });
  assert.equal(r2.version, null);
  assert.deepEqual(texts((await store.getScene(a.id)).blocks), ["Third."]);
  assert.deepEqual(texts((await store.addVersion(a.id, "manual")).blocks), ["Third."]);
  assert.equal(await store.addVersion(a.id, "manual"), null);
  assert.equal((await store.listVersions(a.id)).length, 3);
});

test("addVersion snapshots the stored scene; duplicates and unknown scenes give null", async () => {
  const { store } = setup();
  const { p, a } = await book(store);
  await store.saveScene({ id: a.id, blocks: blk("Alpha beta."), wordCount: 2 });
  const v = await store.addVersion(a.id, "manual");
  assert.equal(v.reason, "manual");
  assert.equal(v.sceneId, a.id);
  assert.equal(v.projectId, p.id);
  assert.equal(v.wordCount, 2);
  assert.deepEqual(v.blocks, blk("Alpha beta."));
  assert.equal(await store.addVersion(a.id, "manual"), null);
  assert.equal(await store.addVersion("nope", "manual"), null);
  assert.deepEqual((await store.listVersions(a.id)).map((x) => x.id), [v.id]);
});

test("listVersions sorts newest first, ties by id", async () => {
  const { h, store } = setup();
  const { a, b } = await book(store);
  await h.batch([
    { type: "put", store: "versions", value: { id: "v1", sceneId: a.id, blocks: [], createdAt: 5 } },
    { type: "put", store: "versions", value: { id: "v3", sceneId: a.id, blocks: [], createdAt: 9 } },
    { type: "put", store: "versions", value: { id: "v2", sceneId: a.id, blocks: [], createdAt: 7 } },
    { type: "put", store: "versions", value: { id: "va", sceneId: a.id, blocks: [], createdAt: 7 } },
    { type: "put", store: "versions", value: { id: "vb", sceneId: b.id, blocks: [], createdAt: 8 } }
  ]);
  const list = await store.listVersions(a.id);
  assert.deepEqual(list.map((v) => v.id), ["v3", "va", "v2", "v1"]);
  assert.deepEqual(list[0].blocks, []);
  assert.equal(list[0].wordCount, 0);
  assert.equal(list[0].reason, "");
  assert.deepEqual(await store.listVersions("none"), []);
});

test("versions are pruned to MAX_VERSIONS_PER_SCENE, oldest first", async () => {
  const { store } = setup();
  const { a, b } = await book(store);
  assert.equal(MAX_VERSIONS_PER_SCENE, 30);
  await store.saveScene({ id: a.id, blocks: blk("t0"), wordCount: 1 });
  await store.saveScene({ id: b.id, blocks: blk("other"), wordCount: 1 });
  await store.addVersion(b.id, "manual");
  for(let i = 1; i <= 35; i++){
    const r = await store.saveSceneWithVersion({ id: a.id, blocks: blk("t" + i), wordCount: 1 }, { reason: "edit" });
    assert.deepEqual(texts(r.version.blocks), ["t" + (i - 1)]);
  }
  const list = await store.listVersions(a.id);
  assert.equal(list.length, 30);
  assert.deepEqual(texts(list[0].blocks), ["t34"]);
  assert.deepEqual(texts(list[29].blocks), ["t5"]);
  assert.equal((await store.listVersions(b.id)).length, 1);
  const m = await store.addVersion(a.id, "manual");
  assert.deepEqual(texts(m.blocks), ["t35"]);
  const after = await store.listVersions(a.id);
  assert.equal(after.length, 30);
  assert.deepEqual(texts(after[29].blocks), ["t6"]);
});

test("restoreVersion snapshots the current text and puts the version back", async () => {
  const { store } = setup();
  const { a } = await book(store);
  await store.saveScene({ id: a.id, blocks: blk("Original words here."), wordCount: 3 });
  const r1 = await store.saveSceneWithVersion({ id: a.id, blocks: blk("Rewritten."), wordCount: 1 }, { reason: "rewrite" });
  const res = await store.restoreVersion(r1.version.id);
  assert.equal(res.version.reason, "restore");
  assert.deepEqual(texts(res.version.blocks), ["Rewritten."]);
  assert.equal(res.version.wordCount, 1);
  const sc = await store.getScene(a.id);
  assert.deepEqual(sc.blocks, blk("Original words here."));
  assert.equal(sc.wordCount, 3);
  assert.deepEqual((await store.listVersions(a.id)).map((v) => v.reason), ["restore", "rewrite"]);
  assert.equal(await store.restoreVersion("nope"), null);
});

test("saveSceneWithVersion writes everything in one batch", async () => {
  const h = memoryHandle();
  let batches = 0, lastOps = null, n = 0, t = 1000;
  const spy = new Proxy(h, { get(target, key){
    if(key === "batch") return (ops) => { batches++; lastOps = ops; return target.batch(ops); };
    if(key === "put" || key === "del") return () => { throw new Error("unexpected " + key); };
    return target[key];
  } });
  const store = createStore(h, { uid: () => "id" + (++n), now: () => ++t });
  const spied = createStore(spy, { uid: () => "s" + (++n), now: () => ++t });
  const { a } = await book(store);
  for(let i = 0; i < MAX_VERSIONS_PER_SCENE; i++){
    await store.saveScene({ id: a.id, blocks: blk("v" + i), wordCount: 1 });
    await store.addVersion(a.id, "manual");
  }
  await store.saveScene({ id: a.id, blocks: blk("now"), wordCount: 1 });
  const res = await spied.saveSceneWithVersion({ id: a.id, blocks: blk("next"), wordCount: 1 }, { reason: "expand" });
  assert.equal(batches, 1);
  assert.deepEqual(lastOps.map((o) => o.type + ":" + o.store), ["put:versions", "put:scenes", "patch:projects", "del:versions"]);
  assert.equal(lastOps[0].value.id, res.version.id);
  const list = await store.listVersions(a.id);
  assert.equal(list.length, 30);
  assert.deepEqual(texts(list[0].blocks), ["now"]);
  assert.ok(!list.some((v) => v.blocks[0].text === "v0"));
});

test("saveScene writes no version; scene deletes cascade to versions", async () => {
  const { h, store } = setup();
  const { p, c1, c2, a, b, c } = await book(store);
  await store.saveScene({ id: a.id, blocks: blk("x"), wordCount: 1 });
  await store.saveScene({ id: a.id, blocks: blk("y"), wordCount: 1 });
  assert.equal((await h.getAll("versions")).length, 0);
  for(const s of [a, b, c]){
    await store.saveScene({ id: s.id, blocks: blk("one " + s.id), wordCount: 2 });
    await store.saveSceneWithVersion({ id: s.id, blocks: blk("two " + s.id), wordCount: 2 }, { reason: "edit" });
  }
  assert.equal((await h.getAll("versions")).length, 3);
  await store.deleteScene(a.id);
  assert.equal((await store.listVersions(a.id)).length, 0);
  assert.equal((await h.getAll("versions")).length, 2);
  await store.deleteChapter(c1.id);
  assert.equal((await store.listVersions(b.id)).length, 0);
  assert.equal((await store.listVersions(c.id)).length, 1);
  const data = await store.loadProjectData(p.id);
  assert.equal("versions" in data, false);
  await store.importProject(data, { mode: "replace" });
  assert.equal((await h.getAll("versions")).length, 0);
  await store.saveSceneWithVersion({ id: c.id, blocks: blk("three"), wordCount: 1 }, { reason: "edit" });
  assert.equal((await h.getAll("versions")).length, 1);
  await store.deleteProject(p.id);
  assert.equal((await h.getAll("versions")).length, 0);
  void c2;
});

// ---- scene summaries and scene threads ----

test("memory handle patch: applies fn in place, null for missing, isolated clones", async () => {
  const h = memoryHandle();
  await h.put("scenes", { id: "s1", n: 1, deep: { x: 1 } });
  const seen = [];
  const out = await h.patch("scenes", "s1", (rec) => { seen.push(rec); rec.n = 2; return rec; });
  assert.deepEqual(out, { id: "s1", n: 2, deep: { x: 1 } });
  assert.deepEqual(await h.get("scenes", "s1"), out);
  out.deep.x = 99;
  seen[0].deep.x = 77;
  assert.equal((await h.get("scenes", "s1")).deep.x, 1);
  let called = false;
  assert.equal(await h.patch("scenes", "nope", () => { called = true; return {}; }), null);
  assert.equal(called, false);
  assert.equal(await h.get("scenes", "nope"), undefined);
  await assert.rejects(h.patch("scenes", "s1", () => { throw new Error("boom"); }));
  assert.equal((await h.get("scenes", "s1")).n, 2);
});

test("normalizeThread sceneId rules", () => {
  assert.equal(emptyThread("x", "p").sceneId, null);
  assert.deepEqual([normalizeThread({}).scope, normalizeThread({}).sceneId], ["project", null]);
  const a = normalizeThread({ scope: "scene", sceneId: "s1" });
  assert.deepEqual([a.scope, a.sceneId], ["scene", "s1"]);
  const b = normalizeThread({ scope: "scene", sceneId: "" });
  assert.deepEqual([b.scope, b.sceneId], ["project", null]);
  const c = normalizeThread({ scope: "scene", sceneId: 5 });
  assert.deepEqual([c.scope, c.sceneId], ["project", null]);
  assert.equal(normalizeThread({ messages: [] }).scope, "project");
  assert.equal(sceneThreadId("abc"), "ts-abc");
});

test("getSceneThread: empty default and stored record with forced fields", async () => {
  const { h, store } = setup();
  const { p, a } = await book(store);
  const empty = await store.getSceneThread(a);
  assert.equal(empty.id, "ts-" + a.id);
  assert.equal(empty.scope, "scene");
  assert.equal(empty.sceneId, a.id);
  assert.equal(empty.projectId, p.id);
  assert.deepEqual(empty.messages, []);
  assert.equal(await h.get("threads", "ts-" + a.id), undefined);
  await h.put("threads", { id: "ts-" + a.id, projectId: "other", scope: "project", sceneId: "zzz",
    messages: [{ id: "m1", role: "user", content: "hi" }], includeScene: false });
  const t = await store.getSceneThread(a);
  assert.deepEqual([t.id, t.scope, t.sceneId, t.projectId], ["ts-" + a.id, "scene", a.id, p.id]);
  assert.equal(t.messages[0].id, "m1");
  assert.equal(t.includeScene, false);
});

test("addScene and getScene carry summary fields", async () => {
  const { h, store } = setup();
  const { a } = await book(store);
  assert.equal(a.summaryUpdatedAt, 0);
  assert.equal(a.summaryModel, "");
  await h.put("scenes", { ...(await h.get("scenes", a.id)), summaryUpdatedAt: -3, summaryModel: null });
  const got = await store.getScene(a.id);
  assert.equal(got.summaryUpdatedAt, 0);
  assert.equal(got.summaryModel, "");
});

test("patchScene writes only summary fields and leaves the project alone", async () => {
  const { store } = setup();
  const { p, a } = await book(store);
  await store.saveScene({ id: a.id, blocks: [{ id: "x", text: "Text" }], wordCount: 1 });
  const before = await store.getScene(a.id);
  const projectAt = (await store.getProject(p.id)).updatedAt;
  const out = await store.patchScene(a.id, { summary: "Sum", summaryHash: "h", summaryUpdatedAt: 50,
    summaryModel: "user", blocks: [], title: "Hacked", wordCount: 99, chapterId: "c?" });
  assert.equal(out.summary, "Sum");
  assert.equal(out.summaryHash, "h");
  assert.equal(out.summaryUpdatedAt, 50);
  assert.equal(out.summaryModel, "user");
  assert.deepEqual(out.blocks, before.blocks);
  assert.equal(out.title, "A");
  assert.equal(out.wordCount, 1);
  assert.equal(out.chapterId, before.chapterId);
  assert.ok(out.updatedAt > before.updatedAt);
  assert.deepEqual(await store.getScene(a.id), out);
  assert.equal((await store.getProject(p.id)).updatedAt, projectAt);
  const partial = await store.patchScene(a.id, { summaryModel: "m" });
  assert.equal(partial.summary, "Sum");
  assert.equal(partial.summaryModel, "m");
  assert.equal(await store.patchScene("gone", { summary: "x" }), null);
});

test("saveScene and saveSceneWithVersion keep summary fields the caller omits", async () => {
  const { store } = setup();
  const { a } = await book(store);
  const fields = { summary: "Sum", summaryHash: "h1", summaryUpdatedAt: 77, summaryModel: "util" };
  await store.patchScene(a.id, fields);
  const s1 = await store.saveScene({ id: a.id, title: "A2", blocks: [{ id: "x", text: "One" }], wordCount: 1 });
  const pick = (s) => ({ summary: s.summary, summaryHash: s.summaryHash, summaryUpdatedAt: s.summaryUpdatedAt, summaryModel: s.summaryModel });
  assert.deepEqual(pick(s1), fields);
  assert.deepEqual(pick(await store.getScene(a.id)), fields);
  const res = await store.saveSceneWithVersion({ id: a.id, blocks: [{ id: "x", text: "Two" }] }, { reason: "rewrite" });
  assert.deepEqual(pick(res.scene), fields);
  assert.deepEqual(pick(await store.getScene(a.id)), fields);
});

test("listSceneSummaries: outline order, stale flag, no blocks, orphans last", async () => {
  const { h, store } = setup();
  const { p, c1, c2, a, b, c } = await book(store);
  const blocks = [{ id: "x", text: "Hello there" }];
  await store.saveScene({ id: a.id, blocks, wordCount: 2 });
  await store.saveScene({ id: b.id, blocks, wordCount: 2 });
  await store.patchScene(a.id, { summary: "fresh", summaryHash: hashText(blocksToText(blocks)), summaryModel: "m" });
  await store.patchScene(b.id, { summary: "old", summaryHash: "deadbeef" });
  await store.moveChapter(c2.id, -1);
  await h.put("scenes", { id: "orph", projectId: p.id, chapterId: "missing", order: 0, title: "Lost", blocks: [] });
  const list = await store.listSceneSummaries(p.id);
  assert.deepEqual(list.map((s) => s.id), [c.id, a.id, b.id, "orph"]);
  assert.deepEqual(list.map((s) => s.chapterTitle), ["Two", "One", "One", ""]);
  assert.deepEqual(list.map((s) => s.stale), [false, false, true, false]);
  assert.ok(list.every((s) => !("blocks" in s)));
  assert.deepEqual(Object.keys(list[1]).sort(), ["chapterId", "chapterTitle", "id", "order", "stale", "summary",
    "summaryHash", "summaryModel", "summaryUpdatedAt", "textHash", "title", "wordCount"]);
  assert.equal(list[1].textHash, hashText(blocksToText(blocks)));
  assert.equal(list[1].chapterId, c1.id);
  assert.equal(list[1].summary, "fresh");
  assert.equal(list[1].wordCount, 2);
  assert.deepEqual(await store.listSceneSummaries("nope"), []);
});

test("getChapter", async () => {
  const { store } = setup();
  const { c1 } = await book(store);
  assert.equal((await store.getChapter(c1.id)).title, "One");
  assert.equal(await store.getChapter("nope"), undefined);
});

test("scene and project deletes remove scene threads", async () => {
  const { h, store } = setup();
  const { p, a, b, c2, c } = await book(store);
  const keep = await book(store);
  for(const s of [a, b, c, keep.a]){
    await store.saveThread(s.projectId, { ...(await store.getSceneThread(s)), messages: [{ id: "m", role: "user", content: "x" }] });
  }
  await h.put("threads", { id: "stray", projectId: p.id, messages: [] });
  assert.equal(await store.deleteScene(a.id), true);
  assert.equal(await h.get("threads", "ts-" + a.id), undefined);
  assert.ok(await h.get("threads", "ts-" + b.id));
  await store.deleteChapter(c2.id);
  assert.equal(await h.get("threads", "ts-" + c.id), undefined);
  assert.equal(await store.deleteProject(p.id), true);
  assert.equal((await h.getAllBy("threads", "projectId", p.id)).length, 0);
  assert.equal(await h.get("threads", p.threadId), undefined);
  assert.ok(await h.get("threads", "ts-" + keep.a.id));
  assert.ok(await h.get("threads", keep.p.threadId));
});

test("loadProjectData.sceneThreads: outline order, no orphans", async () => {
  const { h, store } = setup();
  const { p, a, b, c, c2 } = await book(store);
  for(const s of [c, b, a]) await store.saveThread(p.id, await store.getSceneThread(s));
  await h.put("threads", { id: "ts-ghost", projectId: p.id, scope: "scene", sceneId: "ghost", messages: [] });
  await store.moveChapter(c2.id, -1);
  const data = await store.loadProjectData(p.id);
  assert.deepEqual(data.sceneThreads.map((t) => t.sceneId), [c.id, a.id, b.id]);
  assert.ok(data.sceneThreads.every((t) => t.scope === "scene" && t.id === "ts-" + t.sceneId));
  assert.equal(data.thread.id, p.threadId);
});

test("importProject: scene threads remapped in copy, kept in replace, optional", async () => {
  const { h, store } = setup();
  const { p, a, b } = await book(store);
  await store.saveThread(p.id, { ...(await store.getSceneThread(a)), messages: [{ id: "ma", role: "user", content: "A" }] });
  await store.saveThread(p.id, { ...(await store.getSceneThread(b)), messages: [{ id: "mb", role: "user", content: "B" }] });
  const data = await store.loadProjectData(p.id);
  data.sceneThreads.push({ id: "ts-zzz", sceneId: "zzz", scope: "scene", messages: [] });

  const nid = await store.importProject(data, { mode: "copy" });
  const o = await store.getOutline(nid);
  const [na, nb] = o.chapters[0].scenes;
  const ta = await h.get("threads", "ts-" + na.id);
  assert.deepEqual([ta.projectId, ta.scope, ta.sceneId, ta.messages[0].id], [nid, "scene", na.id, "ma"]);
  assert.equal((await h.get("threads", "ts-" + nb.id)).messages[0].id, "mb");
  const nThreads = await h.getAllBy("threads", "projectId", nid);
  assert.equal(nThreads.length, 3); // project thread + two scene threads, unmapped one dropped
  assert.ok(await h.get("threads", "ts-" + a.id)); // original untouched

  data.sceneThreads = data.sceneThreads.filter((t) => t.sceneId === a.id);
  data.sceneThreads[0].messages.push({ id: "ma2", role: "user", content: "A2" });
  assert.equal(await store.importProject(data, { mode: "replace" }), p.id);
  const ra = await h.get("threads", "ts-" + a.id);
  assert.deepEqual(ra.messages.map((m) => m.id), ["ma", "ma2"]);
  assert.equal(ra.projectId, p.id);
  assert.equal(await h.get("threads", "ts-" + b.id), undefined);

  delete data.sceneThreads;
  const plain = await store.importProject(data, { mode: "copy" });
  assert.equal((await store.getOutline(plain)).chapters.length, 2);
  assert.equal((await h.getAllBy("threads", "projectId", plain)).length, 1);
});

/* ----- Text hashes and project stats (long manuscripts) ----- */

const hashOf = (blocks) => hashText(blocksToText(blocks));

test("memory handle: count and patch ops in a batch, all or nothing", async () => {
  const h = memoryHandle();
  await h.batch([
    { type: "put", store: "scenes", value: { id: "s1", projectId: "p", n: 1 } },
    { type: "put", store: "scenes", value: { id: "s2", projectId: "p", n: 2 } },
    { type: "put", store: "scenes", value: { id: "s3", projectId: "q", n: 3 } }
  ]);
  assert.equal(await h.count("scenes", "projectId", "p"), 2);
  assert.equal(await h.count("scenes", "projectId", "none"), 0);
  await h.batch([
    { type: "patch", store: "scenes", id: "s1", fn: (r) => ({ ...r, n: r.n + 10 }) },
    { type: "patch", store: "scenes", id: "s1", fn: (r) => ({ ...r, n: r.n * 2 }) },
    { type: "patch", store: "scenes", id: "missing", fn: () => { throw new Error("not called"); } },
    { type: "patch", store: "scenes", id: "s2", fn: () => null }
  ]);
  assert.equal((await h.get("scenes", "s1")).n, 22);
  assert.equal((await h.get("scenes", "s2")).n, 2);
  assert.equal(await h.get("scenes", "missing"), undefined);
  await assert.rejects(h.batch([
    { type: "del", store: "scenes", id: "s3" },
    { type: "patch", store: "scenes", id: "s1", fn: () => { throw new Error("boom"); } }
  ]), /boom/);
  assert.ok(await h.get("scenes", "s3"), "a failed batch leaves nothing behind");
  assert.equal((await h.get("scenes", "s1")).n, 22);
});

test("textHash is written whenever blocks are saved and left alone by patchScene", async () => {
  const { h, store } = setup();
  const { p, a, b } = await book(store);
  assert.equal(a.textHash, hashText(""));
  const b1 = blk("One two.\n\nThree.");
  const s1 = await store.saveScene({ id: a.id, blocks: b1, wordCount: 3, textHash: "bogus" });
  assert.equal(s1.textHash, hashOf(b1));
  assert.equal((await h.get("scenes", a.id)).textHash, hashOf(b1));
  const title = await store.saveScene({ id: a.id, title: "Renamed" });
  assert.equal(title.textHash, hashOf(b1));
  await store.patchScene(a.id, { summary: "S", summaryHash: hashOf(b1), textHash: "ignored" });
  assert.equal((await h.get("scenes", a.id)).textHash, hashOf(b1));
  const b2 = blk("Four five six.");
  const r = await store.saveSceneWithVersion({ id: a.id, blocks: b2 }, { reason: "rewrite" });
  assert.equal(r.scene.textHash, hashOf(b2));
  assert.equal((await h.get("scenes", a.id)).textHash, hashOf(b2));
  await store.restoreVersion(r.version.id);
  assert.equal((await h.get("scenes", a.id)).textHash, hashOf(b1));
  // Import recomputes it from the imported blocks (a bundle's textHash is not trusted).
  const data = await store.loadProjectData(p.id);
  data.scenes.forEach((s) => { s.textHash = "deadbeef"; });
  const nid = await store.importProject(data, { mode: "copy" });
  const imported = await h.getAllBy("scenes", "projectId", nid);
  assert.equal(imported.length, 3);
  imported.forEach((s) => assert.equal(s.textHash, hashOf(s.blocks)));
  // Older records without the field read back as "".
  await h.put("scenes", { id: "old", projectId: p.id, chapterId: b.chapterId, order: 9, title: "Old", blocks: blk("x") });
  assert.equal((await store.getScene("old")).textHash, "");
  assert.equal(sceneTextHash(await store.getScene("old")), hashOf(blk("x")));
  assert.equal(sceneTextHash({ textHash: "abc", blocks: blk("x") }), "abc");
});

test("listSceneSummaries and getOutline use textHash, falling back to hashing old records", async () => {
  const { h, store } = setup();
  const { p, a, b, c } = await book(store);
  const text = blk("Hello there");
  await store.saveScene({ id: a.id, blocks: text, wordCount: 2 });
  await store.patchScene(a.id, { summary: "fresh", summaryHash: hashOf(text) });
  // b: stored textHash says the summary is current although the blocks differ, so no hashing happened.
  const rb = await h.get("scenes", b.id);
  await h.put("scenes", { ...rb, blocks: blk("Changed behind the store's back"), textHash: "cafe0001", summary: "s", summaryHash: "cafe0001" });
  // c: an old record without textHash, summary written for other text.
  const rc = await h.get("scenes", c.id);
  delete rc.textHash;
  await h.put("scenes", { ...rc, blocks: blk("Now"), summary: "old", summaryHash: hashOf(blk("Then")) });
  const list = await store.listSceneSummaries(p.id);
  const byId = Object.fromEntries(list.map((s) => [s.id, s]));
  assert.deepEqual([byId[a.id].stale, byId[b.id].stale, byId[c.id].stale], [false, false, true]);
  assert.equal(byId[c.id].textHash, hashOf(blk("Now")));
  const o = await store.getOutline(p.id);
  const sc = Object.fromEntries(o.chapters.flatMap((ch) => ch.scenes).map((s) => [s.id, s]));
  assert.deepEqual([sc[a.id].stale, sc[b.id].stale, sc[c.id].stale], [false, false, true]);
  assert.deepEqual([sc[a.id].textHash, sc[b.id].textHash, sc[c.id].textHash], [hashOf(text), "cafe0001", hashOf(blk("Now"))]);
  assert.ok(Array.isArray(sc[a.id].blocks), "the outline still carries blocks");
  // A whitespace-only summary is not stale in the outline; the derived flag is never stored.
  await store.patchScene(a.id, { summary: "  ", summaryHash: "x" });
  const o2 = await store.getOutline(p.id);
  assert.equal(o2.chapters[0].scenes[0].stale, false);
  await store.saveScene({ ...o2.chapters[0].scenes[0], title: "Kept" });
  assert.ok(!("stale" in (await h.get("scenes", a.id))));
});

async function actualStats(h, pid){
  const ch = await h.getAllBy("chapters", "projectId", pid);
  const sc = await h.getAllBy("scenes", "projectId", pid);
  return { chapters: ch.length, scenes: sc.length, words: sc.reduce((n, s) => n + s.wordCount, 0) };
}

test("project stats are kept on the project record through every change", async () => {
  const { h, store } = setup();
  const p0 = await store.createProject("Empty");
  assert.deepEqual((await h.get("projects", p0.id)).stats, { chapters: 0, scenes: 0, words: 0 });
  const { p, c1, c2, a, b, c } = await book(store);
  const stored = async () => (await h.get("projects", p.id)).stats;
  const check = async (label) => assert.deepEqual(await stored(), await actualStats(h, p.id), label);
  assert.deepEqual(await stored(), { chapters: 2, scenes: 3, words: 0 });
  await store.saveScene({ id: a.id, blocks: blk("one two three"), wordCount: 3 }); await check("save");
  await store.saveScene({ id: b.id, blocks: blk("four five"), wordCount: 2 }); await check("save b");
  await store.saveScene({ id: a.id, blocks: blk("one"), wordCount: 1 }); await check("shrink");
  await store.saveScene({ id: a.id, title: "Only a title" }); await check("title only");
  await store.saveSceneWithVersion({ id: c.id, blocks: blk("six seven eight nine") }, { reason: "r" }); await check("with version");
  const r = await store.saveSceneWithVersion({ id: c.id, blocks: blk("ten"), wordCount: 1 }, { reason: "r" }); await check("with version 2");
  await store.restoreVersion(r.version.id); await check("restore");
  await store.patchScene(c.id, { summary: "S" }); await check("patch");
  await store.moveScene(b.id, 1); await check("move across chapters");
  await store.moveScene(b.id, -1); await check("move back");
  await store.moveChapter(c2.id, -1); await check("move chapter");
  const d = await store.addScene(c2.id, "D"); await check("add scene");
  await store.saveScene({ id: d.id, blocks: blk("a b c d e"), wordCount: 5 }); await check("save d");
  await store.deleteScene(a.id); await check("delete scene");
  const c3 = await store.addChapter(p.id, "Three"); await check("add chapter");
  await store.addScene(c3.id, "E"); await check("add e");
  await store.deleteChapter(c2.id); await check("delete chapter with scenes");
  await store.renameProject(p.id, "Renamed"); await check("rename");
  await store.setLastScene(p.id, b.id); await check("last scene");
  assert.deepEqual(await stored(), { chapters: 2, scenes: 2, words: 2 });
  const list = await store.listProjects();
  assert.deepEqual(list.find((x) => x.id === p.id).stats, await actualStats(h, p.id));
  // Import writes stats for the copy.
  const nid = await store.importProject(await store.loadProjectData(p.id), { mode: "copy" });
  assert.deepEqual((await h.get("projects", nid)).stats, await actualStats(h, nid));
  const rid = await store.importProject(await store.loadProjectData(nid), { mode: "replace" });
  assert.equal(rid, nid);
  assert.deepEqual((await h.get("projects", nid)).stats, await actualStats(h, nid));
});

test("concurrent saves of different scenes do not lose each other's word deltas", async () => {
  const { h, store } = setup();
  const { p, a, b, c } = await book(store);
  await Promise.all([
    store.saveScene({ id: a.id, blocks: blk("one two"), wordCount: 2 }),
    store.saveSceneWithVersion({ id: b.id, blocks: blk("three four five") }, { reason: "r" }),
    store.saveScene({ id: c.id, blocks: blk("six"), wordCount: 1 }),
    store.setLastScene(p.id, c.id),
    store.renameProject(p.id, "Busy")
  ]);
  const rec = await h.get("projects", p.id);
  assert.deepEqual(rec.stats, { chapters: 2, scenes: 3, words: 6 });
  assert.equal(rec.title, "Busy");
  assert.equal(rec.lastSceneId, c.id);
});

test("listProjects reads stored stats without loading scenes when they are consistent", async () => {
  const h = memoryHandle();
  let n = 0, t = 1000;
  const reads = [];
  const spy = new Proxy(h, { get(target, key){
    if(key === "getAll" || key === "getAllBy") return (st, ...rest) => { reads.push(key + ":" + st); return target[key](st, ...rest); };
    return target[key];
  } });
  const store = createStore(spy, { uid: () => "id" + (++n), now: () => ++t });
  const { a } = await book(store);
  await store.saveScene({ id: a.id, blocks: blk("one two three"), wordCount: 3 });
  reads.length = 0;
  const list = await store.listProjects();
  assert.deepEqual(list[0].stats, { chapters: 2, scenes: 3, words: 3 });
  assert.deepEqual(reads, ["getAll:projects"]);
});

test("listProjects recomputes missing or inconsistent stats and saves them", async () => {
  const { h, store } = setup();
  const { p, c1, a } = await book(store);
  await store.saveScene({ id: a.id, blocks: blk("one two three"), wordCount: 3 });
  const rec = await h.get("projects", p.id);
  const updatedAt = rec.updatedAt;
  // Missing (a record from before stats existed).
  delete rec.stats;
  await h.put("projects", rec);
  assert.deepEqual((await store.listProjects())[0].stats, { chapters: 2, scenes: 3, words: 3 });
  let saved = await h.get("projects", p.id);
  assert.deepEqual(saved.stats, { chapters: 2, scenes: 3, words: 3 });
  assert.equal(saved.updatedAt, updatedAt, "recomputing does not touch updatedAt");
  // Invalid values.
  await h.put("projects", { ...saved, stats: { chapters: -1, scenes: "3", words: 3.5 } });
  assert.equal(validStats((await h.get("projects", p.id)).stats), false);
  assert.deepEqual((await store.listProjects())[0].stats, { chapters: 2, scenes: 3, words: 3 });
  // Counts that do not match the records (a scene written behind the store's back).
  await h.put("scenes", { id: "extra", projectId: p.id, chapterId: c1.id, order: 5, title: "X", blocks: blk("a b"), wordCount: 2 });
  assert.deepEqual((await store.listProjects())[0].stats, { chapters: 2, scenes: 4, words: 5 });
  assert.deepEqual((await h.get("projects", p.id)).stats, { chapters: 2, scenes: 4, words: 5 });
  // Stats that are invalid stay invalid under deltas until recomputed.
  await h.put("projects", { ...(await h.get("projects", p.id)), stats: null });
  await store.saveScene({ id: a.id, blocks: blk("one"), wordCount: 1 });
  assert.equal((await h.get("projects", p.id)).stats, null);
  assert.deepEqual((await store.listProjects())[0].stats, { chapters: 2, scenes: 4, words: 3 });
});

test("getOutline heals word totals that drifted", async () => {
  const { h, store } = setup();
  const { p, a } = await book(store);
  await store.saveScene({ id: a.id, blocks: blk("one two three"), wordCount: 3 });
  await h.put("projects", { ...(await h.get("projects", p.id)), stats: { chapters: 2, scenes: 3, words: 999 } });
  assert.equal((await store.listProjects())[0].stats.words, 999, "counts match, so the stored total is trusted");
  const o = await store.getOutline(p.id);
  assert.equal(o.project.stats.words, 3);
  assert.deepEqual((await h.get("projects", p.id)).stats, { chapters: 2, scenes: 3, words: 3 });
  assert.equal((await store.listProjects())[0].stats.words, 3);
});
