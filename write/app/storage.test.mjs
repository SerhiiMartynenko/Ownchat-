import test from "node:test";
import assert from "node:assert/strict";
import { NOTICE_DEFAULTS, formatBytes, readStorageStatus, storageStatusText, isIOS, isStandalone, pickNotice } from "./storage.js";

const DAY = 864e5;
const NOW = 100 * DAY;

test("formatBytes vectors", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(870), "870 B");
  assert.equal(formatBytes(12345), "12.3 kB".replace("12.3", "12.3"));
  assert.equal(formatBytes(12345678), "12.3 MB");
  assert.equal(formatBytes(2.1e9), "2.1 GB");
  assert.equal(formatBytes(NaN), "0 B");
  assert.equal(formatBytes(-5), "0 B");
  assert.equal(formatBytes("x"), "0 B");
  assert.equal(formatBytes(undefined), "0 B");
});

test("readStorageStatus full API", async () => {
  const nav = { storage: { persisted: async () => true, estimate: async () => ({ usage: 10, quota: 100 }) } };
  assert.deepEqual(await readStorageStatus(nav), { supported: true, persisted: true, usage: 10, quota: 100 });
  const nav2 = { storage: { persisted: async () => false, estimate: async () => ({ usage: 1, quota: 2 }) } };
  assert.equal((await readStorageStatus(nav2)).persisted, false);
});

test("readStorageStatus persisted rejects still reads estimate", async () => {
  const nav = { storage: { persisted: async () => { throw new Error("x"); }, estimate: async () => ({ usage: 5, quota: 50 }) } };
  assert.deepEqual(await readStorageStatus(nav), { supported: true, persisted: null, usage: 5, quota: 50 });
});

test("readStorageStatus without storage", async () => {
  const none = { supported: false, persisted: null, usage: null, quota: null };
  assert.deepEqual(await readStorageStatus({}), none);
  assert.deepEqual(await readStorageStatus(null), none);
  const nav = { storage: { persisted: async () => true, estimate: async () => { throw new Error("x"); } } };
  assert.deepEqual(await readStorageStatus(nav), { supported: true, persisted: true, usage: null, quota: null });
});

test("storageStatusText variants", () => {
  assert.equal(storageStatusText({ supported: true, persisted: true, usage: 12345678, quota: 2.1e9 }), "Protected · 12.3 MB used of 2.1 GB");
  assert.equal(storageStatusText({ supported: true, persisted: false, usage: 12345678, quota: 2.1e9 }), "Not protected · 12.3 MB used of 2.1 GB");
  assert.equal(storageStatusText({ supported: true, persisted: true, usage: null, quota: null }), "Protected");
  assert.equal(storageStatusText({ supported: true, persisted: false, usage: null, quota: null }), "Not protected");
  assert.equal(storageStatusText({ supported: false, persisted: null, usage: null, quota: null }), "Storage status unavailable");
  assert.equal(storageStatusText(null), "Storage status unavailable");
});

test("isIOS", () => {
  assert.equal(isIOS("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)", "iPhone", 5), true);
  assert.equal(isIOS("Mozilla/5.0 (iPad; CPU OS 16)", "iPad", 5), true);
  assert.equal(isIOS("Mozilla/5.0 (Macintosh)", "MacIntel", 5), true);
  assert.equal(isIOS("Mozilla/5.0 (Macintosh)", "MacIntel", 0), false);
  assert.equal(isIOS("Mozilla/5.0 (X11; Linux)", "Linux x86_64", 0), false);
  assert.equal(isIOS(undefined, undefined, undefined), false);
});

test("isStandalone", () => {
  assert.equal(isStandalone({ standalone: true }, () => ({ matches: false })), true);
  assert.equal(isStandalone({}, () => ({ matches: true })), true);
  assert.equal(isStandalone({}, () => ({ matches: false })), false);
  assert.equal(isStandalone({}, () => { throw new Error("x"); }), false);
  assert.equal(isStandalone(null, null), false);
});

const proj = (o) => ({ id: "p1", title: "Novel", createdAt: NOW - 30 * DAY, updatedAt: NOW - DAY, stats: { words: 1000 }, ...o });
const inp = (o) => ({ persisted: true, projects: [proj()], exports: {}, dismissed: {}, now: NOW, standalone: false, ...o });

test("storage notice conditions", () => {
  const n = pickNotice(inp({ persisted: false }));
  assert.equal(n.kind, "storage");
  assert.equal(n.action, "Protect storage");
  assert.match(n.text, /stored only in this browser/);
  assert.equal(pickNotice(inp({ persisted: false, projects: [] })), null);
  assert.equal(pickNotice(inp({ persisted: false, standalone: true, projects: [proj({ stats: { words: 0 } })] })), null);
  assert.equal(pickNotice(inp({ persisted: false, dismissed: { storageAt: NOW - DAY }, projects: [proj({ stats: { words: 0 } })] })), null);
  assert.equal(pickNotice(inp({ persisted: false, dismissed: { storageAt: NOW - 31 * DAY } })).kind, "storage");
  assert.equal(pickNotice(inp({ persisted: null, projects: [proj({ stats: { words: 0 } })] })), null);
});

test("storage takes precedence over backup", () => {
  assert.equal(pickNotice(inp({ persisted: false })).kind, "storage");
  assert.equal(pickNotice(inp({ persisted: false, dismissed: { storageAt: NOW } })).kind, "backup");
});

test("backup never exported", () => {
  const n = pickNotice(inp());
  assert.equal(n.kind, "backup");
  assert.equal(n.projectId, "p1");
  assert.equal(n.days, 30);
  assert.equal(n.action, "Export backup");
  assert.equal(n.text, "“Novel” has never been exported. Export a backup to keep a copy outside this browser.");
  assert.equal(pickNotice(inp({ projects: [proj({ createdAt: NOW - 2 * DAY })] })), null);
});

test("backup changed since export", () => {
  const n = pickNotice(inp({ exports: { p1: NOW - 10 * DAY }, projects: [proj({ updatedAt: NOW - DAY })] }));
  assert.equal(n.days, 10);
  assert.equal(n.text, "“Novel” has changes that were not exported for 10 days. Export a backup.");
  assert.equal(pickNotice(inp({ exports: { p1: NOW - 10 * DAY }, projects: [proj({ updatedAt: NOW - 20 * DAY })] })), null);
  assert.equal(pickNotice(inp({ exports: { p1: NOW - 3 * DAY } })), null);
});

test("minWords filter and untitled", () => {
  assert.equal(pickNotice(inp({ projects: [proj({ stats: { words: 499 } })] })), null);
  assert.equal(pickNotice(inp({ projects: [proj({ stats: { words: 500 } })] })).kind, "backup");
  assert.equal(pickNotice(inp({ projects: [proj({ stats: { words: 100 } })] }), { minWords: 50 }).kind, "backup");
  assert.match(pickNotice(inp({ projects: [proj({ title: "" })] })).text, /Untitled project/);
});

test("most overdue chosen", () => {
  const n = pickNotice(inp({
    projects: [proj({ id: "a", title: "A", createdAt: NOW - 20 * DAY }), proj({ id: "b", title: "B", createdAt: NOW - 40 * DAY }), proj({ id: "c", title: "C", updatedAt: NOW - DAY })],
    exports: { c: NOW - 25 * DAY }
  }));
  assert.equal(n.projectId, "b");
  assert.equal(n.days, 40);
});

test("backup snooze", () => {
  assert.equal(pickNotice(inp({ dismissed: { backupAt: NOW - DAY } })), null);
  assert.equal(pickNotice(inp({ dismissed: { backupAt: NOW - 8 * DAY } })).kind, "backup");
});

test("defensive and immutable", () => {
  assert.equal(pickNotice(undefined), null);
  assert.equal(pickNotice({}), null);
  assert.equal(pickNotice({ persisted: false, projects: [null, {}], now: NOW }).kind, "storage");
  const input = inp({ persisted: false, exports: { p1: 1 }, dismissed: { backupAt: 2 } });
  const copy = JSON.parse(JSON.stringify(input));
  pickNotice(input); pickNotice(input, { minWords: 1 });
  assert.deepEqual(input, copy);
  assert.equal(NOTICE_DEFAULTS.minWords, 500);
});
