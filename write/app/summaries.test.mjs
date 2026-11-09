import test from "node:test";
import assert from "node:assert/strict";
import { SUMMARY_DEFAULTS, planFold, formatForSummary, buildSummaryRequest, cleanSummary, runFold,
  SCENE_SUMMARY_DEFAULTS, FACTS_HEADING, SCENE_SENTINEL, buildSceneSummaryRequest, parseSummaryReply, runSceneSummary } from "./summaries.js";
import { hashText } from "./util.js";

let n = 0;
const msg = (role, content) => ({ id: "m" + (n++), role, content });
function chat(pairs, size) {
  const out = [];
  const body = "x".repeat(size || 4);
  for (let i = 0; i < pairs; i++) { out.push(msg("user", body)); out.push(msg("assistant", body)); }
  return out;
}

test("planFold returns null under thresholds", () => {
  assert.equal(planFold(chat(8), 0, {}, false), null); // 16 messages
});

test("planFold triggers on count and keeps a user-first tail", () => {
  const m = chat(9); // 18 messages
  const p = planFold(m, 0, {}, false);
  assert.deepEqual(p, { from: 0, to: 10 });
  assert.equal(m[p.to].role, "user");
});

test("planFold triggers on tokens", () => {
  const m = chat(6, 4000); // 12 messages, 12000 tokens total
  assert.equal(planFold(m, 0, {}, false), null);
  const m2 = chat(6, 4004);
  const p = planFold(m2, 0, { maxFoldTokens: 1e9 }, false);
  assert.deepEqual(p, { from: 0, to: 4 });
});

test("planFold respects the user boundary", () => {
  const m = [...chat(9)];
  m.splice(11, 0, msg("assistant", "extra")); // 19 msgs; 19 - 8 = 11 is now an assistant message
  const p = planFold(m, 0, {}, false);
  assert.deepEqual(p, { from: 0, to: 10 });
  assert.equal(m[p.to].role, "user");
  assert.ok(m.length - p.to >= SUMMARY_DEFAULTS.keepVerbatim);
});

test("planFold caps at maxFoldTokens on a user boundary, folding at least 2", () => {
  const m = chat(12, 400); // 100 tokens each
  const p = planFold(m, 0, { maxFoldTokens: 450 }, false);
  assert.deepEqual(p, { from: 0, to: 4 });
  const p2 = planFold(m, 0, { maxFoldTokens: 10 }, false);
  assert.deepEqual(p2, { from: 0, to: 2 });
});

test("planFold force uses forceKeep; never folds fewer than 2", () => {
  const m = chat(3);
  assert.deepEqual(planFold(m, 0, {}, true), { from: 0, to: 4 });
  assert.equal(planFold(m, 0, {}, false), null);
  assert.equal(planFold(chat(1), 0, {}, true), null);
  assert.equal(planFold(m, 3, {}, true), null); // only 1 message between 3 and 4
  assert.deepEqual(planFold(chat(4), 2, {}, true), { from: 2, to: 6 });
});

test("formatForSummary uses display and truncates", () => {
  assert.equal(formatForSummary({ role: "user", content: "hi + file", display: "hi" }, 100), "[Author]: hi");
  assert.equal(formatForSummary({ role: "assistant", content: "abcdef" }, 3), "[Assistant]: abc […truncated]");
});

test("buildSummaryRequest contains the summary, card names and messages", () => {
  const r = buildSummaryRequest({ summary: "- old point", slice: [{ role: "user", content: "y".repeat(7000) }, { role: "assistant", content: "ok" }], cardNames: ["Liz", "Harbor"], targetWords: 300 });
  assert.equal(r.length, 2);
  assert.equal(r[0].role, "system");
  assert.ok(r[0].content.includes("story bible: Liz, Harbor."));
  assert.ok(r[0].content.includes("At most 300 words"));
  assert.ok(r[1].content.startsWith("Current summary:\n- old point\n\nNew messages to fold in, oldest first:\n[Author]: "));
  assert.ok(r[1].content.includes(" […truncated]\n\n[Assistant]: ok"));
  const e = buildSummaryRequest({ summary: "", slice: [], cardNames: [] });
  assert.ok(e[0].content.includes("story bible: (none)."));
  assert.ok(e[1].content.startsWith("Current summary:\n(none)"));
});

test("cleanSummary strips fences and preambles", () => {
  assert.equal(cleanSummary("```markdown\n- a\n- b\n```"), "- a\n- b");
  assert.equal(cleanSummary("Here is the updated summary:\n- a"), "- a");
  assert.equal(cleanSummary("Here's the summary:\n```\n- a\n```"), "- a");
  assert.equal(cleanSummary("  - a  "), "- a");
  assert.equal(cleanSummary(""), "");
});

test("runFold calls the API with the utility model and returns the new state", async () => {
  const m = chat(9);
  let seen;
  const callApi = async (o) => { seen = o; return { content: "```\n- folded\n```", aborted: false }; };
  const signal = new AbortController().signal;
  const r = await runFold({ messages: m, summary: "", summarizedUpTo: 0, cardNames: ["Liz"], callApi, model: "util/model", opts: {}, force: false, signal });
  assert.equal(seen.model, "util/model");
  assert.equal(seen.thinking, "off");
  assert.equal(seen.maxTokens, SUMMARY_DEFAULTS.maxTokens);
  assert.equal(seen.signal, signal);
  assert.equal(seen.messages[0].role, "system");
  assert.deepEqual(r, { summary: "- folded", summarizedUpTo: 10, summarizedUpToId: m[9].id, model: "util/model", facts: [] });
});

test("runFold returns null when nothing to fold, aborted or empty", async () => {
  let called = 0;
  const ok = async () => { called++; return { content: "x" }; };
  assert.equal(await runFold({ messages: chat(2), summarizedUpTo: 0, callApi: ok, model: "m" }), null);
  assert.equal(called, 0);
  assert.equal(await runFold({ messages: chat(9), summarizedUpTo: 0, callApi: async () => ({ aborted: true, content: "x" }), model: "m" }), null);
  assert.equal(await runFold({ messages: chat(9), summarizedUpTo: 0, callApi: async () => ({ content: "```\n```" }), model: "m" }), null);
});

// ---- Proposed facts and scene digests ----

test("fold prompt keeps its opening and asks for proposed facts", () => {
  const r = buildSummaryRequest({ summary: "", slice: [], cardNames: ["Liz"] });
  assert.ok(r[0].content.startsWith("You maintain a running summary of a conversation"));
  assert.ok(!r[0].content.includes("Output only the updated summary."));
  assert.ok(r[0].content.includes("Output the updated summary."));
  assert.ok(r[0].content.includes("`### Proposed facts`"));
  assert.ok(r[0].content.includes("- [character|place|thread] Name: one-sentence fact"));
  assert.ok(r[0].content.includes("not already in the story bible (Liz)"));
  assert.ok(r[0].content.includes("`- none`"));
});

test("buildSceneSummaryRequest contents", () => {
  assert.equal(FACTS_HEADING, "### Proposed facts");
  const r = buildSceneSummaryRequest({ title: "The pier", chapterTitle: "One", text: "Liz waits.", previousSummary: "Old digest.", cardNames: ["Liz", "Harbor"], targetWords: 120 });
  assert.equal(r.length, 2);
  assert.equal(r[0].role, "system");
  assert.equal(r[1].role, "user");
  const sys = r[0].content;
  assert.ok(sys.includes(SCENE_SENTINEL));
  assert.ok(sys.includes("past tense"));
  assert.ok(sys.includes("At most 120 words"));
  assert.ok(sys.includes("`" + FACTS_HEADING + "`"));
  assert.ok(sys.includes("not already in the story bible (Liz, Harbor)"));
  assert.ok(sys.includes("`- none`"));
  assert.ok(!sys.includes("\n"));
  assert.equal(r[1].content, "Chapter: One\nScene: The pier\n\nPrevious summary (may be out of date):\nOld digest.\n\nScene text:\nLiz waits.");
  const e = buildSceneSummaryRequest({ title: "T", chapterTitle: "", text: "x", previousSummary: "", cardNames: [] });
  assert.ok(e[0].content.includes("story bible ((none))"));
  assert.ok(e[0].content.includes("At most " + SCENE_SUMMARY_DEFAULTS.targetWords + " words"));
  assert.ok(e[1].content.includes("Previous summary (may be out of date):\n(none)\n\n"));
});

test("buildSceneSummaryRequest cuts the middle of a long scene", () => {
  const text = "A".repeat(50) + "M".repeat(100) + "Z".repeat(50);
  const r = buildSceneSummaryRequest({ title: "T", chapterTitle: "C", text, maxChars: 100 });
  const body = r[1].content.split("Scene text:\n")[1];
  assert.equal(body, "A".repeat(50) + "\n\n[… middle of the scene omitted]\n\n" + "Z".repeat(50));
  const short = buildSceneSummaryRequest({ title: "T", chapterTitle: "C", text: "abc", maxChars: 100 });
  assert.ok(short[1].content.endsWith("Scene text:\nabc"));
});

test("parseSummaryReply: plain text, bullets and none", () => {
  assert.deepEqual(parseSummaryReply("  They met at the pier.  "), { summary: "They met at the pier.", facts: [] });
  assert.deepEqual(parseSummaryReply(""), { summary: "", facts: [] });
  const r = parseSummaryReply("They met.\n\n### Proposed facts\n- [character] Liz: Wears a red coat.\n* [place] The Pier : Rotten boards.\n• [thread] The key: Still missing.");
  assert.equal(r.summary, "They met.");
  assert.deepEqual(r.facts, [
    { type: "character", name: "Liz", body: "Wears a red coat." },
    { type: "place", name: "The Pier", body: "Rotten boards." },
    { type: "thread", name: "The key", body: "Still missing." }
  ]);
  assert.deepEqual(parseSummaryReply("They met.\n### Proposed facts\n- none"), { summary: "They met.", facts: [] });
});

test("parseSummaryReply skips malformed bullets and unknown types; normalises types", () => {
  const r = parseSummaryReply("S.\n### Proposed facts\n- Liz: no type\n- [character] no colon here\n- [Plot Thread] The key: Lost.\n- [ CHARACTER ] Mark: Tall.\n- [object] Ring: Gold.\n- [note] N: x.\nsome prose");
  assert.deepEqual(r.facts, [{ type: "thread", name: "The key", body: "Lost." }, { type: "character", name: "Mark", body: "Tall." }]);
  assert.equal(r.summary, "S.");
});

test("parseSummaryReply heading variants, outer fence, preamble and last heading", () => {
  for (const h of ["## Proposed facts:", "**Proposed facts**", "Proposed facts", "  ### proposed facts", "#Proposed facts :"]) {
    const r = parseSummaryReply("Digest.\n" + h + "\n- [place] Dock: Wet.");
    assert.equal(r.summary, "Digest.", h);
    assert.deepEqual(r.facts, [{ type: "place", name: "Dock", body: "Wet." }], h);
  }
  const f = parseSummaryReply("```\nHere is the summary:\nDigest.\n### Proposed facts\n- [place] Dock: Wet.\n```");
  assert.deepEqual(f, { summary: "Digest.", facts: [{ type: "place", name: "Dock", body: "Wet." }] });
  const p = parseSummaryReply("Here is the updated summary:\n- a\n- b");
  assert.deepEqual(p, { summary: "- a\n- b", facts: [] });
  const last = parseSummaryReply("Digest.\n### Proposed facts\n- [place] A: x.\n### Proposed facts\n- [place] B: y.");
  assert.deepEqual(last.facts, [{ type: "place", name: "B", body: "y." }]);
  assert.ok(last.summary.includes("- [place] A: x."));
});

test("runFold returns parsed facts", async () => {
  const m = chat(9);
  const callApi = async () => ({ content: "- folded\n### Proposed facts\n- [character] Liz: Tall." });
  const r = await runFold({ messages: m, summarizedUpTo: 0, callApi, model: "u" });
  assert.equal(r.summary, "- folded");
  assert.deepEqual(r.facts, [{ type: "character", name: "Liz", body: "Tall." }]);
  assert.equal(await runFold({ messages: m, summarizedUpTo: 0, callApi: async () => ({ content: "### Proposed facts\n- [place] A: b." }), model: "u" }), null);
});

test("runSceneSummary call shape and result", async () => {
  let seen;
  const signal = new AbortController().signal;
  const text = "Liz waits on the pier. " + "x".repeat(300);
  const callApi = async (o) => { seen = o; return { content: "Liz waited.\n### Proposed facts\n- [place] Pier: Rotten.", aborted: false }; };
  const r = await runSceneSummary({ title: "Pier", chapterTitle: "One", text, previousSummary: "", cardNames: ["Liz"], callApi, model: "util/model", signal, opts: { maxChars: 100, maxTokens: 321 } });
  assert.equal(seen.model, "util/model");
  assert.equal(seen.thinking, "off");
  assert.equal(seen.maxTokens, 321);
  assert.equal(seen.signal, signal);
  assert.ok(seen.messages[0].content.includes(SCENE_SENTINEL));
  assert.ok(seen.messages[1].content.includes("[… middle of the scene omitted]"));
  assert.deepEqual(r, { summary: "Liz waited.", facts: [{ type: "place", name: "Pier", body: "Rotten." }], hash: hashText(text), model: "util/model" });
  const d = await runSceneSummary({ title: "P", chapterTitle: "", text: "t", callApi: async (o) => { seen = o; return { content: "x" }; }, model: "m" });
  assert.equal(seen.maxTokens, SCENE_SUMMARY_DEFAULTS.maxTokens);
  assert.equal(d.summary, "x");
});

test("runSceneSummary returns null on abort or empty summary", async () => {
  const base = { title: "P", chapterTitle: "", text: "t", model: "m" };
  assert.equal(await runSceneSummary({ ...base, callApi: async () => ({ aborted: true, content: "x" }) }), null);
  assert.equal(await runSceneSummary({ ...base, callApi: async () => ({ content: "  " }) }), null);
  assert.equal(await runSceneSummary({ ...base, callApi: async () => ({ content: "### Proposed facts\n- none" }) }), null);
  assert.equal(await runSceneSummary({ ...base, callApi: async () => null }), null);
});
