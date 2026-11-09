import test from "node:test";
import assert from "node:assert/strict";
import { textToBlocks, blocksToText, countWords, splitParagraphs } from "./scene.js";

function counter(prefix = "n"){ let i = 0; return () => prefix + (++i); }
const ids = (blocks) => blocks.map((b) => b.id);
const texts = (blocks) => blocks.map((b) => b.text);

test("textToBlocks splits on newlines, trims, drops whitespace-only lines", () => {
  const b = textToBlocks("  One.  \n\n\nTwo.\n   \nThree.\n", [], counter());
  assert.deepEqual(texts(b), ["One.", "Two.", "Three."]);
  assert.deepEqual(ids(b), ["n1", "n2", "n3"]);
  assert.deepEqual(textToBlocks("", [], counter()), []);
  assert.deepEqual(textToBlocks(null, [], counter()), []);
  assert.deepEqual(textToBlocks(" \n\t\n ", [], counter()), []);
});

test("textToBlocks normalises CRLF and CR", () => {
  assert.deepEqual(splitParagraphs("A\r\n\r\nB\rC"), ["A", "B", "C"]);
});

test("textToBlocks reuses ids for unchanged prefix and suffix and a changed middle", () => {
  const prev = textToBlocks("A\nB\nC\nD", [], counter("p"));
  const edited = textToBlocks("A\nB changed\nC\nD", prev, counter());
  assert.deepEqual(ids(edited), ["p1", "p2", "p3", "p4"]);
  assert.deepEqual(texts(edited), ["A", "B changed", "C", "D"]);
  const unchanged = textToBlocks("A\n\nB\n\nC\n\nD", prev, counter());
  assert.deepEqual(unchanged, prev);
});

test("textToBlocks insert and delete keep neighbour ids", () => {
  const prev = textToBlocks("A\nB\nC", [], counter("p"));
  const ins = textToBlocks("A\nX\nB\nC", prev, counter());
  assert.deepEqual(ids(ins), ["p1", "n1", "p2", "p3"]);
  const del = textToBlocks("A\nC", prev, counter());
  assert.deepEqual(ids(del), ["p1", "p3"]);
  const front = textToBlocks("Z\nA\nB\nC", prev, counter());
  assert.deepEqual(ids(front), ["n1", "p1", "p2", "p3"]);
  const growMiddle = textToBlocks("A\nX\nY\nC", prev, counter());
  assert.deepEqual(ids(growMiddle), ["p1", "p2", "n1", "p3"]);
});

test("textToBlocks never duplicates ids", () => {
  const prev = [{ id: "a", text: "A" }, { id: "a", text: "B" }, { id: "c", text: "A" }];
  const out = textToBlocks("A\nB\nA\nA", prev, counter());
  assert.equal(new Set(ids(out)).size, out.length);
  const clash = textToBlocks("A\nQ", [{ id: "x", text: "A" }], () => "x");
  assert.equal(new Set(ids(clash)).size, 2);
  const repeated = textToBlocks("A\nA\nA", [{ id: "x", text: "A" }], counter());
  assert.equal(new Set(ids(repeated)).size, 3);
});

test("blocksToText joins with blank lines and round-trips", () => {
  const b = textToBlocks("One\nTwo", [], counter());
  assert.equal(blocksToText(b), "One\n\nTwo");
  assert.equal(blocksToText([]), "");
  assert.equal(blocksToText(null), "");
  assert.deepEqual(textToBlocks(blocksToText(b), b, counter()), b);
});

test("countWords", () => {
  assert.equal(countWords("The quick brown fox — jumps, over 2 dogs."), 8);
  assert.equal(countWords("Привет, как дела? Всё хорошо."), 5);
  assert.equal(countWords("... — !! ?"), 0);
  assert.equal(countWords(""), 0);
  assert.equal(countWords(null), 0);
  assert.equal(countWords("  one\n\ntwo\tthree  "), 3);
});
