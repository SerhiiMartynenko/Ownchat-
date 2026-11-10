import test from "node:test";
import assert from "node:assert/strict";
import { buildBundle, parseBundle, buildManuscript, slugify, parseFrontMatter, formatFrontMatter } from "./bundle.js";
import { normalizeBible } from "./bible.js";
import { countWords, blocksToText } from "./scene.js";

const NOW = () => Date.UTC(2026, 10, 9, 12, 0, 0);
function counter(prefix = "u"){ let i = 0; return () => prefix + (++i); }

function scene(id, chapterId, order, title, paras, extra){
  const blocks = paras.map((t, i) => ({ id: id + "-b" + i, text: t }));
  return Object.assign({ id, projectId: "p1", chapterId, order, title, blocks, summary: "", summaryHash: "",
    wordCount: countWords(blocksToText(blocks)), createdAt: 100, updatedAt: 200 }, extra || {});
}

function fixture(){
  const project = { id: "p1", title: "The Long Road: A \"Novel\"", bibleId: "b-p1", threadId: "t-p1",
    lastSceneId: "s2", createdAt: 1, updatedAt: 2, customField: { keep: true } };
  const chapters = [
    { id: "c1", projectId: "p1", order: 0, title: "Beginnings", createdAt: 1, updatedAt: 1 },
    { id: "c2", projectId: "p1", order: 1, title: "Beginnings", createdAt: 1, updatedAt: 1 },
    { id: "c3", projectId: "p1", order: 2, title: "Пролог: ёлка", createdAt: 1, updatedAt: 1 },
    { id: "c4", projectId: "p1", order: 3, title: "", createdAt: 1, updatedAt: 1 }
  ];
  const scenes = [
    scene("s1", "c1", 0, "Arrival", ["She came at dawn.", "The town slept."], { summary: "Liz arrives.\nNobody notices.", summaryHash: "h1" }),
    scene("s2", "c1", 1, "arrival", ["Second: with \"quotes\" and a: colon."]),
    scene("s3", "c2", 0, "---\nweird: title \"x\"", ["---", "Body with --- inside."]),
    scene("s4", "c3", 0, "Ёлка и снег", ["Привет, мир."]),
    scene("s5", "c3", 1, "!!!", []),
    scene("s6", "c4", 0, "", ["Untitled scene text."])
  ];
  const bible = Object.assign(normalizeBible({
    id: "b-p1", v: 1, brief: "A brief.\n\nTwo lines.", styleGuide: "---\nTerse.", updatedAt: 5,
    cards: [
      { id: "k1", type: "character", name: "Liz", aliases: ["Lizzie"], body: "Tall.\n---\nNot a front matter.", pinned: true, createdAt: 3, updatedAt: 4 },
      { id: "k2", type: "character", name: "LIZ", aliases: [], body: "", status: "proposed", createdAt: 3, updatedAt: 4 },
      { id: "k3", type: "place", name: "Ёлкино", aliases: ["The Village", "Деревня"], body: "\nLeading newline body", createdAt: 3, updatedAt: 4 },
      { id: "k4", type: "note", name: "!!!", body: "Odd name", createdAt: 3, updatedAt: 4 }
    ]
  }), { projectId: "p1" });
  const thread = { id: "t-p1", projectId: "p1", scope: "project", includeScene: true,
    messages: [{ id: "m1", role: "user", content: "Hi" }, { id: "m2", role: "assistant", content: "Hello" }],
    summary: "Earlier stuff", summarizedUpTo: 1, summarizedUpToId: "m1", summaryModel: "x", summaryUpdatedAt: 7,
    lastUsage: { input: 1 }, updatedAt: 9 };
  return { project, chapters, scenes, bible, thread };
}

test("round trip is lossless", () => {
  const data = fixture();
  const { files } = buildBundle(data, { now: NOW });
  const back = parseBundle(files, { uid: counter() });
  assert.deepEqual(back.warnings, []);
  assert.deepEqual(back.project, data.project);
  assert.deepEqual(back.chapters, data.chapters);
  assert.deepEqual(back.scenes, data.scenes);
  assert.deepEqual(back.bible, data.bible);
  assert.deepEqual(back.thread, data.thread);
});

test("build is deterministic", () => {
  const a = buildBundle(fixture(), { now: NOW });
  const b = buildBundle(fixture(), { now: NOW });
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(Object.keys(a.files)), JSON.stringify(Object.keys(b.files)));
  assert.equal(a.manifest.exportedAt, "2026-11-09T12:00:00.000Z");
});

test("layout, manifest and slugs", () => {
  const { files, manifest } = buildBundle(fixture(), { now: NOW });
  assert.equal(manifest.format, "ownchat-project");
  assert.equal(manifest.version, 1);
  assert.equal(manifest.thread, "chat/project-thread.json");
  assert.equal(manifest.bible.brief, "bible/brief.md");
  assert.equal(manifest.bible.styleGuide, "bible/style-guide.md");
  assert.deepEqual(manifest.bible.cards[0], { id: "k1", createdAt: 3, updatedAt: 4, file: "bible/character-liz.md" });
  assert.equal(manifest.bible.cards[1].file, "bible/character-liz-2.md");
  assert.equal(manifest.bible.cards[2].file, "bible/place-елкино.md");
  assert.equal(manifest.bible.cards[3].file, "bible/note-note.md");
  assert.deepEqual(manifest.scenes.map((s) => s.file), [
    "scenes/01-beginnings/01-arrival.md",
    "scenes/01-beginnings/02-arrival-2.md",
    "scenes/02-beginnings-2/01-weird-title-x.md",
    "scenes/03-пролог-елка/01-елка-и-снег.md",
    "scenes/03-пролог-елка/02-scene.md",
    "scenes/04-chapter/01-scene.md"
  ]);
  assert.deepEqual(manifest.scenes[0].blockIds, ["s1-b0", "s1-b1"]);
  assert.equal(manifest.scenes[0].blocks, undefined);
  assert.equal(files["bible/brief.md"], "A brief.\n\nTwo lines.\n");
  assert.equal(files["bible/style-guide.md"], "---\nTerse.\n");
  assert.equal(files["scenes/01-beginnings/01-arrival.md"],
    '---\nid: "s1"\nchapterId: "c1"\norder: 0\ntitle: "Arrival"\nsummary: "Liz arrives.\\nNobody notices."\n---\n\nShe came at dawn.\n\nThe town slept.\n');
  assert.equal(files["bible/character-liz.md"],
    '---\nid: "k1"\ntype: "character"\nname: "Liz"\naliases: ["Lizzie"]\npinned: true\nstatus: "approved"\n---\n\nTall.\n---\nNot a front matter.\n');
  assert.equal(JSON.parse(files["manifest.json"]).project.customField.keep, true);
  assert.ok(files["chat/project-thread.json"].endsWith("\n"));
  assert.equal(Object.keys(files)[0], "manifest.json");
});

test("slugify", () => {
  assert.equal(slugify("Hello, World!"), "hello-world");
  assert.equal(slugify("Café Déjà Vu"), "cafe-deja-vu");
  assert.equal(slugify("Ёлка и снег"), "елка-и-снег");
  assert.equal(slugify("!!!", "scene"), "scene");
  assert.equal(slugify("", "chapter"), "chapter");
  const long = slugify("a".repeat(30) + " " + "b".repeat(30));
  assert.ok(long.length <= 40 && !long.endsWith("-"));
});

test("front matter helpers", () => {
  const text = formatFrontMatter({ a: "x: \"y\"\n---", b: [1, "two"], c: false, d: 3 }, ["a", "b", "c", "d"], "body");
  const fm = parseFrontMatter(text);
  assert.ok(fm.hasFrontMatter);
  assert.deepEqual(fm.meta, { a: "x: \"y\"\n---", b: [1, "two"], c: false, d: 3 });
  assert.equal(fm.body, "body");
  assert.deepEqual(parseFrontMatter("---\ntitle: Plain words: here\n---\n\nX\n").meta, { title: "Plain words: here" });
  assert.deepEqual(parseFrontMatter("no front matter\n"), { meta: {}, body: "no front matter", hasFrontMatter: false });
  assert.equal(parseFrontMatter("---\nunterminated: 1\nbody").hasFrontMatter, false);
  assert.equal(parseFrontMatter("---\r\nid: \"a\"\r\n---\r\n\r\nWin\r\n").body, "Win");
});

test("empty scenes and empty project", () => {
  const data = { project: { id: "p", title: "" }, chapters: [{ id: "c", projectId: "p", order: 0, title: "One" }],
    scenes: [scene("e", "c", 0, "Empty", [])], bible: normalizeBible(null), thread: { id: "t", messages: [] } };
  const { files } = buildBundle(data, { now: NOW });
  assert.equal(files["scenes/01-one/01-empty.md"].endsWith("---\n\n\n"), true);
  const back = parseBundle(files);
  assert.deepEqual(back.scenes[0].blocks, []);
  assert.equal(back.scenes[0].wordCount, 0);
  assert.deepEqual(back.warnings, []);
});

test("manifest one folder deep, __MACOSX and odd paths are handled", () => {
  const data = fixture();
  const { files } = buildBundle(data, { now: NOW });
  const nested = {};
  Object.keys(files).forEach((p) => {
    nested["My Book/" + p] = files[p];
    nested["__MACOSX/My Book/._" + p.split("/").pop()] = "junk";
  });
  nested["__MACOSX/My Book/manifest.json"] = "{}";
  nested["My Book/.DS_Store"] = "junk";
  nested[".DS_Store"] = "junk";
  const win = {};
  Object.keys(nested).forEach((p) => { win["./" + p.replace(/\//g, "\\")] = nested[p]; });
  for(const input of [nested, win]){
    const back = parseBundle(input, { uid: counter() });
    assert.deepEqual(back.warnings, []);
    assert.deepEqual(back.scenes, data.scenes);
    assert.deepEqual(back.bible, data.bible);
  }
});

test("errors: missing manifest, ambiguous folders, wrong format, newer version", () => {
  assert.throws(() => parseBundle({ "a.md": "x" }), /Not an Ownchat project bundle/);
  assert.throws(() => parseBundle({ "a/manifest.json": "{}", "b/manifest.json": "{}" }), /Not an Ownchat project bundle/);
  assert.throws(() => parseBundle({ "manifest.json": "not json" }), /Not an Ownchat project bundle/);
  assert.throws(() => parseBundle({ "manifest.json": JSON.stringify({ format: "other", version: 1, project: {} }) }), /Not an Ownchat project bundle/);
  assert.throws(() => parseBundle({ "manifest.json": JSON.stringify({ format: "ownchat-project", version: 2, project: {} }) }),
    /Made by a newer version of Ownchat Write/);
});

test("missing files produce warnings, not failures", () => {
  const data = fixture();
  const { files } = buildBundle(data, { now: NOW });
  delete files["scenes/01-beginnings/01-arrival.md"];
  delete files["bible/place-елкино.md"];
  files["chat/project-thread.json"] = "{broken";
  const back = parseBundle(files);
  const s1 = back.scenes.find((s) => s.id === "s1");
  assert.deepEqual(s1.blocks, []);
  assert.equal(s1.wordCount, 0);
  assert.equal(s1.title, "Arrival");
  assert.equal(back.bible.cards.length, 3);
  assert.deepEqual(back.thread.messages, []);
  assert.equal(back.thread.id, "t-p1");
  assert.equal(back.warnings.length, 3);
  assert.ok(back.warnings[0].includes("01-arrival.md"));
});

test("hand edits: Markdown decides title, summary, text and card fields; ids follow the manifest", () => {
  const data = fixture();
  const { files } = buildBundle(data, { now: NOW });
  files["scenes/01-beginnings/01-arrival.md"] =
    "---\nid: \"zzz\"\norder: 9\ntitle: Dawn arrival\nsummary: \"New summary\"\n---\n\nShe came at dawn.\n\nThe town slept.\n\nA new paragraph here.\n";
  files["scenes/01-beginnings/02-arrival-2.md"] = "---\ntitle: \"Second\"\n---\n\nRewritten single paragraph.\n";
  files["bible/character-liz.md"] = files["bible/character-liz.md"].replace('name: "Liz"', 'name: "Elizabeth"').replace("Tall.", "Very tall.");
  const back = parseBundle(files, { uid: counter() });
  const s1 = back.scenes.find((s) => s.id === "s1");
  assert.equal(s1.title, "Dawn arrival");
  assert.equal(s1.summary, "New summary");
  assert.equal(s1.order, 0);
  assert.equal(s1.chapterId, "c1");
  assert.deepEqual(s1.blocks.map((b) => b.id), ["u1", "u2", "u3"]);
  assert.equal(s1.wordCount, 11);
  const s2 = back.scenes.find((s) => s.id === "s2");
  assert.deepEqual(s2.blocks, [{ id: "s2-b0", text: "Rewritten single paragraph." }]);
  assert.equal(s2.summary, "");
  const k1 = back.bible.cards.find((c) => c.id === "k1");
  assert.equal(k1.name, "Elizabeth");
  assert.ok(k1.body.startsWith("Very tall."));
});

test("scenes whose chapter is missing go to an Imported chapter", () => {
  const data = fixture();
  data.scenes.push(scene("s9", "gone", 4, "Lost", ["Lost text"]));
  const { files } = buildBundle(data, { now: NOW });
  assert.ok(files["scenes/unfiled/01-lost.md"]);
  const back = parseBundle(files, { uid: counter("x"), now: 42 });
  const imp = back.chapters.find((c) => c.title === "Imported");
  assert.deepEqual(imp, { id: "x1", projectId: "p1", order: 4, title: "Imported", createdAt: 42, updatedAt: 42 });
  const s9 = back.scenes.find((s) => s.id === "s9");
  assert.equal(s9.chapterId, "x1");
  assert.equal(s9.order, 0);
  assert.equal(back.warnings.length, 1);
});

test("buildManuscript", () => {
  const d = fixture();
  const md = buildManuscript(d.project, d.chapters, d.scenes);
  assert.equal(md,
    "# The Long Road: A \"Novel\"\n\n" +
    "## Beginnings\n\nShe came at dawn.\n\nThe town slept.\n\n* * *\n\nSecond: with \"quotes\" and a: colon.\n\n" +
    "## Beginnings\n\n---\n\nBody with --- inside.\n\n" +
    "## Пролог: ёлка\n\nПривет, мир.\n\n" +
    "## Untitled chapter\n\nUntitled scene text.\n");
  assert.equal(buildManuscript({ title: "" }, [], []), "# Untitled\n");
});

// ---- scene threads and card sources ----

function sceneThread(sceneId, n){
  return { id: "ts-" + sceneId, projectId: "p1", scope: "scene", sceneId, includeScene: true,
    messages: Array.from({ length: n }, (_, i) => ({ id: sceneId + "-m" + i, role: "user", content: "Q" + i })),
    summary: "", summarizedUpTo: 0, summarizedUpToId: null, summaryModel: "", summaryUpdatedAt: 0,
    lastUsage: null, updatedAt: 3 };
}

test("scene threads and card sources round trip", () => {
  const data = fixture();
  data.sceneThreads = [sceneThread("s4", 2), sceneThread("s1", 1)];
  const source = { kind: "chat", threadId: "ts-s1", messageId: "s1-m0" };
  data.bible.cards[1].source = source;
  const { files, manifest } = buildBundle(data, { now: NOW });
  assert.deepEqual(manifest.sceneThreads, [
    { sceneId: "s4", file: "chat/scene-s4.json" },
    { sceneId: "s1", file: "chat/scene-s1.json" }
  ]);
  manifest.sceneThreads.forEach((e) => assert.ok(files[e.file].endsWith("\n")));
  assert.deepEqual(JSON.parse(files["manifest.json"]).sceneThreads, manifest.sceneThreads);
  assert.ok(files["bible/character-liz-2.md"].includes('\nsource: {"kind":"chat","threadId":"ts-s1","messageId":"s1-m0"}\n'));
  const back = parseBundle(files, { uid: counter() });
  assert.deepEqual(back.warnings, []);
  assert.deepEqual(back.sceneThreads, data.sceneThreads);
  const k2 = back.bible.cards.find((c) => c.id === "k2");
  assert.equal(k2.source.kind, "chat");
  assert.equal(k2.source.messageId, "s1-m0");
  assert.ok(!back.bible.cards.find((c) => c.id === "k1").source);
});

test("cards without source keep their exact file; sceneThreads defaults", () => {
  const data = fixture();
  data.bible.cards[0].source = null;
  const { files, manifest } = buildBundle(data, { now: NOW });
  assert.equal(files["bible/character-liz.md"],
    '---\nid: "k1"\ntype: "character"\nname: "Liz"\naliases: ["Lizzie"]\npinned: true\nstatus: "approved"\n---\n\nTall.\n---\nNot a front matter.\n');
  assert.deepEqual(manifest.sceneThreads, []);
  assert.ok(!Object.keys(files).some((p) => p.startsWith("chat/scene-")));
  const m = JSON.parse(files["manifest.json"]);
  delete m.sceneThreads;
  files["manifest.json"] = JSON.stringify(m);
  const back = parseBundle(files);
  assert.deepEqual(back.sceneThreads, []);
  assert.deepEqual(back.warnings, []);
});

test("invalid scene thread files are skipped with a warning", () => {
  const data = fixture();
  data.sceneThreads = [sceneThread("s1", 1), sceneThread("s2", 1), sceneThread("s3", 1), sceneThread("Same", 0), sceneThread("same", 0)];
  const { files, manifest } = buildBundle(data, { now: NOW });
  assert.deepEqual(manifest.sceneThreads.slice(3).map((e) => e.file), ["chat/scene-same.json", "chat/scene-same-2.json"]);
  files["chat/scene-s1.json"] = "{broken";
  files["chat/scene-s2.json"] = JSON.stringify({ messages: "nope" });
  delete files["chat/scene-s3.json"];
  const back = parseBundle(files);
  assert.deepEqual(back.sceneThreads.map((t) => t.sceneId), ["Same", "same"]);
  assert.equal(back.warnings.length, 3);
  assert.equal(back.warnings[0], "Scene chat for s1 is not valid; skipped");
  assert.equal(back.warnings[1], "Scene chat for s2 is not valid; skipped");
  assert.ok(back.warnings[2].includes("chat/scene-s3.json"));
});

test("a user message's selection survives the round trip", () => {
  const data = fixture();
  const selection = { label: "part of paragraph 2", paraFrom: 2, paraTo: 2, paraCount: 3, partial: true, excerpt: "the town" };
  data.thread.messages[0] = Object.assign({}, data.thread.messages[0], { display: "Hi", selection });
  const back = parseBundle(buildBundle(data, { now: NOW }).files, { uid: counter() });
  assert.deepEqual(back.thread.messages[0].selection, selection);
});
