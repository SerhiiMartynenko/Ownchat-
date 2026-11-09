import test from "node:test";
import assert from "node:assert/strict";
import { createDigest } from "./digest.js";
import { SCENE_SENTINEL } from "./summaries.js";
import { emptyBible, newCard } from "./bible.js";
import { hashText } from "./util.js";
import { blocksToText } from "./scene.js";

const words = (n, w) => Array.from({ length: n }, () => w || "word").join(" ");
const REPLY = "They met at the pier.\n### Proposed facts\n- [place] Pier: Rotten boards.\n- [character] Liz: Already known.";

function setup(o) {
  o = o || {};
  const scenes = {};
  (o.scenes || []).forEach(s => { scenes[s.id] = { projectId: "p1", title: "T", summary: "", summaryHash: "", ...s }; });
  const log = { calls: [], patches: [], updated: [], errors: [], bibles: [], states: 0, order: [] };
  let bible = o.bible === undefined ? { ...emptyBible(), cards: [newCard({ id: "liz", name: "Liz" })] } : o.bible;
  let n = 0;
  const deps = {
    loadScene: async (id) => { log.order.push(id); return scenes[id] ? { scene: { ...scenes[id] }, chapterTitle: "One" } : null; },
    patchScene: async (id, fields) => {
      log.patches.push([id, fields]);
      if (o.beforePatch) o.beforePatch(scenes, id);
      if (!scenes[id]) return null;
      scenes[id] = { ...scenes[id], ...fields };
      return { ...scenes[id] };
    },
    getBible: () => bible,
    setBible: async (pid, b) => { log.bibles.push([pid, b]); bible = b; },
    getSettings: () => ({ apiKey: "apiKey" in o ? o.apiKey : "k", utilityModel: "util/m" }),
    callApi: o.callApi || (async (args) => { log.calls.push(args); return { content: REPLY }; }),
    uid: () => "u" + (++n),
    now: () => 1000,
    onSceneUpdated: (s) => log.updated.push(s),
    onStateChange: () => { log.states++; },
    onError: (id, err, opt) => log.errors.push([id, err.message, opt]),
    opts: o.opts
  };
  const d = createDigest(deps);
  return { d, log, scenes, deps, getBible: () => bible };
}

const blocks = (text) => [{ id: "b1", text }];
const scene = (id, text, extra) => ({ id, blocks: blocks(text), ...extra });
// Waits until nothing is queued or in flight.
const idle = async (d, ids) => {
  for (let i = 0; i < 500; i++) {
    if (!d.pending().length && !(ids || []).some(id => d.isRunning(id))) { await new Promise(r => setTimeout(r, 5)); if (!d.pending().length) return; }
    await new Promise(r => setTimeout(r, 2));
  }
  throw new Error("digest did not go idle");
};

test("summarizeNow writes the summary, hash of the summarised text and proposes facts", async () => {
  const text = words(50);
  const { d, log, scenes, getBible } = setup({ scenes: [scene("s1", text, { title: "Pier", summary: "Old." })] });
  const r = await d.summarizeNow("s1");
  assert.equal(log.calls.length, 1);
  const c = log.calls[0];
  assert.equal(c.model, "util/m");
  assert.equal(c.thinking, "off");
  assert.ok(c.signal);
  assert.ok(c.messages[0].content.includes(SCENE_SENTINEL));
  assert.ok(c.messages[0].content.includes("story bible (Liz)"));
  assert.ok(c.messages[1].content.startsWith("Chapter: One\nScene: Pier\n\nPrevious summary (may be out of date):\nOld."));
  assert.equal(scenes.s1.summary, "They met at the pier.");
  assert.equal(scenes.s1.summaryHash, hashText(text));
  assert.equal(scenes.s1.summaryUpdatedAt, 1000);
  assert.equal(scenes.s1.summaryModel, "util/m");
  assert.equal(log.updated.length, 1);
  assert.equal(r.summary, "They met at the pier.");
  assert.equal(r.facts.length, 2);
  assert.deepEqual(r.added.map(a => a.name), ["Pier"]);
  assert.deepEqual(r.added[0].source, { kind: "scene", sceneId: "s1", sceneTitle: "Pier", at: 1000 });
  assert.equal(r.added[0].status, "proposed");
  assert.equal(log.bibles.length, 1);
  assert.equal(log.bibles[0][0], "p1");
  assert.deepEqual(getBible().cards.map(c => c.name), ["Liz", "Pier"]);
  assert.equal(d.isRunning("s1"), false);
  assert.ok(log.states >= 2);
});

test("hash is of the text that was summarised, not of a later edit", async () => {
  const text = words(50);
  const { d, scenes } = setup({ scenes: [scene("s1", text)], beforePatch: (sc, id) => { sc[id].blocks = blocks(words(60, "edit")); } });
  await d.summarizeNow("s1");
  assert.equal(scenes.s1.summaryHash, hashText(text));
  assert.notEqual(scenes.s1.summaryHash, hashText(blocksToText(scenes.s1.blocks)));
});

test("no bible open: summary written, facts skipped", async () => {
  const { d, log, scenes } = setup({ scenes: [scene("s1", words(50))], bible: null });
  const r = await d.summarizeNow("s1");
  assert.equal(scenes.s1.summary, "They met at the pier.");
  assert.ok(log.calls[0].messages[0].content.includes("story bible ((none))"));
  assert.deepEqual(r.added, []);
  assert.equal(log.bibles.length, 0);
});

test("no new facts: bible not saved", async () => {
  const callApi = async () => ({ content: "Digest.\n### Proposed facts\n- none" });
  const { d, log } = setup({ scenes: [scene("s1", words(50))], callApi });
  const r = await d.summarizeNow("s1");
  assert.deepEqual(r, { summary: "Digest.", facts: [], added: [] });
  assert.equal(log.bibles.length, 0);
});

test("skip without an API key; error only when forced", async () => {
  const { d, log } = setup({ scenes: [scene("s1", words(50))], apiKey: "" });
  assert.equal(await d.summarizeNow("s1"), null);
  assert.equal(log.calls.length, 0);
  assert.deepEqual(log.errors, []);
  assert.equal(await d.summarizeNow("s1", { force: true }), null);
  assert.deepEqual(log.errors, [["s1", "Add your OpenRouter API key first", { force: true }]]);
  assert.equal(log.patches.length, 0);
});

test("fresh summary skipped unless forced", async () => {
  const text = words(50);
  const { d, log } = setup({ scenes: [scene("s1", text, { summary: "Have.", summaryHash: hashText(text) })] });
  assert.equal(await d.summarizeNow("s1"), null);
  assert.equal(log.calls.length, 0);
  const r = await d.summarizeNow("s1", { force: true });
  assert.equal(r.summary, "They met at the pier.");
  assert.equal(log.calls.length, 1);
});

test("stale hash with an empty summary is summarised", async () => {
  const text = words(50);
  const { d, log } = setup({ scenes: [scene("s1", text, { summary: "", summaryHash: hashText(text) })] });
  await d.summarizeNow("s1");
  assert.equal(log.calls.length, 1);
});

test("below minWords skipped unless forced; old summary stays", async () => {
  const { d, log, scenes } = setup({ scenes: [scene("s1", words(10), { summary: "Old." })] });
  assert.equal(await d.summarizeNow("s1"), null);
  assert.equal(log.calls.length, 0);
  assert.equal(scenes.s1.summary, "Old.");
  await d.summarizeNow("s1", { force: true });
  assert.equal(log.calls.length, 1);
  const lowMin = setup({ scenes: [scene("s1", words(10))], opts: { minWords: 5 } });
  await lowMin.d.summarizeNow("s1");
  assert.equal(lowMin.log.calls.length, 1);
});

test("empty scene clears a stored summary without calling the API", async () => {
  const { d, log, scenes } = setup({ scenes: [{ id: "s1", blocks: [], summary: "Old.", summaryHash: "x", summaryModel: "m" }, { id: "s2", blocks: [] }] });
  assert.equal(await d.summarizeNow("s1", { force: true }), null);
  assert.deepEqual(log.patches, [["s1", { summary: "", summaryHash: hashText(""), summaryUpdatedAt: 1000, summaryModel: "" }]]);
  assert.equal(scenes.s1.summary, "");
  assert.equal(log.updated.length, 1);
  assert.equal(await d.summarizeNow("s2"), null);
  assert.equal(log.patches.length, 1);
  assert.equal(log.calls.length, 0);
});

test("API error: no write, onError called, not running afterwards", async () => {
  const err = new Error("boom");
  const { d, log, scenes } = setup({ scenes: [scene("s1", words(50), { summary: "Old." })], callApi: async () => { throw err; } });
  assert.equal(await d.summarizeNow("s1"), null);
  assert.deepEqual(log.errors, [["s1", "boom", { force: false }]]);
  assert.equal(log.patches.length, 0);
  assert.equal(scenes.s1.summary, "Old.");
  assert.equal(d.isRunning("s1"), false);
  assert.deepEqual(d.pending(), []);
  // The loop keeps working afterwards.
  d.queue("s1");
  await idle(d, ["s1"]);
  assert.equal(log.errors.length, 2);
});

test("aborted or empty reply: no write", async () => {
  for (const content of [{ aborted: true, content: "x" }, { content: "" }]) {
    const { d, log } = setup({ scenes: [scene("s1", words(50))], callApi: async () => content });
    assert.equal(await d.summarizeNow("s1"), null);
    assert.equal(log.patches.length, 0);
    assert.equal(log.updated.length, 0);
    assert.deepEqual(log.errors, []);
  }
});

test("vanished scene is a no-op (before load and before patch)", async () => {
  const a = setup({ scenes: [] });
  assert.equal(await a.d.summarizeNow("gone"), null);
  assert.equal(a.log.calls.length, 0);
  const b = setup({ scenes: [scene("s1", words(50))], beforePatch: (sc, id) => { delete sc[id]; } });
  assert.equal(await b.d.summarizeNow("s1"), null);
  assert.equal(b.log.updated.length, 0);
  assert.equal(b.log.bibles.length, 0);
});

test("queue dedupes and runs serially in order", async () => {
  let inFlight = 0, maxInFlight = 0;
  const seen = [];
  const callApi = async (args) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    seen.push(args.messages[1].content.split("\n")[1]);
    await new Promise(r => setTimeout(r, 2));
    inFlight--;
    return { content: "Digest." };
  };
  const { d, log } = setup({ scenes: ["a", "b", "c"].map(id => scene(id, words(50), { title: id })), callApi });
  d.queue("a"); d.queue("b"); d.queue("c"); d.queue("b"); d.queue("c");
  assert.equal(d.isRunning("a"), true);
  assert.deepEqual(d.pending(), ["b", "c"]);
  // An id already in flight may be queued again (its text may have changed); unchanged, it is then skipped as fresh.
  d.queue("a");
  assert.deepEqual(d.pending(), ["b", "c", "a"]);
  await idle(d, ["a", "b", "c"]);
  assert.deepEqual(seen, ["Scene: a", "Scene: b", "Scene: c"]);
  assert.equal(maxInFlight, 1);
  assert.deepEqual(log.order, ["a", "b", "c", "a"]);
  assert.deepEqual(d.pending(), []);
});

test("summarizeNow waits for the in-flight job, then jumps the queue", async () => {
  const seen = [];
  const callApi = async (args) => { seen.push(args.messages[1].content.split("\n")[1]); await new Promise(r => setTimeout(r, 2)); return { content: "Digest " + seen.length + "." }; };
  const { d } = setup({ scenes: ["a", "b", "c"].map(id => scene(id, words(50), { title: id })), callApi });
  d.queue("a"); d.queue("b");
  const r = await d.summarizeNow("c");
  assert.equal(r.summary, "Digest 2.");
  assert.deepEqual(seen, ["Scene: a", "Scene: c"]);
  await idle(d, ["a", "b", "c"]);
  assert.deepEqual(seen, ["Scene: a", "Scene: c", "Scene: b"]);
});

test("forget removes queued ids but not the one in flight", async () => {
  const seen = [];
  const callApi = async (args) => { seen.push(args.messages[1].content.split("\n")[1]); await new Promise(r => setTimeout(r, 2)); return { content: "D." }; };
  const { d } = setup({ scenes: ["a", "b", "c"].map(id => scene(id, words(50), { title: id })), callApi });
  d.queue("a"); d.queue("b"); d.queue("c");
  d.forget(["a", "b"]);
  assert.deepEqual(d.pending(), ["c"]);
  await idle(d, ["a", "b", "c"]);
  assert.deepEqual(seen, ["Scene: a", "Scene: c"]);
});
