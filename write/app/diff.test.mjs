import test from "node:test";
import assert from "node:assert/strict";
import { diffWords, diffStats, DIFF_CELL_CAP } from "./diff.js";

const side = (ops, keep) => ops.filter(o => o.type === "eq" || o.type === keep).map(o => o.text).join("");
const roundTrip = (a, b) => {
  const ops = diffWords(a, b);
  assert.equal(side(ops, "del"), a);
  assert.equal(side(ops, "ins"), b);
  for (let i = 1; i < ops.length; i++) assert.notEqual(ops[i].type, ops[i - 1].type, "adjacent ops merged");
  ops.forEach(o => assert.ok(o.text.length > 0, "no empty ops"));
  return ops;
};

test("empty and identical inputs", () => {
  assert.deepEqual(diffWords("", ""), []);
  assert.deepEqual(diffWords(null, undefined), []);
  assert.deepEqual(diffWords("Same words here.", "Same words here."), [{ type: "eq", text: "Same words here." }]);
  assert.deepEqual(diffWords("", "new text"), [{ type: "ins", text: "new text" }]);
  assert.deepEqual(diffWords("old text", ""), [{ type: "del", text: "old text" }]);
});

test("single word replacement", () => {
  const ops = roundTrip("The cat sat on the mat.", "The dog sat on the mat.");
  assert.deepEqual(ops, [
    { type: "eq", text: "The " }, { type: "del", text: "cat" }, { type: "ins", text: "dog" },
    { type: "eq", text: " sat on the mat." }
  ]);
});

test("insertions and deletions in the middle, punctuation runs are tokens", () => {
  const ops = roundTrip("She ran fast, very fast!", "She ran, very slowly!!");
  assert.ok(ops.some(o => o.type === "del" && /fast/.test(o.text)));
  assert.ok(ops.some(o => o.type === "ins" && /slowly!!/.test(o.text)));
  const pure = roundTrip("one two three", "one two two-and-a-half three");
  assert.deepEqual(pure.filter(o => o.type !== "eq"), [{ type: "ins", text: "two-and-a-half " }]);
});

test("changes between two eq runs read as one deletion then one insertion", () => {
  const ops = roundTrip("a b c d e", "a x y z e");
  assert.deepEqual(ops, [
    { type: "eq", text: "a " }, { type: "del", text: "b c d" }, { type: "ins", text: "x y z" }, { type: "eq", text: " e" }
  ]);
});

test("unicode: Cyrillic, curly quotes, em dashes", () => {
  const a = "Він сказав: “Ні” — і пішов.";
  const b = "Вона сказала: “Так” — і пішла.";
  const ops = roundTrip(a, b);
  assert.ok(ops.some(o => o.type === "del" && o.text.includes("“Ні”")));
  assert.ok(ops.some(o => o.type === "eq" && o.text.includes("—")));
  roundTrip("Тиша. Тиша.", "Тиша — знову тиша.");
});

test("deterministic", () => {
  const a = "x y x y x y z", b = "y x y x z z";
  assert.deepEqual(diffWords(a, b), diffWords(a, b));
  roundTrip(a, b);
});

test("cap: over the cell limit falls back to delete-all, insert-all", () => {
  const n = Math.ceil(Math.sqrt(DIFF_CELL_CAP) / 2) + 10; // tokens ~ 2n (words + spaces) on each side
  const a = Array.from({ length: n }, (_, i) => "a" + i).join(" ");
  const b = Array.from({ length: n }, (_, i) => "b" + i).join(" ");
  const t0 = Date.now();
  const ops = diffWords(a, b);
  assert.deepEqual(ops, [{ type: "del", text: a }, { type: "ins", text: b }]);
  assert.ok(Date.now() - t0 < 500);
  // A shared prefix and suffix survive the fallback.
  const ops2 = diffWords("start " + a + " end", "start " + b + " end");
  assert.deepEqual(ops2.map(o => o.type), ["eq", "del", "ins", "eq"]);
});

test("diffStats counts words", () => {
  const ops = diffWords("The quick brown fox jumps.", "The slow fox leaps — high.");
  const st = diffStats(ops);
  assert.equal(st.deleted, 3);  // quick brown jumps.
  assert.equal(st.inserted, 3); // slow leaps high. (the dash is not a word)
  assert.deepEqual(diffStats([]), { inserted: 0, deleted: 0 });
  assert.deepEqual(diffStats(null), { inserted: 0, deleted: 0 });
  assert.deepEqual(diffStats([{ type: "ins", text: "один два" }, { type: "del", text: "три" }, { type: "eq", text: "x y" }]), { inserted: 2, deleted: 1 });
});
