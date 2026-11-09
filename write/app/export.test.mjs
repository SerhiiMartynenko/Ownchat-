import test from "node:test";
import assert from "node:assert/strict";
import * as shim from "../../e2e/fixtures/fflate-shim.mjs";
import { FFLATE_URL, MAX_BUNDLE_BYTES, zipBundle, unzipBundle, loadZip, readBundleFile, slugify,
  bundleFilename, manuscriptFilename, dateStamp } from "./export.js";
import { normalizeBible } from "./bible.js";

function data(){
  return {
    project: { id: "p1", title: "Ёлка: A Story", bibleId: "b-p1", threadId: "t-p1", createdAt: 1, updatedAt: 2 },
    chapters: [{ id: "c1", projectId: "p1", order: 0, title: "One", createdAt: 1, updatedAt: 1 }],
    scenes: [{ id: "s1", projectId: "p1", chapterId: "c1", order: 0, title: "Start",
      blocks: [{ id: "b1", text: "Привет." }, { id: "b2", text: "Hello there." }],
      summary: "", summaryHash: "", wordCount: 3, createdAt: 1, updatedAt: 1 }],
    bible: Object.assign(normalizeBible({ id: "b-p1", brief: "Brief", cards: [
      { id: "k1", name: "Liz", type: "character", createdAt: 1, updatedAt: 1 }] }), { projectId: "p1" }),
    thread: { id: "t-p1", projectId: "p1", messages: [{ id: "m1", role: "user", content: "Hi" }], summarizedUpToId: null }
  };
}

test("shim zip round trip is byte exact", () => {
  const bytes = shim.zipSync({ "a.txt": shim.strToU8("héllo"), "b/c.md": [shim.strToU8("x"), { level: 0 }] }, { level: 6 });
  const out = shim.unzipSync(bytes);
  assert.equal(shim.strFromU8(out["a.txt"]), "héllo");
  assert.equal(shim.strFromU8(out["b/c.md"]), "x");
  assert.throws(() => shim.unzipSync(shim.strToU8("PK nope")));
});

test("zipBundle / unzipBundle round trip through the shim", () => {
  const d = data();
  const bytes = zipBundle(d, shim, () => 0);
  assert.ok(bytes instanceof Uint8Array);
  const entries = shim.unzipSync(bytes);
  const manifest = JSON.parse(shim.strFromU8(entries["manifest.json"]));
  assert.equal(manifest.exportedAt, "1970-01-01T00:00:00.000Z");
  assert.equal(manifest.scenes[0].file, "scenes/01-one/01-start.md");
  const back = unzipBundle(bytes, shim);
  assert.deepEqual(back.warnings, []);
  assert.deepEqual(back.project, d.project);
  assert.deepEqual(back.chapters, d.chapters);
  assert.deepEqual(back.scenes, d.scenes);
  assert.deepEqual(back.bible, d.bible);
  assert.deepEqual(back.thread, d.thread);
});

test("unzipBundle rejects oversize input and non-zips", () => {
  const big = { length: MAX_BUNDLE_BYTES + 1 };
  assert.throws(() => unzipBundle(big, shim), /too large/);
  assert.throws(() => unzipBundle(shim.strToU8("garbage"), shim), /Not an Ownchat project bundle/);
});

test("readBundleFile reads a Blob and checks size", async () => {
  const bytes = zipBundle(data(), shim, 0);
  const back = await readBundleFile(new Blob([bytes]), { lib: shim });
  assert.equal(back.project.id, "p1");
  await assert.rejects(readBundleFile({ size: MAX_BUNDLE_BYTES + 1 }, { lib: shim }), /too large/);
  let loaded = 0;
  const viaLoader = await readBundleFile(new Blob([bytes]), { loadZip: async () => { loaded++; return shim; } });
  assert.equal(loaded, 1);
  assert.equal(viaLoader.scenes.length, 1);
});

test("loadZip reports a clear error when the module cannot load", async () => {
  assert.match(FFLATE_URL, /fflate@0\.8\.2/);
  await assert.rejects(loadZip("data:text/javascript,throw new Error('x')"), /Could not load the zip library/);
  const lib = await loadZip(new URL("../../e2e/fixtures/fflate-shim.mjs", import.meta.url).href);
  assert.equal(typeof lib.zipSync, "function");
});

test("filenames use the project slug", () => {
  assert.equal(slugify("Hello World"), "hello-world");
  assert.equal(bundleFilename({ title: "Ёлка: A Story" }), "елка-a-story.ownchat.zip");
  assert.equal(bundleFilename({ title: "!!!" }), "project.ownchat.zip");
  assert.equal(bundleFilename(null), "project.ownchat.zip");
  assert.equal(manuscriptFilename({ title: "My Book" }, new Date(2026, 0, 5)), "my-book-2026-01-05.md");
  assert.equal(dateStamp(new Date(2026, 10, 9)), "2026-11-09");
});
