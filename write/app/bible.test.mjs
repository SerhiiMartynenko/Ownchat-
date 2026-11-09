import test from "node:test";
import assert from "node:assert/strict";
import { CARD_TYPES, emptyBible, normalizeBible, newCard, upsertCard, deleteCard, togglePin,
  parseAliases, cardTerms, matchCards, cardToText, proposeFacts, acceptCard, listProposed, cardNames } from "./bible.js";
import { estimateTokens, uid } from "./util.js";

test("util: estimateTokens and uid", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
  assert.equal(estimateTokens("Привет"), 3);
  assert.equal(typeof uid(), "string");
  assert.notEqual(uid(), uid());
});

test("normalizeBible from null migrates the legacy system prompt", () => {
  const b = normalizeBible(null, "  Be terse.  ");
  assert.deepEqual(b, { ...emptyBible(), styleGuide: "Be terse." });
  assert.equal(normalizeBible(undefined).styleGuide, "");
});

test("normalizeBible is tolerant", () => {
  const b = normalizeBible({
    brief: "A brief", cards: [
      { id: "a", name: "Liz", aliases: "Lizzie, liz2", type: "bogus" },
      { id: "b", name: "   " },
      { id: "c" },
      null,
      { id: "d", name: "Town", type: "place", aliases: ["Old Town", "old town", 7], pinned: 1, status: "proposed" }
    ]
  });
  assert.equal(b.styleGuide, "");
  assert.equal(b.brief, "A brief");
  assert.equal(b.id, "default");
  assert.equal(b.cards.length, 2);
  assert.equal(b.cards[0].type, "note");
  assert.deepEqual(b.cards[0].aliases, ["Lizzie", "liz2"]);
  assert.equal(b.cards[0].status, "approved");
  assert.equal(b.cards[0].pinned, false);
  assert.deepEqual(b.cards[1].aliases, ["Old Town", "7"]);
  assert.equal(b.cards[1].pinned, true);
  assert.equal(b.cards[1].status, "proposed");
  assert.ok(CARD_TYPES.includes(b.cards[1].type));
});

test("parseAliases splits, trims, dedupes keeping first spelling", () => {
  assert.deepEqual(parseAliases("Liz, Lizzie\n liz ,,\n\nLIZZIE, Beth"), ["Liz", "Lizzie", "Beth"]);
  assert.deepEqual(parseAliases(""), []);
});

test("newCard defaults", () => {
  const c = newCard({ name: "Liz", type: "character", aliases: "Lizzie" }, () => "id1");
  assert.equal(c.id, "id1");
  assert.equal(c.status, "approved");
  assert.equal(c.pinned, false);
  assert.deepEqual(c.aliases, ["Lizzie"]);
  assert.ok(c.createdAt > 0 && c.updatedAt === c.createdAt);
});

test("upsert, delete and togglePin do not mutate", () => {
  const b0 = emptyBible();
  const c = newCard({ name: "Liz" }, () => "x");
  const b1 = upsertCard(b0, c);
  assert.equal(b0.cards.length, 0);
  assert.equal(b1.cards.length, 1);
  assert.ok(b1.updatedAt > 0);
  const b2 = upsertCard(b1, { ...c, body: "new" });
  assert.equal(b2.cards.length, 1);
  assert.equal(b2.cards[0].body, "new");
  assert.equal(b1.cards[0].body, "");
  const b3 = togglePin(b2, "x");
  assert.equal(b3.cards[0].pinned, true);
  assert.equal(b2.cards[0].pinned, false);
  const b4 = deleteCard(b3, "x");
  assert.equal(b4.cards.length, 0);
  assert.equal(b3.cards.length, 1);
});

test("cardTerms lowercases, drops short terms, dedupes", () => {
  assert.deepEqual(cardTerms({ name: "Liz", aliases: ["LIZ", "L", "Lizzie"] }), ["liz", "lizzie"]);
});

test("matchCards reasons, pos and order", () => {
  const cards = [
    newCard({ id: "1", name: "Zed", pinned: true }),
    newCard({ id: "2", name: "Anna", pinned: true }),
    newCard({ id: "3", name: "Mark", aliases: ["Marky"] }),
    newCard({ id: "4", name: "Elizabeth", aliases: ["Liz"] }),
    newCard({ id: "5", name: "Bob" }),
    newCard({ id: "6", name: "Carl", status: "proposed" })
  ];
  const text = "liz met MARK, then carl. Mark again";
  const r = matchCards(cards, text);
  assert.deepEqual(r.map(x => x.card.id), ["2", "1", "4", "3"]);
  assert.equal(r[0].reason, "pinned");
  assert.equal(r[0].pos, Infinity);
  assert.equal(r[0].term, null);
  assert.equal(r[2].reason, "alias");
  assert.equal(r[2].term, "liz");
  assert.equal(r[2].pos, 0);
  assert.equal(r[3].reason, "name");
  assert.equal(r[3].term, "mark");
  assert.equal(r[3].pos, text.toLowerCase().lastIndexOf("mark"));
});

test("cardToText formats", () => {
  assert.equal(cardToText({ name: "Liz", type: "character", aliases: ["Lizzie", "Beth"], body: "Tall." }),
    "### Liz (character; also: Lizzie, Beth)\nTall.");
  assert.equal(cardToText({ name: "Town", type: "place", aliases: [], body: "" }), "### Town (place)");
});

// ---- Proposals ----

const src = { kind: "scene", sceneId: "s1", sceneTitle: "Pier", at: 5 };
const seq = () => { let i = 0; return () => "p" + (++i); };
const withCards = (cards) => ({ ...emptyBible(), cards, updatedAt: 1 });

test("normalizeCard keeps a plain-object source with a string kind, else null", () => {
  const b = normalizeBible({ cards: [
    { id: "a", name: "A", source: { kind: "chat", threadId: "t1", at: 3 } },
    { id: "b", name: "B", source: { kind: 7 } },
    { id: "c", name: "C", source: "scene" },
    { id: "d", name: "D", source: ["x"] },
    { id: "e", name: "E" }
  ] });
  assert.deepEqual(b.cards[0].source, { kind: "chat", threadId: "t1", at: 3 });
  assert.deepEqual(b.cards.slice(1).map(c => c.source), [null, null, null, null]);
});

test("newCard accepts status and source", () => {
  const d = newCard({ name: "X" }, () => "i");
  assert.equal(d.status, "approved");
  assert.equal(d.source, null);
  const c = newCard({ name: "Y", status: "proposed", source: src }, () => "j");
  assert.equal(c.status, "proposed");
  assert.deepEqual(c.source, src);
  assert.notEqual(c.source, src);
});

test("proposeFacts adds proposed cards with the source, in order, without mutating", () => {
  const b0 = withCards([newCard({ id: "liz", name: "Elizabeth", aliases: ["Liz"] })]);
  const before = JSON.stringify(b0);
  const facts = [{ type: "place", name: " Pier ", body: " Rotten boards. " }, { type: "thread", name: "The key", body: "Lost." }];
  const factsBefore = JSON.stringify(facts);
  const r = proposeFacts(b0, facts, src, seq());
  assert.equal(JSON.stringify(b0), before);
  assert.equal(JSON.stringify(facts), factsBefore);
  assert.deepEqual(r.added.map(c => [c.id, c.type, c.name, c.body, c.status]), [["p1", "place", "Pier", "Rotten boards.", "proposed"], ["p2", "thread", "The key", "Lost.", "proposed"]]);
  assert.deepEqual(r.added[0].source, src);
  assert.deepEqual(r.bible.cards.map(c => c.id), ["liz", "p1", "p2"]);
  assert.ok(r.bible.updatedAt > 1);
});

test("proposeFacts skip rules", () => {
  const b0 = withCards([newCard({ id: "liz", name: "Elizabeth", aliases: ["Liz"] }), newCard({ id: "k", name: "Key", status: "proposed" })]);
  const facts = [
    { type: "character", name: "liz", body: "alias clash" },
    { type: "character", name: " ELIZABETH ", body: "name clash" },
    { type: "thread", name: "key", body: "proposed clash" },
    { type: "place", name: "", body: "empty" },
    { type: "place", name: "None", body: "none" },
    { type: "place", name: "x".repeat(61), body: "long" },
    { type: "place", name: "Dock", body: "first" },
    { type: "place", name: "dock", body: "dup in batch" },
    null
  ];
  const r = proposeFacts(b0, facts, src, seq());
  assert.deepEqual(r.added.map(c => [c.name, c.body]), [["Dock", "first"]]);
  const none = proposeFacts(b0, [{ type: "place", name: "Liz", body: "x" }], src, seq());
  assert.deepEqual(none.added, []);
  assert.equal(none.bible.updatedAt, 1);
  assert.notEqual(none.bible, b0);
  assert.deepEqual(none.bible, b0);
  assert.deepEqual(proposeFacts(b0, undefined, src).added, []);
});

test("proposeFacts caps at 8 per call", () => {
  const facts = Array.from({ length: 12 }, (_, i) => ({ type: "character", name: "N" + i, body: "b" }));
  const r = proposeFacts(emptyBible(), facts, src, seq());
  assert.equal(r.added.length, 8);
  assert.deepEqual(r.added.map(c => c.name), facts.slice(0, 8).map(f => f.name));
});

test("acceptCard, listProposed and cardNames", () => {
  const p1 = { ...newCard({ id: "p1", name: "Later", status: "proposed" }), createdAt: 20 };
  const p2 = { ...newCard({ id: "p2", name: "Earlier", status: "proposed" }), createdAt: 10, updatedAt: 10 };
  const b0 = withCards([newCard({ id: "a", name: "Liz" }), p1, p2]);
  assert.deepEqual(listProposed(b0).map(c => c.id), ["p2", "p1"]);
  assert.deepEqual(cardNames(b0), ["Liz"]);
  const b1 = acceptCard(b0, "p2");
  assert.equal(b0.cards[2].status, "proposed");
  assert.equal(b1.cards[2].status, "approved");
  assert.ok(b1.cards[2].updatedAt > 10);
  assert.ok(b1.updatedAt > 1);
  assert.deepEqual(cardNames(b1), ["Liz", "Earlier"]);
  assert.deepEqual(listProposed(b1).map(c => c.id), ["p1"]);
  const same = acceptCard(b0, "nope");
  assert.notEqual(same, b0);
  assert.deepEqual(same, b0);
  assert.deepEqual(cardNames(null), []);
  assert.deepEqual(listProposed(null), []);
});
