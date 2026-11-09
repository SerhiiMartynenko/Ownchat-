import test from "node:test";
import assert from "node:assert/strict";
import { CARD_TYPES, emptyBible, normalizeBible, newCard, upsertCard, deleteCard, togglePin,
  parseAliases, cardTerms, matchCards, cardToText } from "./bible.js";
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
