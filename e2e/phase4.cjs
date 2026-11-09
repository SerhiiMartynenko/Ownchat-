// Phase 4 browser end-to-end check for the writing app: scene summaries, proposed facts, scoped chat,
// story-so-far context, stale summaries, bundles with scene threads. Usage: npm run e2e (Playwright + Chromium).
// Starts its own static server for the repo root on an ephemeral port. OpenRouter is mocked.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

let chromium;
try { ({ chromium } = require('playwright')); } catch (e1) {
  try { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); } catch (e2) {
    console.error('Needs Playwright with Chromium.'); process.exit(2);
  }
}

const ROOT = path.resolve(__dirname, '..');
const SHIM = path.join(ROOT, 'e2e/fixtures/fflate-shim.mjs');
const OUT = path.join(__dirname, 'out') + path.sep;
fs.mkdirSync(OUT, { recursive: true });
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.mjs': 'application/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { res.writeHead(400); return res.end(); }
  let file = path.join(ROOT, p);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end(); }
  if (p === '/__blank') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end('<!doctype html><title>blank</title>'); }
  fs.stat(file, (err, st) => {
    if (!err && st.isDirectory()) file = path.join(file, 'index.html');
    fs.readFile(file, (err2, data) => {
      if (err2) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      res.end(data);
    });
  });
});

let BASE = '';
const results = [];
function check(name, ok, info) { results.push({ name, ok: !!ok }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (info !== undefined && !ok ? '  -> ' + JSON.stringify(info).slice(0, 600) : '')); }


const SETTINGS = { apiKey: 'k', model: 'other/x', utilityModel: 'other/util', thinking: 'off', system: '', endpoint: '', editorMode: 'write' };
const OPEN_TEXT = 'Mira climbed the spiral stairs of the old lighthouse while the storm gathered over the grey water. She carried a tin of oil and a box of matches, and she counted every step because counting kept her calm. At the top the lamp waited, cold and silent, and she knew it had to burn tonight.';
const HARBOR_TEXT = 'The harbor woke slowly as the fishing boats drifted in from the dark. Gulls circled the pier while the old men gathered to count the catch and argue about the weather. Nets were hung out to dry across the rails, and a thin smell of salt and smoke hung over every doorway and every stone.';
const wc = (s) => s.split(/\s+/).length;

async function run(browser) {
  const shim = await import(pathToFileURL(SHIM).href);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  const answers = [];
  page.on('dialog', d => { if (d.type() === 'prompt') d.accept(answers.length ? answers.shift() : ''); else d.accept(); });
  await ctx.route('https://cdn.jsdelivr.net/**', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
  await ctx.route('https://cdn.jsdelivr.net/npm/fflate@0.8.2/**', r => r.fulfill({ status: 200, headers: { 'Content-Type': 'application/javascript', 'Access-Control-Allow-Origin': '*' }, body: fs.readFileSync(SHIM, 'utf8') }));

  // ---- OpenRouter mock ----
  const reqs = [];
  let digestMode = 'ok', digestReply = '', foldReply = '';
  const partsText = (c) => typeof c === 'string' ? c : (c || []).map(p => p.text).join('\n');
  const sysText = (b) => b.messages.filter(m => m.role === 'system').map(m => partsText(m.content)).join('\n');
  const userText = (b) => partsText(b.messages[b.messages.length - 1].content);
  await ctx.route('**/api/v1/chat/completions', async r => {
    const body = JSON.parse(r.request().postData());
    reqs.push({ body, headers: r.request().headers() });
    const sys = sysText(body);
    const d = o => 'data: ' + JSON.stringify(o) + '\n\n';
    let reply = 'Reply ok';
    if (sys.includes('digest of one scene')) {
      if (digestMode === 'fail') return r.fulfill({ status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: { message: 'boom' } }) });
      reply = digestReply;
    } else if (sys.includes('running summary of a conversation')) reply = foldReply;
    const n = 3, step = Math.max(1, Math.ceil(reply.length / n));
    let sse = '';
    for (let i = 0; i < reply.length; i += step) sse += d({ choices: [{ delta: { content: reply.slice(i, i + step) } }] });
    sse += 'data: [DONE]\n\n';
    try { await r.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': '*' }, body: sse }); } catch (e) { /* aborted */ }
  });

  const idbDump = () => page.evaluate(() => new Promise((res, rej) => {
    const r = indexedDB.open('ownchat-write');
    r.onerror = () => rej(r.error);
    r.onsuccess = async () => {
      const db = r.result, out = { version: db.version, stores: Array.from(db.objectStoreNames).sort(), data: {} };
      for (const n of out.stores) out.data[n] = await new Promise(ok => { const g = db.transaction(n).objectStore(n).getAll(); g.onsuccess = () => ok(g.result); });
      db.close(); res(out);
    };
  }));
  await page.addInitScript((s) => {
    if (!localStorage.getItem('smoke.seeded')) {
      localStorage.setItem('ownchat.write.settings.v1', JSON.stringify(s));
      localStorage.setItem('smoke.seeded', '1');
    }
  }, SETTINGS);
  const ready = async () => { await page.waitForSelector('html[data-ready="1"]', { timeout: 8000 }); await page.waitForTimeout(300); };
  const view = () => page.evaluate(() => document.body.dataset.view);
  const waitView = (v) => page.waitForSelector('#view' + v[0].toUpperCase() + v.slice(1) + '.active', { timeout: 5000 });
  const menuPick = async (act) => { await page.waitForSelector('#menuOverlay.open'); await page.click('#menuItems [data-act="' + act + '"]'); await page.waitForTimeout(300); };
  const headerVisible = () => page.evaluate(() => Array.from(document.querySelectorAll('[data-views]')).filter(e => !e.hidden).map(e => e.id).sort().join(','));
  const toastHas = async (t, ms = 4000) => { try { await page.waitForFunction((t) => (document.getElementById('toast').textContent || '').includes(t), t, { timeout: ms }); return true; } catch (e) { return false; } };
  const hash = () => page.evaluate(() => location.hash);
  const waitHash = async (re, ms = 4000) => { try { await page.waitForFunction((s) => new RegExp(s).test(location.hash), re.source, { timeout: ms }); } catch (e) {} return re.test(await hash()); };
  const waitReq = async (pred, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const q = reqs.find(pred); if (q) return q; await page.waitForTimeout(100); } return null; };
  const isDigest = (q) => sysText(q.body).includes('digest of one scene');
  const sceneByTitle = async (t) => (await idbDump()).data.scenes.find(s => s.title === t);
  const threads = async () => (await idbDump()).data.threads;
  const lastReq = () => reqs[reqs.length - 1];
  const sendAndWait = async (text) => {
    const n = reqs.length;
    await page.fill('#input', text);
    await page.click('#send');
    await page.waitForFunction(() => !document.querySelector('#send.stop'), null, { timeout: 8000 });
    for (let i = 0; i < 30 && reqs.length === n; i++) await page.waitForTimeout(100);
    await page.waitForTimeout(300);
    return reqs[reqs.length - 1];
  };
  const typeScene = async (text) => {
    await page.fill('#sceneText', text);
    const t0 = Date.now();
    while (Date.now() - t0 < 4000) { const sc = await sceneByTitle((await page.inputValue('#sceneTitle'))); if (sc && sc.wordCount === wc(text)) break; await page.waitForTimeout(150); }
    await page.waitForFunction(() => document.getElementById('sceneSaved').textContent === 'Saved', null, { timeout: 3000 }).catch(() => {});
  };
  const openSceneRow = async (title) => { await page.locator('.scene-row', { hasText: title }).first().click(); await waitView('scene'); };
  const bibleOf = (d) => d.data.bible.find(b => b.id === d.data.projects.find(p => p.id === pid).bibleId);
  const chatHeader = 'hdrBack,modelPill,newChat,openBible,openSettings';
  const poll = async (fn, ms = 4000) => { const t0 = Date.now(); let v; while (Date.now() - t0 < ms) { v = await fn(); if (v) return v; await page.waitForTimeout(150); } return v; };

  // ---- 1. Setup and digest on leaving ----
  await page.goto(BASE + '/write/');
  await ready();
  if ((await view()) !== 'library') { await page.click('#hdrBack'); await waitView('library'); }
  answers.push('Lighthouse');
  if (await page.isVisible('#libraryNew')) await page.click('#libraryNew'); else await page.click('#hdrNewProject');
  await waitView('outline');
  const pid = decodeURIComponent((await hash()).split('/')[2]);
  answers.push('Chapter One');
  await page.click('#outlineEmptyAdd'); await page.waitForSelector('.chapter');
  answers.push('Opening');
  await page.click('.chapter .add-scene'); await page.waitForSelector('.scene-row');
  await page.click('#openBible'); await page.waitForSelector('#bibleOverlay.open');
  await page.click('#bibleAddCard'); await page.waitForSelector('#cardOverlay.open');
  await page.click('#cardType button[data-v=character]');
  await page.fill('#cardName', 'Mira');
  await page.fill('#cardBody', 'The lighthouse keeper.');
  await page.click('#cardSave');
  await page.click('#bibleDone');
  await page.waitForTimeout(300);
  await openSceneRow('Opening');
  await typeScene(OPEN_TEXT);
  digestReply = "Mira lit the lamp at last.\n\n### Proposed facts\n- [character] Tomas: Mira's brother, a fisherman.\n- [place] The Spit: sandbar north of the lighthouse.\n- [character] Mira: duplicate of an existing card";
  await page.click('#hdrBack'); await waitView('outline');
  const d1 = await waitReq(isDigest, 4000);
  await page.waitForTimeout(800);
  check('1. exactly one digest request within 4 s', !!d1 && reqs.filter(isDigest).length === 1, reqs.filter(isDigest).length);
  check('1. digest system text has the sentinel and the bible name Mira', !!d1 && sysText(d1.body).includes('digest of one scene') && sysText(d1.body).includes('Mira'));
  check('1. digest user text contains the scene text', !!d1 && userText(d1.body).includes('counted every step') || (!!d1 && userText(d1.body).includes('counted')), d1 && userText(d1.body).slice(0, 200));
  await page.waitForFunction(() => { const e = document.querySelector('.scene-row .scene-summary'); return e && e.textContent === 'Mira lit the lamp at last.'; }, null, { timeout: 4000 }).catch(() => {});
  check('1. outline summary shows the digest', (await page.textContent('.scene-row .scene-summary')) === 'Mira lit the lamp at last.', await page.textContent('.scene-row .scene-summary'));
  let dump = await idbDump();
  let op = dump.data.scenes.find(s => s.title === 'Opening');
  const openingId = op.id;
  check('1. IDB scene has summary, 8-hex hash, summaryUpdatedAt', op.summary === 'Mira lit the lamp at last.' && /^[0-9a-f]{8}$/.test(op.summaryHash) && op.summaryUpdatedAt > 0, [op.summary, op.summaryHash, op.summaryUpdatedAt]);
  let cards = bibleOf(dump).cards;
  const prop = cards.filter(c => c.status === 'proposed');
  check('1. exactly 2 proposed cards (Tomas, The Spit)', prop.length === 2 && prop.map(c => c.name).sort().join('|') === 'The Spit|Tomas', cards.map(c => [c.name, c.status]));
  check('1. still exactly one Mira card', cards.filter(c => c.name === 'Mira').length === 1);
  check('1. #openBible has class has-proposed', await page.locator('#openBible.has-proposed').count() === 1);
  await page.screenshot({ path: OUT + 'p4-outline-summary.png' });

  // ---- 2. Proposed rows in the bible ----
  await page.click('#openBible'); await page.waitForSelector('#bibleOverlay.open');
  await page.waitForSelector('.card-group.proposed');
  check('2. proposed group with 2 rows', await page.locator('.card-group.proposed .card-row.proposed').count() === 2);
  check('2. a .card-source mentions Opening', (await page.locator('.card-source').allTextContents()).some(t => t.includes('Opening')), await page.locator('.card-source').allTextContents());
  await page.screenshot({ path: OUT + 'p4-bible-proposed.png' });
  const tomas = prop.find(c => c.name === 'Tomas'), spit = prop.find(c => c.name === 'The Spit');
  await page.locator('.card-row.proposed[data-id="' + tomas.id + '"] .card-act.accept').click();
  await page.waitForTimeout(400);
  dump = await idbDump();
  cards = bibleOf(dump).cards;
  check('2. Accept Tomas -> status approved', (cards.find(c => c.id === tomas.id) || {}).status === 'approved', cards.find(c => c.id === tomas.id));
  check('2. Tomas row now sits in a non-proposed group', await page.locator('.card-group:not(.proposed) .card-row[data-id="' + tomas.id + '"]').count() === 1 && await page.locator('.card-group.proposed .card-row[data-id="' + tomas.id + '"]').count() === 0);
  await page.locator('.card-row.proposed[data-id="' + spit.id + '"] .card-act.dismiss').click();
  await page.waitForTimeout(400);
  dump = await idbDump();
  check('2. Dismiss The Spit -> card gone', !bibleOf(dump).cards.some(c => c.id === spit.id));
  await page.click('#bibleDone'); await page.waitForTimeout(300);
  check('2. has-proposed badge removed', await page.locator('#openBible.has-proposed').count() === 0);

  // ---- 3. Scene chat ----
  await openSceneRow('Opening');
  await page.click('#hdrChat'); await waitView('chat');
  check('3. hash is #/s/<id>/chat', await waitHash(new RegExp('^#/s/' + openingId + '/chat$')), await hash());
  check('3. view is chat with the chat header set', (await view()) === 'chat' && (await headerVisible()) === chatHeader, await headerVisible());
  check('3. scope switch visible, Scene on, text has Opening', await page.isVisible('#chatScope') && await page.locator('#chatScopeScene.on').count() === 1 && (await page.textContent('#chatScopeScene')).includes('Opening'), await page.textContent('#chatScopeScene'));
  check('3. empty title "Scene chat"', (await page.textContent('#emptyTitle')) === 'Scene chat');
  check('3. scene chip hidden', !(await page.isVisible('#sceneChip')));
  await page.screenshot({ path: OUT + 'p4-scene-chat.png' });
  let r = await sendAndWait('Hello scene');
  let st = sysText(r.body);
  check('3. scene chat system has Current scene and no Story so far', st.includes('## Current scene: Opening') && !st.includes('## Story so far'), st.slice(0, 300));
  dump = await idbDump();
  let th = dump.data.threads.find(t => t.id === 'ts-' + openingId);
  check('3. IDB thread ts-<id> scope scene, 2 messages', !!th && th.scope === 'scene' && th.sceneId === openingId && th.messages.length === 2, th);

  // ---- 4. Back ----
  await page.click('#hdrBack'); await waitView('scene');
  check('4. Back from the scene chat returns to the scene view', (await view()) === 'scene');

  // ---- 5. Second scene, story so far ----
  await page.click('#hdrBack'); await waitView('outline');
  answers.push('Harbor');
  await page.click('.chapter .add-scene');
  await page.waitForFunction(() => document.querySelectorAll('.scene-row').length === 2);
  await openSceneRow('Harbor');
  await typeScene(HARBOR_TEXT);
  digestReply = "Boats were counted.\n\n### Proposed facts\n- none";
  const nd = reqs.filter(isDigest).length;
  await page.click('#hdrBack'); await waitView('outline');
  const d2 = await waitReq(q => isDigest(q) && reqs.filter(isDigest).indexOf(q) >= nd, 4000);
  check('5. second digest request seen', !!d2 && userText(d2.body).includes('harbor'), d2 && userText(d2.body).slice(0, 200));
  await page.waitForFunction(() => Array.from(document.querySelectorAll('.scene-summary')).some(e => e.textContent === 'Boats were counted.'), null, { timeout: 4000 }).catch(() => {});
  const harborId = (await sceneByTitle('Harbor')).id;
  await openSceneRow('Harbor');
  await page.click('#hdrChat'); await waitView('chat');
  r = await sendAndWait('Hi');
  st = sysText(r.body);
  check('5. Harbor chat has Story so far, Opening heading and summary', st.includes('## Story so far') && st.includes('### Chapter One · Opening') && st.includes('Mira lit the lamp at last.'), st.slice(0, 600));
  check('5. Current scene: Harbor present, own digest absent', st.includes('## Current scene: Harbor') && !st.includes('Boats were counted.'));
  await page.click('#ctxMeter'); await page.waitForSelector('#ctxOverlay.open');
  const nrows = await page.locator('#ctxLayers li.layer-row').count();
  check('5. context sheet has 7 layer rows', nrows === 7, nrows);
  const storyRow = nrows > 2 ? await page.locator('#ctxLayers li.layer-row').nth(2).innerText() : '';
  check('5. story row mentions Story so far and 1 scene', /Story so far/.test(storyRow) && /1 scene/.test(storyRow), storyRow);
  await page.screenshot({ path: OUT + 'p4-context-sheet.png' });
  await page.click('#ctxClose');

  // ---- 6. Project scope ----
  await page.click('#chatScopeProject');
  check('6. hash is #/p/<pid>/chat', await waitHash(new RegExp('^#/p/' + pid + '/chat$')), await hash());
  await page.waitForTimeout(300);
  check('6. project thread is fresh (no messages)', await page.locator('#list > *').count() === 0, await page.locator('#list > *').count());
  check('6. scene chip visible and mentions Harbor', await page.isVisible('#sceneChip') && (await page.textContent('#sceneChip')).includes('Harbor'), await page.textContent('#sceneChip'));
  r = await sendAndWait('Project hi');
  st = sysText(r.body);
  check('6. project chat: Current scene Harbor, SF has Opening but not the Harbor digest', st.includes('## Current scene: Harbor') && st.includes('## Story so far') && st.includes('Opening') && !st.includes('Boats were counted.'), st.slice(0, 500));
  await page.click('#sceneChip');
  r = await sendAndWait('Again');
  st = sysText(r.body);
  check('6. chip off: no Current scene, SF has both summaries', !st.includes('## Current scene:') && st.includes('Mira lit the lamp') && st.includes('Boats were counted.'), st.slice(0, 500));
  await page.click('#hdrBack'); await waitView('scene');
  check('6. Back from the project chat returns to the scene', (await view()) === 'scene' && (await page.inputValue('#sceneTitle')) === 'Harbor');
  await page.click('#hdrChat'); await waitView('chat');
  await page.click('#newChat'); await page.waitForTimeout(600);
  dump = await idbDump();
  const projThread = dump.data.threads.find(t => t.projectId === pid && t.scope !== 'scene');
  const hth = dump.data.threads.find(t => t.id === 'ts-' + harborId);
  check('6. New chat in the scene chat clears only ts-<harborId>', !!hth && hth.messages.length === 0 && !!projThread && projThread.messages.length === 4, [hth && hth.messages.length, projThread && projThread.messages.length]);
  await page.screenshot({ path: OUT + 'p4-project-chat.png' });

  // ---- 7. Stale summary ----
  digestMode = 'fail';
  await page.click('#hdrBack'); await waitView('scene');
  await page.click('#hdrBack'); await waitView('outline');
  await openSceneRow('Opening');
  await typeScene(OPEN_TEXT + ' Then the wind rose and the sea answered.');
  const nd7 = reqs.filter(isDigest).length;
  await page.click('#hdrBack'); await waitView('outline');
  const d3 = await waitReq(q => isDigest(q) && reqs.filter(isDigest).indexOf(q) >= nd7, 4000);
  check('7. a digest request was made and failed (500)', !!d3);
  await page.waitForTimeout(600);
  const staleRow = page.locator('.scene-row', { hasText: 'Opening' }).first().locator('.scene-summary');
  check('7. Opening row has .stale and "out of date"', await staleRow.evaluate(e => e.classList.contains('stale')) && (await staleRow.textContent()).includes('out of date'), await staleRow.textContent());
  await openSceneRow('Harbor');
  await page.click('#hdrChat'); await waitView('chat');
  r = await sendAndWait('Stale check');
  check('7. Harbor chat says "(summary may be out of date)"', sysText(r.body).includes('(summary may be out of date)'), sysText(r.body).slice(0, 500));
  await page.click('#hdrBack'); await waitView('scene');
  await page.click('#hdrBack'); await waitView('outline');
  await openSceneRow('Opening');
  await page.click('#hdrMenu');
  await menuPick('summary');
  await page.waitForSelector('#summaryOverlay.open');
  check('7. summary sheet status says out of date', /out of date/i.test(await page.textContent('#summaryStatus')), await page.textContent('#summaryStatus'));
  digestMode = 'ok'; digestReply = "Mira waited by the lamp.\n\n### Proposed facts\n- none";
  const nd7b = reqs.filter(isDigest).length;
  await page.click('#summaryRegenerate');
  await waitReq(q => isDigest(q) && reqs.filter(isDigest).indexOf(q) >= nd7b, 4000);
  await page.waitForFunction(() => document.getElementById('summaryText').value === 'Mira waited by the lamp.', null, { timeout: 4000 }).catch(() => {});
  check('7. Regenerate fills the text', (await page.inputValue('#summaryText')) === 'Mira waited by the lamp.', await page.inputValue('#summaryText'));
  await page.waitForFunction(() => /Updated/.test(document.getElementById('summaryStatus').textContent), null, { timeout: 3000 }).catch(() => {});
  check('7. status says Updated', /Updated/.test(await page.textContent('#summaryStatus')), await page.textContent('#summaryStatus'));
  await page.screenshot({ path: OUT + 'p4-summary-sheet.png' });
  await page.fill('#summaryText', 'Edited summary.');
  await page.click('#summaryDone');
  await page.waitForTimeout(500);
  op = await sceneByTitle('Opening');
  check('7. Done stores the edit with summaryModel "user"', op.summary === 'Edited summary.' && op.summaryModel === 'user', [op.summary, op.summaryModel]);
  const nd7c = reqs.filter(isDigest).length;
  await page.click('#hdrBack'); await waitView('outline');
  await page.waitForTimeout(800);
  const row2 = page.locator('.scene-row', { hasText: 'Opening' }).first().locator('.scene-summary');
  check('7. outline shows "Edited summary." without stale', (await row2.textContent()) === 'Edited summary.' && !(await row2.evaluate(e => e.classList.contains('stale'))), await row2.textContent());
  check('7. leaving did not re-digest the edited summary', reqs.filter(isDigest).length === nd7c);

  // ---- 8. Fold with proposed facts ----
  await page.evaluate(async ({ id, pid }) => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('ownchat-write'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const tx = db.transaction('threads', 'readwrite');
    const g = await new Promise(ok => { const q = tx.objectStore('threads').get('ts-' + id); q.onsuccess = () => ok(q.result); });
    const msgs = [];
    for (let i = 0; i < 18; i++) {
      const u = i % 2 === 0, text = (u ? 'Question number ' : 'Answer number ') + i + ' about the lighthouse and its lamp, with enough words to count for something.';
      msgs.push(u ? { id: 'seed' + i, role: 'user', content: text, display: text } : { id: 'seed' + i, role: 'assistant', content: text });
    }
    const rec = Object.assign({}, g || {}, { id: 'ts-' + id, projectId: pid, scope: 'scene', sceneId: id, messages: msgs, summary: '', summarizedUpTo: 0, summarizedUpToId: null, updatedAt: Date.now() });
    tx.objectStore('threads').put(rec);
    await new Promise(ok => { tx.oncomplete = ok; });
    db.close();
  }, { id: openingId, pid });
  await page.goto(BASE + '/write/#/s/' + openingId + '/chat');
  await page.reload(); await ready();
  await waitView('chat');
  foldReply = "Summary of the talk.\n\n### Proposed facts\n- [thread] The letter: Tomas never answered it.";
  await page.fill('#input', 'One more question'); await page.click('#send');
  const fq = await waitReq(q => sysText(q.body).includes('running summary of a conversation'), 8000);
  check('8. a fold request was sent', !!fq);
  const letter = await poll(async () => { const d = await idbDump(); return bibleOf(d).cards.find(c => c.name === 'The letter'); }, 5000);
  check('8. proposed card "The letter" with source.kind chat', !!letter && letter.status === 'proposed' && letter.source && letter.source.kind === 'chat', letter);
  const folded = await poll(async () => (await threads()).find(t => t.id === 'ts-' + openingId && t.summary === 'Summary of the talk.'), 5000);
  check('8. thread summary is "Summary of the talk."', !!folded, (await threads()).find(t => t.id === 'ts-' + openingId));

  // ---- 9. Export / import ----
  await page.click('#hdrBack'); await waitView('scene');
  await page.click('#hdrBack'); await waitView('outline');
  await page.click('#hdrMenu');
  const dlP = page.waitForEvent('download', { timeout: 8000 });
  await menuPick('bundle');
  const dl = await dlP;
  const zipPath = OUT + 'p4-' + dl.suggestedFilename();
  await dl.saveAs(zipPath);
  let files = {};
  try { const e = shim.unzipSync(new Uint8Array(fs.readFileSync(zipPath))); for (const k of Object.keys(e)) files[k] = shim.strFromU8(e[k]); } catch (e) { files = {}; }
  let manifest = {};
  try { manifest = JSON.parse(files['manifest.json']); } catch (e) {}
  const stEntries = manifest.sceneThreads || [];
  check('9. manifest has 2 sceneThreads', stEntries.length === 2, stEntries);
  check('9. every scene thread file exists in the zip', stEntries.length === 2 && stEntries.every(e => { const f = e.file || e.path; return f && files[f] !== undefined; }), [stEntries, Object.keys(files)]);
  await page.click('#hdrBack'); await waitView('library');
  await page.setInputFiles('#bundleInput', zipPath);
  await menuPick('copy');
  await waitView('outline');
  const pid2 = decodeURIComponent((await hash()).split('/')[2]);
  dump = await idbDump();
  const copyScenes = dump.data.scenes.filter(s => s.projectId === pid2);
  const copyThreads = dump.data.threads.filter(t => t.projectId === pid2 && t.scope === 'scene');
  check('9. copy has 2 scene threads with ids ts-<newId> and new sceneIds', pid2 !== pid && copyThreads.length === 2 && copyThreads.every(t => copyScenes.some(s => s.id === t.sceneId && t.id === 'ts-' + s.id)) && copyScenes.every(s => s.id !== openingId && s.id !== harborId), [copyThreads.map(t => [t.id, t.sceneId]), copyScenes.map(s => s.id)]);

  // ---- 10. Deletes ----
  await page.click('#hdrBack'); await waitView('library');
  await page.locator('.project-row', { hasText: /^Lighthouse$|^Lighthouse(?! \(imported\))/ }).first().click().catch(() => {});
  await waitView('outline');
  check('10. back in the original project', decodeURIComponent((await hash()).split('/')[2]) === pid, await hash());
  await page.locator('.scene-row', { hasText: 'Harbor' }).first().locator('.row-menu').click();
  await menuPick('delete');
  await page.waitForTimeout(600);
  check('10. deleting Harbor removes ts-<harborId>', !(await threads()).some(t => t.id === 'ts-' + harborId) && (await threads()).some(t => t.id === 'ts-' + openingId));
  await page.click('#hdrMenu');
  await menuPick('delete');
  await waitView('library');
  await page.waitForTimeout(500);
  check('10. deleting the project removes all its threads', !(await threads()).some(t => t.projectId === pid), (await threads()).map(t => t.id));

  // ---- 11. Unknown scene route and legacy thread ----
  await page.evaluate(() => { location.hash = '#/s/does-not-exist/chat'; });
  await page.waitForTimeout(600);
  check('11. unknown scene chat falls back to the library', (await view()) === 'library');
  check('11. a toast explains it', (await page.textContent('#toast')).trim().length > 0, await page.textContent('#toast'));
  dump = await idbDump();
  const proj2 = dump.data.projects.find(p => p.id === pid2);
  const legacyId = proj2.threadId || ('t-' + pid2);
  await page.evaluate(async ({ id, pid }) => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('ownchat-write'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const tx = db.transaction('threads', 'readwrite');
    tx.objectStore('threads').put({ id, projectId: pid, messages: [{ id: 'l1', role: 'user', content: 'legacy q', display: 'legacy q' }, { id: 'l2', role: 'assistant', content: 'legacy a' }], summary: '', summarizedUpTo: 0, summarizedUpToId: null, updatedAt: 1 });
    await new Promise(ok => { tx.oncomplete = ok; });
    db.close();
  }, { id: legacyId, pid: pid2 });
  const errBefore = errors.length;
  await page.goto(BASE + '/write/#/p/' + pid2 + '/chat');
  await page.reload(); await ready();
  await waitView('chat');
  check('11. legacy thread without scope renders 2 messages', await page.locator('#list > *').count() === 2, await page.locator('#list > *').count());
  check('11. project chat state: title "Project chat", Scene scope not on, no errors', (await page.textContent('#emptyTitle')) === 'Project chat' && await page.locator('#chatScopeScene.on').count() === 0 && errors.length === errBefore, errors.slice(errBefore));
  await page.screenshot({ path: OUT + 'p4-legacy-chat.png' });

  // ---- 12. Headers and console ----
  const allowed = new Set(['authorization', 'content-type']);
  const normal = new Set(['accept', 'accept-encoding', 'accept-language', 'content-length', 'origin', 'referer', 'user-agent', 'host', 'connection', 'cache-control', 'pragma', 'priority']);
  const stray = [];
  for (const q of reqs) for (const k of Object.keys(q.headers)) { const l = k.toLowerCase(); if (!allowed.has(l) && !normal.has(l) && !/^(sec-|:)/.test(l)) stray.push(k); }
  check('12. only authorization and content-type custom headers on API requests', reqs.length > 0 && stray.length === 0, stray);
  if (errors.length) console.log('filtered:', JSON.stringify(errors));
  const real = errors.filter(e => !/status of 500/.test(e));
  check('12. no console errors / pageerrors (the deliberate HTTP 500 resource log is excluded)', real.length === 0, real);
}

(async () => {
  await new Promise(res => server.listen(0, '127.0.0.1', res));
  BASE = 'http://127.0.0.1:' + server.address().port;
  let browser, crashed = false;
  try { browser = await chromium.launch(); await run(browser); }
  catch (e) { crashed = true; console.error(e); }
  finally { if (browser) await browser.close().catch(() => {}); await new Promise(res => server.close(res)); }
  const fails = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - fails}/${results.length} passed`);
  process.exit(fails || crashed ? 1 : 0);
})();
