import test from "node:test";
import assert from "node:assert/strict";
import { hashText, estimateTokens } from "./util.js";

test("hashText matches known FNV-1a vectors", () => {
  assert.equal(hashText(""), "811c9dc5");
  assert.equal(hashText("a"), "e40c292c");
  assert.equal(hashText("foobar"), "bf9cf968");
});

test("hashText treats null and undefined as empty string", () => {
  assert.equal(hashText(undefined), hashText(""));
  assert.equal(hashText(null), hashText(""));
});

test("hashText always returns 8 lowercase hex chars", () => {
  const inputs = ["", "a", "hello world", "Привет, мир", "emoji 😀🎉", "x".repeat(20000), 12345];
  for (const s of inputs) {
    assert.match(hashText(s), /^[0-9a-f]{8}$/);
  }
});

test("hashText differs for different inputs and is stable", () => {
  assert.notEqual(hashText("a"), hashText("b"));
  assert.notEqual(hashText("ab"), hashText("ba"));
  assert.equal(hashText("Привет 😀"), hashText("Привет 😀"));
});

test("estimateTokens smoke test", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("привет"), 3);
});
