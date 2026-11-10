import test from "node:test";
import assert from "node:assert/strict";
import {
  commitEdit, rangeFromIndex, toggleInRange, normalizeRange, applyReplacement, insertAfter,
  spliceSelection, windowAround, insertionWindow, selectionWindow
} from "./editor.js";

const mkUid = (prefix = "n") => { let i = 0; return () => prefix + (++i); };
const B = (...texts) => texts.map((t, i) => ({ id: "b" + (i + 1), text: t }));
const ids = (bs) => bs.map(b => b.id);
const texts = (bs) => bs.map(b => b.text);
const unique = (bs) => assert.equal(new Set(ids(bs)).size, bs.length, "ids unique");

test("commitEdit: update, split, delete, unknown id, no mutation", () => {
  const blocks = B("one", "two", "three");
  const frozen = JSON.stringify(blocks);
  const up = commitEdit(blocks, "b2", "  TWO  ", mkUid());
  assert.deepEqual(up, [{ id: "b1", text: "one" }, { id: "b2", text: "TWO" }, { id: "b3", text: "three" }]);
  const split = commitEdit(blocks, "b2", "two a\n\ntwo b\n\n\ntwo c", mkUid());
  assert.deepEqual(ids(split), ["b1", "b2", "n1", "n2", "b3"]);
  assert.deepEqual(texts(split), ["one", "two a", "two b", "two c", "three"]);
  const del = commitEdit(blocks, "b2", "  \n\n ", mkUid());
  assert.deepEqual(ids(del), ["b1", "b3"]);
  const same = commitEdit(blocks, "zz", "x", mkUid());
  assert.deepEqual(same, blocks);
  assert.notEqual(same, blocks);
  assert.equal(JSON.stringify(blocks), frozen);
  assert.deepEqual(commitEdit(null, "b1", "x", mkUid()), []);
});

test("commitEdit: fresh ids never collide with existing ones", () => {
  const blocks = [{ id: "n1", text: "a" }, { id: "n2", text: "b" }];
  const out = commitEdit(blocks, "n1", "a\n\nc\n\nd", mkUid());
  unique(out);
  assert.deepEqual(texts(out), ["a", "c", "d", "b"]);
  assert.equal(out[0].id, "n1");
  // A uid function that keeps returning the same value still yields unique ids.
  const stuck = commitEdit(blocks, "n1", "a\n\nc\n\nd", () => "n2");
  unique(stuck);
});

test("rangeFromIndex and toggleInRange", () => {
  assert.deepEqual(rangeFromIndex(3), { start: 3, end: 3 });
  assert.equal(rangeFromIndex(-1), null);
  assert.deepEqual(toggleInRange(null, 2), { start: 2, end: 2 });
  assert.equal(toggleInRange({ start: 2, end: 2 }, 2), null);
  assert.deepEqual(toggleInRange({ start: 2, end: 2 }, 5), { start: 2, end: 5 });
  assert.deepEqual(toggleInRange({ start: 2, end: 4 }, 0), { start: 0, end: 4 });
  assert.deepEqual(toggleInRange({ start: 2, end: 5 }, 2), { start: 3, end: 5 });
  assert.deepEqual(toggleInRange({ start: 2, end: 5 }, 5), { start: 2, end: 4 });
  assert.deepEqual(toggleInRange({ start: 0, end: 9 }, 2), { start: 3, end: 9 }); // nearer the start
  assert.deepEqual(toggleInRange({ start: 0, end: 9 }, 7), { start: 0, end: 6 }); // nearer the end
  assert.deepEqual(toggleInRange({ start: 0, end: 4 }, 2), { start: 0, end: 1 }); // equal: shrink the end
  assert.deepEqual(toggleInRange({ start: 1, end: 3 }, "x"), { start: 1, end: 3 });
});

test("normalizeRange clamps and swaps", () => {
  assert.equal(normalizeRange(null, 5), null);
  assert.equal(normalizeRange({ start: 0, end: 0 }, 0), null);
  assert.deepEqual(normalizeRange({ start: 3, end: 1 }, 5), { start: 1, end: 3 });
  assert.deepEqual(normalizeRange({ start: -2, end: 9 }, 5), { start: 0, end: 4 });
  assert.equal(normalizeRange({ start: 7, end: 9 }, 5), null);
  assert.equal(normalizeRange({ start: "a", end: 1 }, 5), null);
});

test("applyReplacement keeps ids of unchanged paragraphs", () => {
  const blocks = B("p1", "p2", "p3", "p4", "p5");
  const out = applyReplacement(blocks, { start: 1, end: 3 }, "p2\n\nNEW\n\np4", mkUid());
  assert.deepEqual(ids(out), ["b1", "b2", "b3", "b4", "b5"]);
  assert.deepEqual(texts(out), ["p1", "p2", "NEW", "p4", "p5"]);
  const grown = applyReplacement(blocks, { start: 2, end: 2 }, "x\n\ny\n\nz", mkUid());
  assert.deepEqual(texts(grown), ["p1", "p2", "x", "y", "z", "p4", "p5"]);
  assert.equal(grown[2].id, "b3");
  unique(grown);
  const removed = applyReplacement(blocks, { start: 1, end: 2 }, "   ", mkUid());
  assert.deepEqual(ids(removed), ["b1", "b4", "b5"]);
  assert.deepEqual(applyReplacement(blocks, null, "x", mkUid()), blocks);
  assert.equal(blocks.length, 5);
});

test("applyReplacement allocates fresh ids when a reused id collides outside the range", () => {
  const blocks = [{ id: "a", text: "x" }, { id: "dup", text: "y" }, { id: "dup", text: "z" }];
  const out = applyReplacement(blocks, { start: 2, end: 2 }, "z2", mkUid());
  unique(out);
  assert.deepEqual(texts(out), ["x", "y", "z2"]);
  // uid() returning ids that already exist outside the range.
  const b2 = B("p1", "p2", "p3");
  const out2 = applyReplacement(b2, { start: 1, end: 1 }, "q\n\nr\n\ns", mkUid("b"));
  unique(out2);
  assert.deepEqual(texts(out2), ["p1", "q", "r", "s", "p3"]);
});

test("insertAfter", () => {
  const blocks = B("a", "b");
  assert.deepEqual(texts(insertAfter(blocks, -1, "x\n\ny", mkUid())), ["x", "y", "a", "b"]);
  assert.deepEqual(texts(insertAfter(blocks, null, "x", mkUid())), ["x", "a", "b"]);
  assert.deepEqual(texts(insertAfter(blocks, 0, "x", mkUid())), ["a", "x", "b"]);
  assert.deepEqual(texts(insertAfter(blocks, 1, "x", mkUid())), ["a", "b", "x"]);
  assert.deepEqual(texts(insertAfter(blocks, 99, "x", mkUid())), ["a", "b", "x"]);
  assert.deepEqual(insertAfter(blocks, 0, " \n ", mkUid()), blocks);
  unique(insertAfter(blocks, 0, "x\n\ny", () => "b1"));
  assert.deepEqual(texts(insertAfter([], -1, "x", mkUid())), ["x"]);
});

test("spliceSelection", () => {
  assert.equal(spliceSelection("Hello cruel world", 6, 11, "kind"), "Hello kind world");
  assert.equal(spliceSelection("abc", -5, 1, "X"), "Xbc");
  assert.equal(spliceSelection("abc", 2, 99, "X"), "abX");
  assert.equal(spliceSelection("abc", 2, 1, " X "), "a X c");
  assert.equal(spliceSelection("abc", 1, 1, "Z"), "aZbc");
  assert.equal(spliceSelection(null, 0, 0, "x"), "x");
});

test("windowAround and insertionWindow", () => {
  const blocks = B("1", "2", "3", "4", "5", "6", "7");
  const w = windowAround(blocks, { start: 3, end: 4 }, 2);
  assert.deepEqual(texts(w.before), ["2", "3"]);
  assert.deepEqual(texts(w.after), ["6", "7"]);
  const edge = windowAround(blocks, { start: 0, end: 6 });
  assert.deepEqual(edge, { before: [], after: [] });
  const def = windowAround(blocks, { start: 1, end: 1 });
  assert.deepEqual(texts(def.before), ["1"]);
  assert.deepEqual(texts(def.after), ["3", "4"]);
  const end = windowAround(blocks, null, 3);
  assert.deepEqual(texts(end.before), ["5", "6", "7"]);
  assert.deepEqual(end.after, []);
  assert.deepEqual(windowAround([], null), { before: [], after: [] });

  const iw = insertionWindow(blocks, 2, 2);
  assert.deepEqual(texts(iw.before), ["2", "3"]);
  assert.deepEqual(texts(iw.after), ["4", "5"]);
  const start = insertionWindow(blocks, -1, 2);
  assert.deepEqual(start.before, []);
  assert.deepEqual(texts(start.after), ["1", "2"]);
  const last = insertionWindow(blocks, 6, 2);
  assert.deepEqual(texts(last.before), ["6", "7"]);
  assert.deepEqual(last.after, []);
});

// selectionWindow: the Write-mode selection target and its paragraph window.
const RAW = "Para one.\n\nPara two is here.\n\n\n  Para three.  \n\nPara four.\n\nPara five.";
const at = (sub) => RAW.indexOf(sub);
const tx = (xs) => xs.map(x => x.text);

test("selectionWindow: middle of a paragraph", () => {
  const s = at("two"), e = s + "two is".length;
  const w = selectionWindow(RAW, s, e, 2);
  assert.equal(w.text, "two is");
  assert.deepEqual([w.start, w.end], [s, e]);
  assert.deepEqual(tx(w.before), ["Para one.", "Para "]);
  assert.deepEqual(tx(w.after), [" here.", "Para three.", "Para four."]);
  assert.equal(w.paraIndex, 1);
});

test("selectionWindow: spans two paragraphs, blank-line runs and padding handled", () => {
  const s = at("is here"), e = at("three") + "three".length;
  const w = selectionWindow(RAW, s, e, 2);
  assert.equal(w.text, "is here.\n\n\n  Para three");
  assert.deepEqual(tx(w.before), ["Para one.", "Para two "]);
  assert.deepEqual(tx(w.after), [".", "Para four.", "Para five."]);
  assert.equal(w.paraIndex, 2);
});

test("selectionWindow: at the start and at the end of the text", () => {
  const w0 = selectionWindow(RAW, 0, 4, 2);
  assert.equal(w0.text, "Para");
  assert.deepEqual(w0.before, []);
  assert.deepEqual(tx(w0.after), [" one.", "Para two is here.", "Para three."]);
  assert.equal(w0.paraIndex, 0);
  const n = RAW.length, w1 = selectionWindow(RAW, n - 5, n, 2);
  assert.equal(w1.text, "five.");
  assert.deepEqual(tx(w1.before), ["Para three.", "Para four.", "Para "]);
  assert.deepEqual(w1.after, []);
  assert.equal(w1.paraIndex, 4);
  // A selection ending exactly where a paragraph starts belongs to the paragraph before it.
  const w2 = selectionWindow(RAW, 0, at("Para two"), 2);
  assert.equal(w2.paraIndex, 0);
});

test("selectionWindow: reversed and out-of-range offsets are swapped and clamped", () => {
  const s = at("two"), e = s + 3;
  assert.deepEqual(selectionWindow(RAW, e, s, 2), selectionWindow(RAW, s, e, 2));
  const w = selectionWindow(RAW, -5, 1e9, 2);
  assert.deepEqual([w.start, w.end, w.text], [0, RAW.length, RAW]);
  assert.equal(w.paraIndex, 4);
});

test("selectionWindow: empty raw", () => {
  assert.deepEqual(selectionWindow("", 0, 0, 2), { start: 0, end: 0, text: "", before: [], after: [], paraIndex: -1 });
  assert.deepEqual(selectionWindow(null, 3, 1, 2), { start: 0, end: 0, text: "", before: [], after: [], paraIndex: -1 });
  assert.equal(selectionWindow("\n\n  \n", 0, 3, 2).paraIndex, -1);
});

test("selectionWindow: n=0 keeps only the partial paragraphs; default n is 2", () => {
  const s = at("two"), e = s + 3;
  const w = selectionWindow(RAW, s, e, 0);
  assert.deepEqual(tx(w.before), ["Para "]);
  assert.deepEqual(tx(w.after), [" is here."]);
  assert.deepEqual(selectionWindow(RAW, s, e), selectionWindow(RAW, s, e, 2));
});

test("selectionWindow: paragraph indices agree with splitParagraphs and CRLF text", () => {
  const raw = "A one.\r\n\r\nB two.\r\nC three.";
  const w = selectionWindow(raw, raw.indexOf("two"), raw.indexOf("two") + 3, 2);
  assert.equal(w.paraIndex, 1);
  assert.deepEqual(tx(w.before), ["A one.", "B "]);
  assert.deepEqual(tx(w.after), [".", "C three."]);
});
