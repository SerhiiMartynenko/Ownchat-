import test from "node:test";
import assert from "node:assert/strict";
import {
  ACTIONS, ACTION_ORDER, ACTION_THINKING, TONES, REWRITE_DEFAULTS, RULES_SENTINEL,
  buildActionRequest, cleanProse, looksLikeChat
} from "./rewrite.js";
import { newCard } from "./bible.js";

const blk = (...texts) => texts.map((t, i) => ({ id: "b" + i, text: t }));
const bible = (o) => ({ brief: "", styleGuide: "", cards: [], ...o });
const req = (o) => buildActionRequest({ action: "rewrite", target: { text: "Liz opened the door." }, model: "other/x", ...o });
const userOf = (r) => r.messages.find(m => m.role === "user").content;
const sysOf = (r) => r.messages.find(m => m.role === "system").content;
const sysText = (r) => { const c = sysOf(r); return Array.isArray(c) ? c.map(p => p.text).join("\n\n") : c; };

test("action table", () => {
  assert.deepEqual(ACTION_ORDER, ["rewrite", "tighten", "expand", "tone", "custom", "continue"]);
  ACTION_ORDER.forEach(k => {
    assert.equal(ACTIONS[k].key, k);
    assert.ok(ACTIONS[k].label);
    assert.equal(ACTIONS[k].acceptLabel, k === "continue" ? "Insert" : "Accept");
  });
  assert.deepEqual(TONES, ["Darker", "Lighter", "More tense", "More intimate", "More lyrical", "Plainer"]);
  assert.deepEqual(REWRITE_DEFAULTS, { cardBudget: 4000, windowBudget: 3000 });
  assert.equal(RULES_SENTINEL, "Return ONLY the replacement prose");
});

test("per-action instruction text", () => {
  const instr = (o) => userOf(req(o)).split("## Instruction\n")[1];
  assert.match(instr({ action: "rewrite" }), /meaning, events and facts.*flow, rhythm and word choice.*same length/s);
  assert.match(instr({ action: "tighten" }), /roughly a quarter.*redundancy.*plot-relevant/s);
  assert.match(instr({ action: "expand" }), /sensory detail, interiority or beats.*one and a half to two times.*no new plot facts/s);
  assert.equal(instr({ action: "tone", tone: "More tense" }), "Shift the tone of the target: More tense.");
  assert.equal(instr({ action: "custom", instruction: "  Make it rain.  " }), "Make it rain.");
  assert.match(instr({ action: "continue", target: null }), /two to four paragraphs, about 150 to 300 words.*lead into it.*Never repeat/s);
  assert.equal(instr({ action: "rewrite", instruction: "Shorter sentences." }),
    ACTIONS.rewrite.instruction + "\nAdditional instruction: Shorter sentences.");
  assert.match(instr({ action: "tone", tone: "Darker", instruction: "Keep the joke." }), /Darker\.\nAdditional instruction: Keep the joke\.$/);
});

test("user message layout and system rules", () => {
  const r = req({ sceneTitle: "Night", before: blk("B1", "B2"), after: blk("A1") });
  assert.equal(r.messages.length, 2);
  assert.deepEqual(r.messages.map(m => m.role), ["system", "user"]);
  assert.equal(userOf(r), "## Scene: Night\n\n## Text before\nB1\n\nB2\n\n## Target\nLiz opened the door.\n\n## Text after\nA1\n\n## Instruction\n" + ACTIONS.rewrite.instruction);
  const sys = sysOf(r);
  assert.equal(typeof sys, "string");
  assert.ok(sys.includes(RULES_SENTINEL));
  assert.match(sys, /No preamble, no commentary, no quotation marks around the text, no Markdown fences\. Keep paragraph breaks as blank lines\./);
  const bare = req({});
  assert.equal(userOf(bare), "## Target\nLiz opened the door.\n\n## Instruction\n" + ACTIONS.rewrite.instruction);
  const cont = buildActionRequest({ action: "continue", before: blk("Last para."), model: "other/x" });
  assert.ok(!userOf(cont).includes("## Target"));
  assert.ok(userOf(cont).startsWith("## Text before\nLast para."));
});

test("style guide and brief follow the rules", () => {
  const r = req({ bible: bible({ styleGuide: "Short.", brief: "A heist." }) });
  const sys = sysOf(r);
  assert.ok(sys.startsWith("You are editing a scene of a novel for its author."));
  assert.ok(sys.endsWith("\n\n## Style guide\nShort.\n\n## Brief\nA heist."));
  assert.ok(!sysOf(req({ bible: bible({ brief: "Only brief" }) })).includes("## Style guide"));
});

test("cards matched from target and window; pinned always included", () => {
  const cards = [
    newCard({ id: "c1", name: "Liz", type: "character", body: "Thief." }),
    newCard({ id: "c2", name: "Marta", type: "character", body: "Cop." }),
    newCard({ id: "c3", name: "Harbour", type: "place", body: "Wet." }),
    newCard({ id: "c4", name: "Rule", type: "note", body: "Always rain.", pinned: true }),
    newCard({ id: "c5", name: "Unused", type: "note", body: "Never." })
  ];
  const r = req({ bible: bible({ cards }), before: blk("Marta waited."), after: blk("The harbour was quiet.") });
  const layer = r.breakdown.layers.find(l => l.key === "cards");
  assert.deepEqual(layer.cards.map(c => c.id), ["c4", "c3", "c1", "c2"]);
  const sys = sysOf(r);
  assert.ok(sys.includes("\n\n## Story bible\n### Rule (note)\nAlways rain."));
  assert.ok(!sys.includes("Unused"));
  // No cards: no bible section.
  assert.ok(!sysOf(req({ bible: bible({ cards: [cards[4]] }) })).includes("## Story bible"));
});

test("card budget drops unpinned cards matched earliest first, never pinned", () => {
  const big = "x".repeat(400); // ~100 tokens each
  const cards = [
    newCard({ id: "p", name: "Pinned", body: big, pinned: true }),
    newCard({ id: "a", name: "Alpha", body: big }),
    newCard({ id: "b", name: "Bravo", body: big })
  ];
  const r = req({ bible: bible({ cards }), target: { text: "Alpha met Bravo." }, options: { cardBudget: 230 } });
  const layer = r.breakdown.layers.find(l => l.key === "cards");
  assert.deepEqual(layer.cards.map(c => c.id), ["p", "b"]);
  assert.deepEqual(layer.dropped.map(c => c.id), ["a"]);
  const tiny = req({ bible: bible({ cards }), target: { text: "Alpha" }, options: { cardBudget: 10 } });
  const l2 = tiny.breakdown.layers.find(l => l.key === "cards");
  assert.deepEqual(l2.cards.map(c => c.id), ["p"]);
  assert.equal(l2.overBudget, true);
});

test("Anthropic: system is an array of at most 2 cached parts; other models get a string", () => {
  const cards = [newCard({ id: "c1", name: "Liz", body: "Thief." })];
  const a = req({ model: "anthropic/x", bible: bible({ cards, styleGuide: "S", brief: "B" }) });
  const parts = sysOf(a);
  assert.ok(Array.isArray(parts));
  assert.equal(parts.length, 2);
  parts.forEach(p => { assert.equal(p.type, "text"); assert.deepEqual(p.cache_control, { type: "ephemeral" }); });
  assert.ok(parts[0].text.includes(RULES_SENTINEL) && parts[0].text.includes("## Brief\nB"));
  assert.ok(parts[1].text.startsWith("## Story bible\n"));
  assert.equal(a.breakdown.cacheBreakpoints, 2);
  const one = req({ model: "anthropic/x" });
  assert.equal(sysOf(one).length, 1);
  const o = req({ model: "other/x", bible: bible({ cards }) });
  assert.equal(typeof sysOf(o), "string");
  assert.equal(sysOf(o), parts[0].text.split("\n\n## Style guide")[0] + "\n\n" + "## Story bible\n### Liz (note)\nThief.");
  assert.equal(o.breakdown.cacheBreakpoints, 0);
});

test("target is never trimmed, even when huge", () => {
  const huge = "Word ".repeat(20000).trim();
  const r = req({ target: { text: huge }, before: blk("before"), options: { windowBudget: 10 } });
  assert.ok(userOf(r).includes("## Target\n" + huge + "\n\n"));
  const t = r.breakdown.layers.find(l => l.key === "target");
  assert.ok(t.tokens > 20000);
});

test("window trimmed from the far ends to windowBudget", () => {
  const p = (tag) => tag + " " + "y".repeat(396); // ~100 tokens
  const before = blk(p("B1"), p("B2"), p("B3"));
  const after = blk(p("A1"), p("A2"));
  const r = req({ before, after, options: { windowBudget: 320 } });
  const u = userOf(r);
  // 5 blocks ~ 500 tokens: drop B1 (farthest), then A2 / B2 by distance.
  assert.ok(!u.includes("B1 ") && u.includes("B3 ") && u.includes("A1 "));
  assert.equal(r.breakdown.truncated, true);
  const lb = r.breakdown.layers.find(l => l.key === "before"), la = r.breakdown.layers.find(l => l.key === "after");
  assert.equal(lb.droppedBlocks + la.droppedBlocks, 2);
  assert.equal(lb.blocks + la.blocks, 3);
  assert.equal(req({ before, after }).breakdown.truncated, false);
  // Nearest blocks survive: B3 and A1.
  const r2 = req({ before, after, options: { windowBudget: 210 } });
  assert.match(userOf(r2), /## Text before\nB3 y+\n\n## Target/);
  assert.match(userOf(r2), /## Text after\nA1 y+\n\n## Instruction/);
  assert.equal(r.breakdown.total, r.breakdown.layers.reduce((s, l) => s + l.tokens, 0));
});

test("errors", () => {
  assert.throws(() => buildActionRequest({ action: "nope", target: { text: "x" } }), /Unknown action/);
  assert.throws(() => buildActionRequest(null), /Unknown action/);
  assert.throws(() => buildActionRequest({ action: "rewrite", target: { text: "  " } }), /Select some text/);
  assert.throws(() => buildActionRequest({ action: "tighten" }), /Select some text/);
  assert.throws(() => buildActionRequest({ action: "custom", target: { text: "x" } }), /instruction/);
  assert.throws(() => buildActionRequest({ action: "tone", target: { text: "x" } }), /tone/);
  assert.doesNotThrow(() => buildActionRequest({ action: "continue" }));
  assert.doesNotThrow(() => buildActionRequest({ action: "rewrite", target: { text: "x" }, bible: null }));
});

test("cleanProse: fence, preamble, quotes, chatter, newlines", () => {
  assert.deepEqual(cleanProse("```\nThe rain fell.\n```"), { text: "The rain fell.", flags: ["fence"] });
  assert.deepEqual(cleanProse("```markdown\nThe rain fell.\n\nShe ran.\n```"), { text: "The rain fell.\n\nShe ran.", flags: ["fence"] });
  assert.deepEqual(cleanProse("Here is the rewritten passage:\n\nThe rain fell."), { text: "The rain fell.", flags: ["preamble"] });
  assert.deepEqual(cleanProse("Sure, here's a tighter version:\n```\nThe rain fell.\n```"), { text: "The rain fell.", flags: ["preamble", "fence"] });
  assert.deepEqual(cleanProse("Rewritten version:\nThe rain fell."), { text: "The rain fell.", flags: ["preamble"] });
  assert.deepEqual(cleanProse("“The rain fell, and she ran.”"), { text: "The rain fell, and she ran.", flags: ["quotes"] });
  assert.deepEqual(cleanProse("\"The rain fell.\""), { text: "The rain fell.", flags: ["quotes"] });
  assert.deepEqual(cleanProse("The rain fell.\n\nLet me know if you want changes.\nI hope this helps!"), { text: "The rain fell.", flags: ["chatter"] });
  assert.deepEqual(cleanProse("The rain fell.\n\n---\n\nWould you like a darker version?"), { text: "The rain fell.", flags: ["chatter"] });
  assert.deepEqual(cleanProse("A.\r\n\r\n\r\n\r\nB."), { text: "A.\n\nB.", flags: ["blank-lines"] });
});

test("cleanProse leaves real prose alone", () => {
  const prose = [
    "“Go,” she said. “Now.”",
    "\"Go,\" she said. \"Now.\"",
    "She said only this:\nRun.",
    "Here is the thing about Marta: she never lied.",
    "The list read:\nbread, salt, rope.",
    "Він сказав: “Ні.”"
  ];
  prose.forEach(t => assert.deepEqual(cleanProse(t), { text: t, flags: [] }, t));
  assert.deepEqual(cleanProse(null), { text: "", flags: [] });
});

test("looksLikeChat", () => {
  assert.equal(looksLikeChat(""), true);
  assert.equal(looksLikeChat("```\n\n```"), true);
  assert.equal(looksLikeChat("Sure! I made it darker."), true);
  assert.equal(looksLikeChat("Certainly. The rain fell."), true);
  assert.equal(looksLikeChat("I'm sorry, but I can't help with that."), true);
  assert.equal(looksLikeChat("The rain fell. As an AI, I cannot judge."), true);
  assert.equal(looksLikeChat("The rain fell.\n\nDo you want me to make it shorter?"), true);
  const target = "The rain fell over the harbour for the third night running. ".repeat(5);
  assert.equal(looksLikeChat("Done.", target), true);
  assert.equal(looksLikeChat("The rain fell over the harbour for the third night in a row.", target), false);
  // Genuine prose.
  assert.equal(looksLikeChat("The rain fell. Marta waited by the door."), false);
  assert.equal(looksLikeChat("Surely the rain would stop. It did not."), false);
  assert.equal(looksLikeChat("“Are you coming?” she asked."), false);
  assert.equal(looksLikeChat("Where had the rain gone?"), false);
  assert.equal(looksLikeChat("Here is the rewritten text:\n\nThe rain fell."), false); // preamble stripped first
  // Known false positive, accepted: first-person prose starting with "I " is flagged (the preview only warns).
  assert.equal(looksLikeChat("I walked to the door and listened."), true);
});

test("editing actions run without extended thinking", () => {
  assert.equal(ACTION_THINKING, "off");
});
