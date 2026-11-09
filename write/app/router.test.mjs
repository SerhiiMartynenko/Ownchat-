import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRoute, formatRoute, sameRoute } from "./router.js";

test("round trip for every route", () => {
  const routes = [
    { name: "library" },
    { name: "outline", projectId: "abc123" },
    { name: "scene", sceneId: "s-1" },
    { name: "chat", projectId: "abc123" },
    { name: "sceneChat", sceneId: "s-1" }
  ];
  for(const r of routes){
    const h = formatRoute(r);
    assert.deepEqual(parseRoute(h), r, h);
    assert.ok(sameRoute(parseRoute(h), r));
  }
  assert.equal(formatRoute({ name: "outline", projectId: "x" }), "#/p/x");
  assert.equal(formatRoute({ name: "chat", projectId: "x" }), "#/p/x/chat");
  assert.equal(formatRoute({ name: "scene", sceneId: "y" }), "#/s/y");
  assert.equal(formatRoute({ name: "library" }), "#/library");
});

test("unknown and malformed hashes fall back to the library", () => {
  for(const h of ["", "#", "#/", "#/nope", "#/p", "#/p/", "#/s", "#/p/x/chat/more", "#/p/x/notes", "#/s/%E0%A4%A", null, undefined]){
    assert.deepEqual(parseRoute(h), { name: "library" }, String(h));
  }
  assert.equal(formatRoute(null), "#/library");
  assert.equal(formatRoute({ name: "outline" }), "#/library");
  assert.equal(formatRoute({ name: "weird", projectId: "x" }), "#/library");
});

test("ids are encoded and decoded", () => {
  const id = "a b/c#d?é";
  const h = formatRoute({ name: "scene", sceneId: id });
  assert.ok(!/[ #?é]/.test(h.slice(1)), h);
  assert.equal(h.split("/").length, 3);
  assert.deepEqual(parseRoute(h), { name: "scene", sceneId: id });
  assert.deepEqual(parseRoute(formatRoute({ name: "chat", projectId: id })), { name: "chat", projectId: id });
  assert.deepEqual(parseRoute("p/x"), { name: "outline", projectId: "x" });
  assert.deepEqual(parseRoute("#/p/x/"), { name: "outline", projectId: "x" });
});

test("scene chat route", () => {
  assert.equal(formatRoute({ name: "sceneChat", sceneId: "x" }), "#/s/x/chat");
  assert.deepEqual(parseRoute("#/s/x/chat"), { name: "sceneChat", sceneId: "x" });
  assert.deepEqual(parseRoute("#/s/x/chat/"), { name: "sceneChat", sceneId: "x" });
  assert.equal(formatRoute({ name: "sceneChat" }), "#/library");
  for(const h of ["#/s/x/chat/more", "#/s/x/notes", "#/s//chat"]){
    assert.deepEqual(parseRoute(h), { name: "library" }, h);
  }
  assert.ok(!sameRoute({ name: "scene", sceneId: "x" }, { name: "sceneChat", sceneId: "x" }));
});

test("scene chat ids are encoded and decoded", () => {
  const id = "a b/c#d?é";
  const h = formatRoute({ name: "sceneChat", sceneId: id });
  assert.ok(!/[ #?é]/.test(h.slice(1)), h);
  assert.equal(h.split("/").length, 4);
  assert.deepEqual(parseRoute(h), { name: "sceneChat", sceneId: id });
});
