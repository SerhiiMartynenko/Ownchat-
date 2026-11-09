import test from "node:test";
import assert from "node:assert/strict";
import { SUMMARY_DEFAULTS, planFold, formatForSummary, buildSummaryRequest, cleanSummary, runFold } from "./summaries.js";

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
  assert.deepEqual(r, { summary: "- folded", summarizedUpTo: 10, summarizedUpToId: m[9].id, model: "util/model" });
});

test("runFold returns null when nothing to fold, aborted or empty", async () => {
  let called = 0;
  const ok = async () => { called++; return { content: "x" }; };
  assert.equal(await runFold({ messages: chat(2), summarizedUpTo: 0, callApi: ok, model: "m" }), null);
  assert.equal(called, 0);
  assert.equal(await runFold({ messages: chat(9), summarizedUpTo: 0, callApi: async () => ({ aborted: true, content: "x" }), model: "m" }), null);
  assert.equal(await runFold({ messages: chat(9), summarizedUpTo: 0, callApi: async () => ({ content: "```\n```" }), model: "m" }), null);
});
