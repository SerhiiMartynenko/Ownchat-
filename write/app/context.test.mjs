import test from "node:test";
import assert from "node:assert/strict";
import { assembleContext, CONTEXT_DEFAULTS, STORY_OMITTED_MARKER, SCENE_OMITTED_MARKER, SCENE_OMITTED_AFTER_MARKER,
  SELECTION_START, SELECTION_END, SELECTION_NOTE, selectionLabel, selectionExcerpt, selectionMeta, selectionNote } from "./context.js";
import { newCard, cardToText } from "./bible.js";
import { estimateTokens } from "./util.js";

const u = (content, id) => ({ id: id || content, role: "user", content });
const a = (content, id) => ({ id: id || content, role: "assistant", content });
const bible = (o) => ({ brief: "", styleGuide: "", cards: [], ...o });
const thread = (messages, o) => ({ messages, summary: "", summarizedUpTo: 0, ...o });
const sumLayers = (b) => b.layers.reduce((s, l) => s + l.tokens, 0);

test("exact degradation to today's request", () => {
  const msgs = [u("hi"), a("hello"), u("go on")];
  const { messages, breakdown } = assembleContext({ model: "openai/x", bible: bible({ styleGuide: "Be terse." }), thread: thread(msgs) });
  assert.deepEqual(messages, [{ role: "system", content: "Be terse." }, ...msgs.map(m => ({ role: m.role, content: m.content }))]);
  assert.equal(breakdown.cacheBreakpoints, 0);
  assert.equal(breakdown.overBudget, false);
});

test("no system message when bible is empty; empty preview", () => {
  const r = assembleContext({ model: "x", bible: bible(), thread: thread([u("hi")]) });
  assert.deepEqual(r.messages, [{ role: "user", content: "hi" }]);
  const e = assembleContext({ model: "x", bible: bible({ styleGuide: "S" }), thread: thread([]) });
  assert.deepEqual(e.messages, [{ role: "system", content: "S" }]);
  assert.equal(e.breakdown.layers[6].tokens, 0);
});

test("layer order and headings", () => {
  const cards = [newCard({ id: "c1", name: "Liz", type: "character" })];
  const { messages, breakdown } = assembleContext({
    model: "x", bible: bible({ styleGuide: "Style", brief: "Brief", cards }),
    thread: thread([u("old"), a("older reply"), u("q"), a("r"), u("about liz")], { summary: "Sum", summarizedUpTo: 2 })
  });
  const sys = messages[0].content;
  const iS = sys.indexOf("## Style guide\nStyle"), iB = sys.indexOf("## Brief\nBrief"),
    iC = sys.indexOf("## Story bible\n### Liz"), iSum = sys.indexOf("## Earlier in this conversation (summary; those messages are not shown)\nSum");
  assert.ok(iS === 0 && iS < iB && iB < iC && iC < iSum, sys);
  assert.deepEqual(messages.slice(1), [{ role: "user", content: "q" }, { role: "assistant", content: "r" }, { role: "user", content: "about liz" }]);
  assert.deepEqual(breakdown.layers.map(l => l.key), ["system", "cards", "story", "scene", "summary", "recent", "current"]);
  assert.equal(breakdown.layers[4].folded, 2);
  assert.equal(breakdown.layers[5].count, 2);
  assert.equal(breakdown.layers[5].droppedUnsummarized, 0);
  assert.equal(breakdown.total, sumLayers(breakdown));
});

test("name and alias matching is case-insensitive; pinned always included", () => {
  const cards = [
    newCard({ id: "1", name: "Elizabeth", aliases: ["Liz"] }),
    newCard({ id: "2", name: "Mark" }),
    newCard({ id: "3", name: "Harbor", pinned: true }),
    newCard({ id: "4", name: "Nobody" })
  ];
  const { breakdown, messages } = assembleContext({ model: "x", bible: bible({ cards }), thread: thread([u("LIZ and mArK talk")]) });
  const got = breakdown.layers[1].cards;
  assert.deepEqual(got.map(c => [c.id, c.reason]), [["3", "pinned"], ["1", "alias"], ["2", "name"]]);
  assert.ok(messages[0].content.includes("### Harbor"));
  assert.ok(!messages[0].content.includes("Nobody"));
});

test("cards are matched against the last scanMessages history messages", () => {
  const cards = [newCard({ id: "1", name: "Liz" }), newCard({ id: "2", name: "Mark" })];
  const msgs = [u("mark here"), a("x"), u("liz there"), a("y"), u("next")];
  const r = assembleContext({ model: "x", bible: bible({ cards }), thread: thread(msgs), options: { scanMessages: 2 } });
  assert.deepEqual(r.breakdown.layers[1].cards.map(c => c.id), ["1"]);
});

test("lowest-pos matched card dropped first when over cardBudget; pinned kept", () => {
  const body = "x".repeat(40);
  const cards = [
    newCard({ id: "p", name: "Pinned", body, pinned: true }),
    newCard({ id: "a", name: "Alpha", body }),
    newCard({ id: "b", name: "Beta", body })
  ];
  const one = estimateTokens(cardToText(cards[0]));
  const r = assembleContext({ model: "x", bible: bible({ cards }), thread: thread([u("alpha then beta")]), options: { cardBudget: one * 2 + 1 } });
  const L = r.breakdown.layers[1];
  assert.deepEqual(L.cards.map(c => c.id), ["p", "b"]);
  assert.deepEqual(L.dropped, [{ id: "a", name: "Alpha" }]);
  assert.equal(L.overBudget, false);

  const r2 = assembleContext({ model: "x", bible: bible({ cards }), thread: thread([u("alpha then beta")]), options: { cardBudget: 1 } });
  assert.deepEqual(r2.breakdown.layers[1].cards.map(c => c.id), ["p"]);
  assert.equal(r2.breakdown.layers[1].overBudget, true);
  assert.equal(r2.breakdown.overBudget, true);
});

test("oldest verbatim messages trimmed first, maxVerbatim respected", () => {
  const msgs = [];
  for (let i = 0; i < 10; i++) { msgs.push(u("user " + i)); msgs.push(a("assistant " + i)); }
  msgs.push(u("now"));
  const r = assembleContext({ model: "x", bible: bible(), thread: thread(msgs), options: { maxVerbatim: 5 } });
  // history ends with a9; the 5 newest are a7,u8,a8,u9,a9 and the leading a7 is dropped
  assert.deepEqual(r.messages.map(m => m.content), ["user 8", "assistant 8", "user 9", "assistant 9", "now"]);
  assert.equal(r.breakdown.layers[5].droppedUnsummarized, 20 - 4);

  const per = estimateTokens("user 9") + CONTEXT_DEFAULTS.msgOverhead; // all same size (3 tokens + 4)
  const cur = estimateTokens("now") + CONTEXT_DEFAULTS.msgOverhead;
  const r2 = assembleContext({ model: "x", bible: bible(), thread: thread(msgs), options: { totalBudget: cur + per * 3 } });
  assert.deepEqual(r2.messages.map(m => m.content), ["user 9", "assistant 9", "now"]);
});

test("leading assistant dropped after trimming", () => {
  const msgs = [u("u1"), a("a1"), u("u2"), a("a2"), u("now")];
  const r = assembleContext({ model: "x", bible: bible(), thread: thread(msgs), options: { maxVerbatim: 3 } });
  assert.deepEqual(r.messages.map(m => m.content), ["u2", "a2", "now"]);
  const r2 = assembleContext({ model: "x", bible: bible(), thread: thread(msgs, { summarizedUpTo: 1 }) });
  assert.equal(r2.messages[0].role, "user");
  assert.deepEqual(r2.messages.map(m => m.content), ["u2", "a2", "now"]);
});

test("brief, style and current never trimmed even when over budget", () => {
  const msgs = [u("u1"), a("a1"), u("the current message is long enough")];
  const r = assembleContext({ model: "x", bible: bible({ styleGuide: "Style text", brief: "Brief text" }), thread: thread(msgs, { summary: "A summary" }), options: { totalBudget: 5 } });
  assert.equal(r.messages.length, 2);
  assert.ok(r.messages[0].content.includes("Style text") && r.messages[0].content.includes("Brief text") && r.messages[0].content.includes("A summary"));
  assert.deepEqual(r.messages[1], { role: "user", content: "the current message is long enough" });
  assert.equal(r.breakdown.overBudget, true);
  assert.equal(r.breakdown.layers[5].count, 0);
  assert.equal(r.breakdown.layers[5].droppedUnsummarized, 2);
  assert.equal(r.breakdown.total, sumLayers(r.breakdown));
});

test("cache_control only for anthropic and arrays only then", () => {
  const cards = [newCard({ id: "1", name: "Liz" })];
  const args = { bible: bible({ styleGuide: "S", cards }), thread: thread([u("liz?")], { summary: "Sum" }) };
  const an = assembleContext({ model: "Anthropic/some-model", ...args });
  assert.ok(Array.isArray(an.messages[0].content));
  assert.equal(an.messages[0].content.length, 3);
  for (const p of an.messages[0].content) { assert.equal(p.type, "text"); assert.deepEqual(p.cache_control, { type: "ephemeral" }); }
  assert.equal(an.messages[0].content[0].text, "S");
  assert.equal(typeof an.messages[1].content, "string");
  assert.equal(an.breakdown.cacheBreakpoints, 3);
  const op = assembleContext({ model: "openai/some-model", ...args });
  assert.equal(typeof op.messages[0].content, "string");
  assert.ok(!JSON.stringify(op.messages).includes("cache_control"));
  assert.equal(op.breakdown.cacheBreakpoints, 0);
  assert.equal(op.messages[0].content, an.messages[0].content.map(p => p.text).join("\n\n"));
});

test("breakdown layer sum equals total", () => {
  const cards = [newCard({ id: "1", name: "Liz", body: "Body" }), newCard({ id: "2", name: "Pin", pinned: true })];
  const r = assembleContext({ model: "x", bible: bible({ styleGuide: "S", brief: "B", cards }), thread: thread([u("Liz"), a("ok"), u("Привет")], { summary: "Sum" }) });
  assert.equal(r.breakdown.total, sumLayers(r.breakdown));
  assert.equal(r.breakdown.budget, CONTEXT_DEFAULTS.totalBudget);
  assert.ok(r.breakdown.layers.every(l => l.key === "scene" || l.key === "story" ? l.tokens === 0 : l.tokens > 0));
});

test("summarizedUpTo omits folded messages and adds the summary layer", () => {
  const msgs = [u("folded one"), a("folded two"), u("kept"), a("kept reply"), u("now")];
  const r = assembleContext({ model: "x", bible: bible(), thread: thread(msgs, { summary: "  Earlier stuff  ", summarizedUpTo: 2 }) });
  assert.equal(r.messages[0].content, "## Earlier in this conversation (summary; those messages are not shown)\nEarlier stuff");
  assert.ok(!JSON.stringify(r.messages).includes("folded"));
  assert.equal(r.messages.length, 4);
});

test("draft mode uses all messages as history", () => {
  const msgs = [u("u1"), a("a1")];
  const r = assembleContext({ model: "x", bible: bible(), thread: thread(msgs), draft: "draft text" });
  assert.deepEqual(r.messages, [{ role: "user", content: "u1" }, { role: "assistant", content: "a1" }, { role: "user", content: "draft text" }]);
});

test("empty draft previews all messages as history with no current message", () => {
  const msgs = [u("u1"), a("a1")];
  const r = assembleContext({ model: "x", bible: bible(), thread: thread(msgs), draft: "" });
  assert.deepEqual(r.messages, [{ role: "user", content: "u1" }, { role: "assistant", content: "a1" }]);
  assert.equal(r.breakdown.layers[6].tokens, 0);
  assert.equal(r.breakdown.layers[5].count, 2);
});

test("throws when the last message is not from the user and there is no draft", () => {
  assert.throws(() => assembleContext({ model: "x", bible: bible(), thread: thread([u("u1"), a("a1")]) }), /last message must be from the user/);
});

// ---- Current-scene layer ----

const SCENE_HEAD = "## Current scene: ";
const MARKER = "[… earlier part of this scene omitted]\n\n";
const richArgs = () => ({
  bible: bible({ brief: "B", styleGuide: "S", cards: [newCard({ id: "1", name: "Liz", body: "Red coat." }), newCard({ id: "2", name: "Pin", pinned: true })] }),
  thread: thread([u("old"), a("older"), u("q"), a("r"), u("about liz")], { summary: "Sum", summarizedUpTo: 2 })
});

test("no scene: output identical to the pre-scene request (anthropic and others)", () => {
  // Captured from assembleContext before the scene layer existed.
  const expectedAnthropic = [{ role: "system", content: [
    { type: "text", text: "## Style guide\nS\n\n## Brief\nB", cache_control: { type: "ephemeral" } },
    { type: "text", text: "## Story bible\n### Pin (note)\n\n### Liz (note)\nRed coat.", cache_control: { type: "ephemeral" } },
    { type: "text", text: "## Earlier in this conversation (summary; those messages are not shown)\nSum", cache_control: { type: "ephemeral" } }
  ] }, { role: "user", content: "q" }, { role: "assistant", content: "r" }, { role: "user", content: "about liz" }];
  const expectedOther = [{ role: "system", content: "## Style guide\nS\n\n## Brief\nB\n\n## Story bible\n### Pin (note)\n\n### Liz (note)\nRed coat.\n\n## Earlier in this conversation (summary; those messages are not shown)\nSum" },
    { role: "user", content: "q" }, { role: "assistant", content: "r" }, { role: "user", content: "about liz" }];
  for (const scene of [undefined, null]) {
    const an = assembleContext({ model: "anthropic/m", ...richArgs(), scene });
    const op = assembleContext({ model: "openai/m", ...richArgs(), scene });
    assert.equal(JSON.stringify(an.messages), JSON.stringify(expectedAnthropic));
    assert.equal(JSON.stringify(op.messages), JSON.stringify(expectedOther));
    const L = op.breakdown.layers[3];
    assert.deepEqual(L, { key: "scene", label: "Current scene", tokens: 0, title: "", included: false, truncated: false, omittedTokens: 0, selection: false });
    assert.ok(!JSON.stringify(op.messages).includes(SCENE_HEAD));
    assert.equal(an.breakdown.cacheBreakpoints, 3);
  }
});

test("scene layer sits after cards and before the summary (string system content)", () => {
  const r = assembleContext({ model: "x", ...richArgs(), scene: { title: "The pier", text: "Waves.\n\nGulls." } });
  const sys = r.messages[0].content;
  const iCards = sys.indexOf("## Story bible"), iScene = sys.indexOf(SCENE_HEAD + "The pier\nWaves.\n\nGulls."), iSum = sys.indexOf("## Earlier in this conversation");
  assert.ok(iCards > 0 && iCards < iScene && iScene < iSum, sys);
  assert.deepEqual(r.breakdown.layers.map(l => l.key), ["system", "cards", "story", "scene", "summary", "recent", "current"]);
  const L = r.breakdown.layers[3];
  assert.equal(L.label, "Current scene");
  assert.equal(L.title, "The pier");
  assert.equal(L.included, true);
  assert.equal(L.truncated, false);
  assert.equal(L.omittedTokens, 0);
  assert.equal(L.tokens, estimateTokens(SCENE_HEAD + "The pier\nWaves.\n\nGulls."));
});

test("scene layer position in anthropic parts; at most 4 parts all cached", () => {
  const r = assembleContext({ model: "anthropic/m", ...richArgs(), scene: { title: "", text: "Night falls." } });
  const parts = r.messages[0].content;
  assert.ok(Array.isArray(parts));
  assert.ok(parts.length <= 4);
  assert.equal(parts.length, 4);
  assert.ok(parts[0].text.startsWith("## Style guide"));
  assert.ok(parts[1].text.startsWith("## Story bible"));
  assert.equal(parts[2].text, SCENE_HEAD + "Untitled\nNight falls.");
  assert.ok(parts[3].text.startsWith("## Earlier in this conversation"));
  for (const p of parts) { assert.equal(p.type, "text"); assert.deepEqual(p.cache_control, { type: "ephemeral" }); }
  assert.equal(r.breakdown.cacheBreakpoints, 4);
  // Only the scene: a single part.
  const only = assembleContext({ model: "anthropic/m", bible: bible(), thread: thread([u("hi")]), scene: { title: "T", text: "x" } });
  assert.deepEqual(only.messages[0].content, [{ type: "text", text: SCENE_HEAD + "T\nx", cache_control: { type: "ephemeral" } }]);
  assert.equal(only.breakdown.cacheBreakpoints, 1);
});

test("over-budget scene drops paragraphs from the start and keeps the end", () => {
  const paras = Array.from({ length: 10 }, (_, i) => "Paragraph " + i + " " + "w".repeat(80));
  const text = paras.join("\n\n");
  const budget = 80;
  const r = assembleContext({ model: "x", bible: bible(), thread: thread([u("go")]), scene: { title: "Long", text }, options: { sceneBudget: budget } });
  const sys = r.messages[0].content;
  assert.ok(sys.startsWith(SCENE_HEAD + "Long\n" + MARKER), sys);
  assert.ok(sys.endsWith(paras[9]));
  assert.ok(!sys.includes("Paragraph 0 "));
  const kept = sys.slice((SCENE_HEAD + "Long\n" + MARKER).length);
  assert.ok(text.endsWith(kept));
  assert.ok(kept.split("\n\n").every(p => paras.includes(p)), "only whole paragraphs kept");
  const L = r.breakdown.layers[3];
  assert.equal(L.truncated, true);
  assert.ok(L.tokens <= budget);
  assert.equal(L.tokens, estimateTokens(sys));
  assert.equal(L.omittedTokens, estimateTokens(text.slice(0, text.length - kept.length)));
  assert.ok(L.omittedTokens > 0);
});

test("tiny sceneBudget cuts characters from the start of the last paragraph", () => {
  const text = "First paragraph.\n\n" + "abcdefghij".repeat(20);
  const prefix = SCENE_HEAD + "T\n" + MARKER;
  const budget = estimateTokens(prefix) + 3;
  const r = assembleContext({ model: "x", bible: bible(), thread: thread([u("go")]), scene: { title: "T", text }, options: { sceneBudget: budget } });
  const sys = r.messages[0].content;
  assert.ok(sys.startsWith(prefix));
  const kept = sys.slice(prefix.length);
  assert.ok(kept.length > 0 && kept.length < 200);
  assert.ok(text.endsWith(kept));
  assert.ok(!kept.includes("First"));
  const L = r.breakdown.layers[3];
  assert.equal(L.truncated, true);
  assert.ok(L.tokens <= budget);
  assert.ok(L.omittedTokens > 0);
});

test("total budget trims recent messages, never the scene", () => {
  const text = "Scene body ".repeat(40).trim();
  const msgs = [u("u1"), a("a1"), u("now")];
  const r = assembleContext({ model: "x", bible: bible(), thread: thread(msgs), scene: { title: "T", text }, options: { totalBudget: 10 } });
  assert.equal(r.messages[0].content, SCENE_HEAD + "T\n" + text);
  assert.deepEqual(r.messages.slice(1), [{ role: "user", content: "now" }]);
  assert.equal(r.breakdown.layers[3].truncated, false);
  assert.equal(r.breakdown.layers[5].count, 0);
  assert.equal(r.breakdown.overBudget, true);
});

test("cards named only in the scene are matched", () => {
  const cards = [newCard({ id: "1", name: "Marguerite" }), newCard({ id: "2", name: "Nobody" })];
  const args = { model: "x", bible: bible({ cards }), thread: thread([u("what next?")]) };
  assert.deepEqual(assembleContext(args).breakdown.layers[1].cards, []);
  const r = assembleContext({ ...args, scene: { title: "Dock", text: "Marguerite waits on the dock." } });
  assert.deepEqual(r.breakdown.layers[1].cards.map(c => [c.id, c.reason]), [["1", "name"]]);
  const sys = r.messages[0].content;
  assert.ok(sys.indexOf("### Marguerite") < sys.indexOf(SCENE_HEAD + "Dock"));
});

test("total equals the sum of the seven layers with a scene and story so far", () => {
  const r = assembleContext({ model: "anthropic/m", ...richArgs(), scene: { title: "Pier", text: "Liz walks. Привет." },
    storySoFar: [{ title: "Dock", chapterTitle: "One", summary: "They met." }] });
  assert.equal(r.breakdown.layers.length, 7);
  assert.equal(r.breakdown.total, sumLayers(r.breakdown));
  assert.ok(r.breakdown.layers.every(l => l.tokens > 0));
  assert.equal(CONTEXT_DEFAULTS.sceneBudget, 8000);
});

// ---- Story-so-far layer ----

const STORY_HEAD = "## Story so far\n";
const sf = (title, chapterTitle, summary, stale) => ({ title, chapterTitle, summary, stale });

test("no storySoFar: messages identical to before (anthropic and string)", () => {
  const scene = { title: "Pier", text: "Waves." };
  for (const model of ["anthropic/m", "openai/m"]) {
    for (const extra of [{}, { scene }]) {
      const base = assembleContext({ model, ...richArgs(), ...extra });
      for (const storySoFar of [undefined, null, [], [sf("A", "One", "   ")]]) {
        const r = assembleContext({ model, ...richArgs(), ...extra, storySoFar });
        assert.equal(JSON.stringify(r.messages), JSON.stringify(base.messages));
        assert.equal(r.breakdown.cacheBreakpoints, base.breakdown.cacheBreakpoints);
        assert.deepEqual(r.breakdown.layers[2], { key: "story", label: "Story so far", tokens: 0, count: 0, dropped: 0, stale: 0 });
      }
    }
  }
  assert.equal(CONTEXT_DEFAULTS.storyBudget, 6000);
});

test("story so far sits after cards and before the scene; headings, chapter-less entry, stale suffix", () => {
  const storySoFar = [sf("Arrival", "One", "Liz arrives."), sf("", "", "Night passes.", true), sf("Dock", "", "They meet."), sf("Gone", "Two", "")];
  const r = assembleContext({ model: "x", ...richArgs(), scene: { title: "Pier", text: "Waves." }, storySoFar });
  const sys = r.messages[0].content;
  const expected = STORY_HEAD + "### One · Arrival\nLiz arrives.\n\n### Untitled (summary may be out of date)\nNight passes.\n\n### Dock\nThey meet.";
  const iCards = sys.indexOf("## Story bible"), iSF = sys.indexOf(expected), iScene = sys.indexOf(SCENE_HEAD + "Pier"), iSum = sys.indexOf("## Earlier in this conversation");
  assert.ok(iCards > 0 && iCards < iSF && iSF < iScene && iScene < iSum, sys);
  assert.ok(sys.includes(expected + "\n\n" + SCENE_HEAD));
  assert.ok(!sys.includes("Gone"));
  const L = r.breakdown.layers[2];
  assert.deepEqual(L, { key: "story", label: "Story so far", tokens: estimateTokens(expected), count: 3, dropped: 0, stale: 1 });
});

test("story budget drops earliest entries first with the marker and keeps the last entry", () => {
  const storySoFar = Array.from({ length: 6 }, (_, i) => sf("S" + i, "", "Summary " + i + " " + "z".repeat(80), i === 5));
  const entry = (i) => "### S" + i + (i === 5 ? " (summary may be out of date)" : "") + "\nSummary " + i + " " + "z".repeat(80);
  const budget = estimateTokens(STORY_HEAD + STORY_OMITTED_MARKER + [3, 4, 5].map(entry).join("\n\n"));
  const r = assembleContext({ model: "x", bible: bible(), thread: thread([u("go")]), storySoFar, options: { storyBudget: budget } });
  const text = STORY_HEAD + STORY_OMITTED_MARKER + [3, 4, 5].map(entry).join("\n\n");
  assert.equal(r.messages[0].content, text);
  assert.deepEqual(r.breakdown.layers[2], { key: "story", label: "Story so far", tokens: estimateTokens(text), count: 3, dropped: 3, stale: 1 });
  // A tiny budget still keeps the whole last summary.
  const t = assembleContext({ model: "x", bible: bible(), thread: thread([u("go")]), storySoFar, options: { storyBudget: 1 } });
  assert.equal(t.messages[0].content, STORY_HEAD + STORY_OMITTED_MARKER + entry(5));
  assert.equal(t.breakdown.layers[2].count, 1);
  assert.equal(t.breakdown.layers[2].dropped, 5);
  assert.ok(t.breakdown.layers[2].tokens > 1);
  // Within budget: no marker.
  const w = assembleContext({ model: "x", bible: bible(), thread: thread([u("go")]), storySoFar });
  assert.ok(!w.messages[0].content.includes(STORY_OMITTED_MARKER));
  assert.equal(w.breakdown.layers[2].dropped, 0);
});

test("anthropic with five layers: four parts, A and B share the first", () => {
  const r = assembleContext({ model: "anthropic/m", ...richArgs(), scene: { title: "Pier", text: "Waves." }, storySoFar: [sf("Dock", "One", "They met.")] });
  const parts = r.messages[0].content;
  assert.equal(parts.length, 4);
  assert.equal(parts[0].text, "## Style guide\nS\n\n## Brief\nB\n\n## Story bible\n### Pin (note)\n\n### Liz (note)\nRed coat.");
  assert.equal(parts[1].text, STORY_HEAD + "### One · Dock\nThey met.");
  assert.equal(parts[2].text, SCENE_HEAD + "Pier\nWaves.");
  assert.ok(parts[3].text.startsWith("## Earlier in this conversation"));
  for (const p of parts) assert.deepEqual(p.cache_control, { type: "ephemeral" });
  assert.equal(r.breakdown.cacheBreakpoints, 4);
  const op = assembleContext({ model: "openai/m", ...richArgs(), scene: { title: "Pier", text: "Waves." }, storySoFar: [sf("Dock", "One", "They met.")] });
  assert.equal(op.messages[0].content, parts.map(p => p.text).join("\n\n"));
});

test("anthropic with four layers including the story: one part per layer", () => {
  const r = assembleContext({ model: "anthropic/m", ...richArgs(), storySoFar: [sf("Dock", "One", "They met.")] });
  const parts = r.messages[0].content;
  assert.equal(parts.length, 4);
  assert.equal(parts[0].text, "## Style guide\nS\n\n## Brief\nB");
  assert.ok(parts[1].text.startsWith("## Story bible"));
  assert.equal(parts[2].text, STORY_HEAD + "### One · Dock\nThey met.");
  assert.ok(parts[3].text.startsWith("## Earlier in this conversation"));
  assert.equal(r.breakdown.cacheBreakpoints, 4);
});

test("story-so-far content does not pull cards in", () => {
  const cards = [newCard({ id: "1", name: "Marguerite" })];
  const r = assembleContext({ model: "x", bible: bible({ cards }), thread: thread([u("what next?")]), storySoFar: [sf("Dock", "", "Marguerite waits.")] });
  assert.deepEqual(r.breakdown.layers[1].cards, []);
  assert.equal(r.breakdown.layers.length, 7);
  assert.equal(r.breakdown.total, sumLayers(r.breakdown));
});

// ---- Selection inside the current scene ----

const SEL_PARAS = ["Alpha one starts here.", "Bravo two goes on.", "Charlie three, the middle part.", "Delta four.", "Echo five ends."];
const SEL_TEXT = SEL_PARAS.join("\n\n");
const sysOf = (r) => r.messages[0].content;
const sceneLayerOf = (r) => r.breakdown.layers.find(l => l.key === "scene");

test("selection: without one the scene layer is unchanged and has no note", () => {
  const base = assembleContext({ model: "x", ...richArgs(), scene: { title: "T", text: SEL_TEXT } });
  for (const selection of [undefined, null, {}, { start: 3, end: 3 }, { start: 5, end: 2 }, { start: -1, end: 4 },
    { start: 0, end: SEL_TEXT.length + 1 }, { start: 1.5, end: 4 }, { start: "1", end: "4" }]) {
    const r = assembleContext({ model: "x", ...richArgs(), scene: { title: "T", text: SEL_TEXT, selection } });
    assert.deepEqual(r.messages, base.messages, JSON.stringify(selection));
    assert.ok(!sysOf(r).includes(SELECTION_NOTE) && !sysOf(r).includes(SELECTION_START));
    assert.equal(sceneLayerOf(r).selection, false);
  }
  assert.ok(sysOf(base).includes(SCENE_HEAD + "T\n" + SEL_TEXT));
});

test("selection: markers at exact offsets for whole paragraphs and a mid-sentence span", () => {
  const start = SEL_TEXT.indexOf("Bravo"), end = SEL_TEXT.indexOf("part.") + "part.".length;
  const r = assembleContext({ model: "x", bible: bible(), thread: thread([u("go")]), scene: { title: "T", text: SEL_TEXT, selection: { start, end } } });
  const expected = SCENE_HEAD + "T\n" + SELECTION_NOTE + "\n" + SEL_TEXT.slice(0, start) + SELECTION_START + SEL_TEXT.slice(start, end) + SELECTION_END + SEL_TEXT.slice(end);
  assert.equal(sysOf(r), expected);
  assert.ok(sysOf(r).includes("\n\n[[SELECTION]]Bravo two goes on.\n\nCharlie three, the middle part.[[/SELECTION]]\n\nDelta"));
  assert.equal(sceneLayerOf(r).selection, true);
  assert.equal(sceneLayerOf(r).truncated, false);
  const s2 = SEL_TEXT.indexOf("three"), e2 = s2 + "three, the".length;
  const m = assembleContext({ model: "x", bible: bible(), thread: thread([u("go")]), scene: { title: "", text: SEL_TEXT, selection: { start: s2, end: e2 } } });
  assert.ok(sysOf(m).includes("Charlie [[SELECTION]]three, the[[/SELECTION]] middle part."), sysOf(m));
  assert.ok(sysOf(m).startsWith(SCENE_HEAD + "Untitled\n" + SELECTION_NOTE + "\nAlpha"));
});

test("selection: offsets stay right when the scene text has leading whitespace", () => {
  const raw = "\n  " + SEL_TEXT + "  \n";
  const s0 = raw.indexOf("Delta"), e0 = s0 + "Delta four.".length;
  const r = assembleContext({ model: "x", bible: bible(), thread: thread([u("go")]), scene: { title: "T", text: raw, selection: { start: s0, end: e0 } } });
  assert.ok(sysOf(r).endsWith("[[SELECTION]]Delta four.[[/SELECTION]]\n\nEcho five ends."), sysOf(r));
  // A selection of only the trimmed whitespace is ignored.
  const w = assembleContext({ model: "x", bible: bible(), thread: thread([u("go")]), scene: { title: "T", text: raw, selection: { start: 0, end: 3 } } });
  assert.equal(sceneLayerOf(w).selection, false);
});

test("selection: card matching scans the plain scene text", () => {
  const cards = [newCard({ id: "c1", name: "Bravo", body: "A card." })];
  const r = assembleContext({ model: "x", bible: bible({ cards }), thread: thread([u("go")]), scene: { title: "T", text: SEL_TEXT, selection: { start: 0, end: 5 } } });
  assert.deepEqual(r.breakdown.layers[1].cards.map(c => c.name), ["Bravo"]);
});

const LONG = Array.from({ length: 12 }, (_, i) => "Para" + i + " " + "w".repeat(60) + ".");
const LONG_TEXT = LONG.join("\n\n");
const longSel = (i, j) => ({ start: LONG_TEXT.indexOf("Para" + i + " "), end: LONG_TEXT.indexOf("Para" + j + " ") + LONG[j].length });
const runLong = (sel, budget) => assembleContext({ model: "x", bible: bible(), thread: thread([u("go")]),
  scene: { title: "L", text: LONG_TEXT, selection: sel }, options: { sceneBudget: budget } });

test("selection: truncation in the middle keeps the selection and flags both ends", () => {
  const budget = 200;
  const r = runLong(longSel(5, 6), budget);
  const sys = sysOf(r), L = sceneLayerOf(r);
  assert.ok(sys.startsWith(SCENE_HEAD + "L\n" + SELECTION_NOTE + "\n" + SCENE_OMITTED_MARKER), sys.slice(0, 400));
  assert.ok(sys.endsWith(SCENE_OMITTED_AFTER_MARKER));
  assert.ok(sys.includes(SELECTION_START + LONG[5] + "\n\n" + LONG[6] + SELECTION_END));
  assert.ok(!sys.includes("Para0 ") && !sys.includes("Para11 "));
  assert.ok(L.truncated && L.selection && L.tokens <= budget && L.omittedTokens > 0, JSON.stringify(L));
  // Neighbours are added nearest first: the kept paragraphs are contiguous around the selection.
  const kept = LONG.map((p, i) => sys.includes(p.slice(0, 7)) ? i : -1).filter(i => i >= 0);
  assert.deepEqual(kept, Array.from({ length: kept.length }, (_, k) => kept[0] + k));
  assert.ok(kept.includes(4) && kept.includes(7), JSON.stringify(kept));
  assert.equal(L.tokens, estimateTokens(sys));
});

test("selection: truncation at the end keeps only the leading marker; at the start only the trailing one", () => {
  const atEnd = sysOf(runLong(longSel(11, 11), 120));
  assert.ok(atEnd.includes(SCENE_OMITTED_MARKER) && !atEnd.includes(SCENE_OMITTED_AFTER_MARKER));
  assert.ok(atEnd.endsWith(SELECTION_START + LONG[11] + SELECTION_END));
  const atStart = sysOf(runLong(longSel(0, 0), 120));
  assert.ok(!atStart.includes(SCENE_OMITTED_MARKER) && atStart.endsWith(SCENE_OMITTED_AFTER_MARKER));
  assert.ok(atStart.startsWith(SCENE_HEAD + "L\n" + SELECTION_NOTE + "\n" + SELECTION_START + LONG[0]));
});

test("selection: an oversize selection is kept whole", () => {
  const r = runLong(longSel(3, 9), 60);
  const sys = sysOf(r), L = sceneLayerOf(r);
  assert.ok(sys.includes(SELECTION_START + LONG.slice(3, 10).join("\n\n") + SELECTION_END));
  assert.ok(sys.includes(SCENE_OMITTED_MARKER) && sys.endsWith(SCENE_OMITTED_AFTER_MARKER));
  assert.ok(!sys.includes("Para2 ") && !sys.includes("Para10 "));
  assert.ok(L.truncated && L.tokens > 60);
  // A partial selection inside one long paragraph keeps that whole paragraph.
  const s0 = LONG_TEXT.indexOf("Para4 ") + 2;
  const p = sysOf(runLong({ start: s0, end: s0 + 10 }, 20));
  assert.ok(p.includes("Pa" + SELECTION_START + LONG[4].slice(2, 12) + SELECTION_END + LONG[4].slice(12)), p);
});

test("selection: anthropic parts stay within 4 cache breakpoints", () => {
  const r = assembleContext({ model: "anthropic/m", ...richArgs(), storySoFar: [{ title: "Before", summary: "Earlier." }],
    scene: { title: "T", text: SEL_TEXT, selection: { start: 0, end: 5 } } });
  const parts = r.messages[0].content;
  assert.ok(Array.isArray(parts) && parts.length === 4);
  for (const p of parts) assert.deepEqual(p.cache_control, { type: "ephemeral" });
  assert.equal(r.breakdown.cacheBreakpoints, 4);
  assert.ok(parts[2].text.startsWith(SCENE_HEAD + "T\n" + SELECTION_NOTE + "\n" + SELECTION_START + "Alpha"));
});

test("selection labels, excerpts, meta and the message note", () => {
  assert.equal(selectionLabel({ paraFrom: 4, paraTo: 6, partial: false }), "paragraphs 4\u20136");
  assert.equal(selectionLabel({ paraFrom: 4, paraTo: 4, partial: false }), "paragraph 4");
  assert.equal(selectionLabel({ paraFrom: 5, paraTo: 5, partial: true }), "part of paragraph 5");
  assert.equal(selectionLabel({ paraFrom: 4, paraTo: 5, partial: true }), "parts of paragraphs 4\u20135");
  assert.equal(selectionLabel(null), "");
  assert.equal(selectionExcerpt("  short\n\ntext here "), "short text here");
  const words = Array.from({ length: 30 }, (_, i) => "w" + i).join(" ");
  assert.equal(selectionExcerpt(words), "w0 w1 w2 w3 w4 w5 w6 w7 \u2026 w22 w23 w24 w25 w26 w27 w28 w29");
  const meta = selectionMeta({ before: "x", selected: "Bravo two.\n\nCharlie.", after: "", paraFrom: 2, paraTo: 3, paraCount: 5, partial: false });
  assert.deepEqual(meta, { label: "paragraphs 2\u20133", paraFrom: 2, paraTo: 3, paraCount: 5, partial: false, excerpt: "Bravo two. Charlie." });
  assert.equal(selectionNote(meta), '[The author had paragraphs 2\u20133 of the current scene selected: "Bravo two. Charlie."]');
  assert.equal(selectionMeta(null), null);
  assert.equal(selectionMeta({ selected: "" }), null);
  assert.equal(selectionNote(null), "");
});
