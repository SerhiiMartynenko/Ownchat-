// Performance benchmark for the writing app on a long manuscript. Usage: npm run perf (Playwright + Chromium).
// Seeds a ~108k-word project through the app's own store modules, reloads the app and times the main
// navigation steps (median of 3). Prints a table; exits 1 only when a step takes more than twice its budget.
// Starts its own static server for the repo root on an ephemeral port. No network: the CDN and OpenRouter are stubbed.
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

let chromium;
try { ({ chromium } = require('playwright')); } catch (e1) {
  try { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); } catch (e2) {
    console.error('Needs Playwright with Chromium.'); process.exit(2);
  }
}

const ROOT = path.resolve(__dirname, '..');
const SHIM = path.join(ROOT, 'e2e/fixtures/fflate-shim.mjs');
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

const RUNS = 3;
// CPU slowdown applied through DevTools to approximate a phone (PERF_CPU=1 for none).
const CPU_RATE = Math.max(1, Number(process.env.PERF_CPU || 4));
const NAV_BUDGET = 300, IO_BUDGET = 2000, LONGTASK_BUDGET = 50;
const SETTINGS = { apiKey: 'k', model: 'other/x', utilityModel: 'other/util', thinking: 'off', system: '', endpoint: '', editorMode: 'blocks' };

// ---- Deterministic prose ----
let seed = 0x2545f491;
function rnd() { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; }
const pick = (a) => a[Math.floor(rnd() * a.length)];
const NAMES = ['Mira', 'Tomas', 'Elena', 'Oskar', 'Lena', 'Viktor', 'Ada', 'Bram', 'Celia', 'Dario', 'Edda', 'Felix', 'Greta', 'Hugo', 'Ines', 'Jonas', 'Katya', 'Leon', 'Marta', 'Nils'];
const PLACES = ['the lighthouse', 'the harbor', 'the old mill', 'the chapel', 'the market square', 'the cliff path', 'the boathouse', 'the inn', 'the archive', 'the bridge', 'the orchard', 'the station', 'the dunes', 'the quarry', 'the ferry', 'the courtyard', 'the tower', 'the garden', 'the cellar', 'the pier'];
const VERBS = ['walked', 'waited', 'listened', 'remembered', 'argued', 'laughed', 'hesitated', 'turned', 'whispered', 'watched', 'counted', 'searched', 'climbed', 'followed', 'promised', 'forgot', 'carried', 'opened', 'closed', 'studied'];
const ADJ = ['grey', 'quiet', 'restless', 'bitter', 'golden', 'narrow', 'cold', 'bright', 'heavy', 'distant', 'broken', 'gentle', 'crooked', 'salt-stained', 'silent', 'hollow', 'warm', 'pale', 'tangled', 'familiar'];
const NOUNS = ['storm', 'letter', 'lamp', 'rope', 'window', 'door', 'map', 'key', 'boat', 'bell', 'coat', 'candle', 'basket', 'stair', 'clock', 'net', 'stone', 'mirror', 'ledger', 'wall'];
const TAILS = ['before the light failed', 'while the tide turned', 'as if nothing had happened', 'without a word to anyone', 'until the bells rang twice', 'because the rain would not stop', 'though nobody believed her', 'long after midnight', 'when the wind dropped', 'as the fog rolled in'];
function sentence() {
  const k = rnd();
  if (k < 0.3) return `${pick(NAMES)} ${pick(VERBS)} near ${pick(PLACES)} ${pick(TAILS)}.`;
  if (k < 0.6) return `The ${pick(ADJ)} ${pick(NOUNS)} lay by ${pick(PLACES)}, and ${pick(NAMES)} ${pick(VERBS)} ${pick(TAILS)}.`;
  if (k < 0.8) return `"${pick(NAMES)}, the ${pick(NOUNS)} is ${pick(ADJ)}," said ${pick(NAMES)}, and ${pick(VERBS)} again.`;
  return `Somewhere beyond ${pick(PLACES)} a ${pick(ADJ)} ${pick(NOUNS)} ${pick(VERBS)}, ${pick(TAILS)}, and the ${pick(ADJ)} ${pick(NOUNS)} answered.`;
}
const wordsIn = (s) => s.split(/\s+/).filter(Boolean).length;
function paragraph(target) { let p = '', n = 0; while (n < target) { const s = sentence(); p += (p ? ' ' : '') + s; n += wordsIn(s); } return p; }
function sceneText(target) { const ps = []; let n = 0; while (n < target) { const p = paragraph(60 + Math.floor(rnd() * 60)); ps.push(p); n += wordsIn(p); } return ps.join('\n\n'); }
function message(i) {
  if (i % 2 === 0) return { role: 'user', text: paragraph(60 + Math.floor(rnd() * 30)) };
  const body = paragraph(45);
  return { role: 'assistant', text: `**${pick(NAMES)}** could ${pick(VERBS).replace(/ed$/, '')} here.\n\n- ${sentence()}\n- ${sentence()}\n\n${body} Try \`${pick(NOUNS)}\` as the image.` };
}

function buildSeed() {
  const A = { title: 'Long Book', chapters: [] };
  for (let c = 0; c < 12; c++) {
    const ch = { title: 'Chapter ' + (c + 1), scenes: [] };
    for (let s = 0; s < 10; s++) ch.scenes.push({ title: `Scene ${c + 1}.${s + 1}`, text: sceneText(750 + Math.floor(rnd() * 300)) });
    A.chapters.push(ch);
  }
  const B = { title: 'Short Book', chapters: [] };
  for (let c = 0; c < 2; c++) {
    const ch = { title: 'Part ' + (c + 1), scenes: [] };
    for (let s = 0; s < 3; s++) ch.scenes.push({ title: `Bit ${c + 1}.${s + 1}`, text: sceneText(500) });
    B.chapters.push(ch);
  }
  const messages = [];
  for (let i = 0; i < 150; i++) messages.push(message(i));
  const cards = [];
  const types = ['character', 'place', 'thing', 'note'];
  for (let i = 0; i < 40; i++) cards.push({ type: types[i % 4], name: i < 20 ? NAMES[i] : PLACES[i - 20].replace(/^the /, 'The '), body: paragraph(40), pinned: i < 2 });
  const versionTails = [];
  for (let i = 0; i < 20; i++) versionTails.push(paragraph(40));
  return { A, B, messages, cards, versionTails };
}

// Runs in the page (/__blank, same origin as the app): seeds through the app's own store.
async function seedInPage(S) {
  const { openDb } = await import('/write/app/db.js');
  const { createStore } = await import('/write/app/store.js');
  const { textToBlocks, blocksToText, countWords } = await import('/write/app/scene.js');
  const { hashText } = await import('/write/app/util.js');
  const db = await openDb();
  if (db.memory) throw new Error('IndexedDB unavailable');
  const store = createStore(db);
  async function addProject(P) {
    const p = await store.createProject(P.title);
    const ids = [];
    for (const C of P.chapters) {
      const ch = await store.addChapter(p.id, C.title);
      for (const Sc of C.scenes) {
        const sc = await store.addScene(ch.id, Sc.title);
        const blocks = textToBlocks(Sc.text, []);
        await store.saveScene({ id: sc.id, blocks, wordCount: countWords(Sc.text) });
        ids.push(sc.id);
      }
    }
    return { p, ids };
  }
  const a = await addProject(S.A);
  const b = await addProject(S.B);
  // Largest scene of A gets 20 versions.
  let largest = null;
  for (const id of a.ids) { const s = await store.getScene(id); if (!largest || s.wordCount > largest.wordCount) largest = s; }
  let text = blocksToText(largest.blocks);
  for (const tail of S.versionTails) {
    text += '\n\n' + tail;
    const cur = await store.getScene(largest.id);
    await store.saveSceneWithVersion({ id: largest.id, blocks: textToBlocks(text, cur.blocks), wordCount: countWords(text) }, { reason: 'replace' });
  }
  // Summaries on every scene of A except the last 3 (outline order).
  for (let i = 0; i < a.ids.length - 3; i++) {
    const s = await store.getScene(a.ids[i]);
    await store.patchScene(s.id, { summary: s.title + ': ' + blocksToText(s.blocks).split('. ').slice(0, 2).join('. ') + '.',
      summaryHash: hashText(blocksToText(s.blocks)), summaryUpdatedAt: Date.now(), summaryModel: 'other/util' });
  }
  const thread = await store.getThread(a.p);
  thread.messages = S.messages.map((m, i) => m.role === 'user'
    ? { id: 'm' + i, role: 'user', display: m.text, content: m.text, attachments: [] }
    : { id: 'm' + i, role: 'assistant', content: m.text, thinking: '', thinkMs: 0 });
  thread.updatedAt = Date.now();
  await store.saveThread(a.p.id, thread);
  const bible = await store.getBible(a.p);
  bible.brief = 'A long book about a coastal town.';
  bible.cards = S.cards.map((c, i) => Object.assign({ id: 'card' + i, aliases: [], status: 'approved', source: null, createdAt: Date.now(), updatedAt: Date.now() }, c));
  await store.saveBible(a.p.id, bible);
  const fin = await store.getScene(largest.id);
  const versions = await store.listVersions(largest.id);
  const total = (await store.listProjects()).find((p) => p.id === a.p.id).stats.words;
  return { pidA: a.p.id, pidB: b.p.id, titleA: a.p.title, largestId: fin.id, largestTitle: fin.title, largestBlocks: fin.blocks.length,
    lastId: a.ids[a.ids.length - 1], versions: versions.length, words: total, scenes: a.ids.length };
}

const MARKED_STUB = `window.marked = { parse: function(src){
  function esc(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function inline(s){ return esc(s).replace(/\\*\\*([^*]+)\\*\\*/g,'<strong>$1</strong>').replace(/\\*([^*]+)\\*/g,'<em>$1</em>').replace(/\x60([^\x60]+)\x60/g,'<code>$1</code>'); }
  return String(src).split(/\\n{2,}/).map(function(b){
    var lines = b.split('\\n');
    if(lines.every(function(l){ return /^[-*] /.test(l); })) return '<ul>' + lines.map(function(l){ return '<li>' + inline(l.slice(2)) + '</li>'; }).join('') + '</ul>';
    var h = /^(#{1,6}) (.*)$/.exec(b);
    if(h) return '<h' + h[1].length + '>' + inline(h[2]) + '</h' + h[1].length + '>';
    return '<p>' + lines.map(inline).join('<br>') + '</p>';
  }).join('\\n');
} };`;
const PURIFY_STUB = `window.DOMPurify = { sanitize: function(html){
  var t = document.createElement('template'); t.innerHTML = html;
  t.content.querySelectorAll('*').forEach(function(el){
    if(/^(script|style|iframe|object)$/i.test(el.tagName)){ el.remove(); return; }
    Array.from(el.attributes).forEach(function(a){ if(/^on/i.test(a.name) || /^\\s*javascript:/i.test(a.value)) el.removeAttribute(a.name); });
  });
  return t.innerHTML;
} };`;

const pageErrors = [];
const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

async function run(browser, BASE) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  const page = await ctx.newPage();
  if (CPU_RATE > 1) { const cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_RATE }); }
  const errors = pageErrors;
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('dialog', (d) => d.accept());
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.fulfill({ status: 404, body: '' }));
  await ctx.route('https://cdn.jsdelivr.net/**', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
  // Local stand-ins for marked and DOMPurify so chat history costs roughly what the real libraries cost:
  // a small Markdown pass, then a DOM parse and walk of the HTML.
  await ctx.route('https://cdn.jsdelivr.net/npm/marked@*/**', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: MARKED_STUB }));
  await ctx.route('https://cdn.jsdelivr.net/npm/dompurify@*/**', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: PURIFY_STUB }));
  await ctx.route('https://cdn.jsdelivr.net/npm/fflate@0.8.2/**', (r) => r.fulfill({ status: 200, headers: { 'Content-Type': 'application/javascript', 'Access-Control-Allow-Origin': '*' }, body: fs.readFileSync(SHIM, 'utf8') }));
  let apiCalls = 0;
  await ctx.route('**/api/v1/chat/completions', async (r) => {
    apiCalls++;
    const d = (o) => 'data: ' + JSON.stringify(o) + '\n\n';
    try { await r.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': '*' }, body: d({ choices: [{ delta: { content: 'Ok.' } }] }) + 'data: [DONE]\n\n' }); } catch (e) { /* aborted */ }
  });
  await page.addInitScript((s) => {
    if (!localStorage.getItem('perf.seeded')) {
      localStorage.setItem('ownchat.write.settings.v1', JSON.stringify(s));
      localStorage.setItem('perf.seeded', '1');
    }
  }, SETTINGS);

  // ---- Seed ----
  const tSeed = Date.now();
  await page.goto(BASE + '/__blank');
  const info = await page.evaluate(seedInPage, buildSeed());
  console.log(`Seeded in ${Date.now() - tSeed} ms: project A ${info.scenes} scenes, ${info.words.toLocaleString()} words; largest scene "${info.largestTitle}" (${info.largestBlocks} blocks, ${info.versions} versions)`);

  await page.goto(BASE + '/write/#/library');
  await page.waitForSelector('html[data-ready="1"]', { timeout: 20000 });
  await page.waitForTimeout(500);

  // Sets location.hash (or clicks a selector) and resolves with the ms until cond() holds.
  const timeNav = (trigger, cond, arg) => page.evaluate(({ trigger, cond, arg }) => new Promise((resolve, reject) => {
    const test = new Function('arg', 'return (' + cond + ')(arg);');
    let done = false;
    const t0 = performance.now();
    const check = () => {
      if (done) return;
      let ok = false;
      try { ok = test(arg); } catch (e) { ok = false; }
      if (ok) { done = true; mo.disconnect(); clearInterval(iv); clearTimeout(to); resolve(performance.now() - t0); }
    };
    const mo = new MutationObserver(check);
    mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    const iv = setInterval(check, 4);
    const to = setTimeout(() => { done = true; mo.disconnect(); clearInterval(iv); reject(new Error('timeout waiting for ' + cond + ' state ' + JSON.stringify({ v: document.body.dataset.view, h: location.hash, rows: document.querySelectorAll('#outlineList .scene-row').length, t: (document.getElementById('hdrTitle') || {}).textContent, toast: (document.getElementById('toast') || {}).textContent }))); }, 15000);
    if (trigger.hash != null) location.hash = trigger.hash;
    else document.querySelector(trigger.click).click();
  }), { trigger, cond: cond.toString(), arg });
  const settle = (ms = 250) => page.waitForTimeout(ms);
  const goHash = async (hash, cond, arg) => { await timeNav({ hash }, cond, arg); await settle(); };

  const C = {
    library: () => document.body.dataset.view === 'library' && document.querySelectorAll('#projectList .project-row').length >= 2,
    outline: (a) => document.body.dataset.view === 'outline' && document.querySelectorAll('#outlineList .scene-row').length === a.n && document.getElementById('hdrTitle').textContent === a.title,
    scene: (a) => document.body.dataset.view === 'scene' && document.getElementById('sceneTitle').value === a.title && document.getElementById('viewScene').getAttribute('data-mode') === 'blocks' && document.querySelectorAll('#blockList .block').length === a.blocks,
    write: () => document.getElementById('viewScene').getAttribute('data-mode') === 'write' && document.getElementById('sceneText').value.length > 1000 && document.getElementById('sceneText').offsetHeight > 0,
    blocks: (a) => document.getElementById('viewScene').getAttribute('data-mode') === 'blocks' && document.querySelectorAll('#blockList .block').length >= a.blocks,
    sceneChat: () => document.body.dataset.view === 'chat' && document.querySelector('#chatScopeScene.on') && !document.getElementById('ctxMeter').hidden && /scenes? so far/.test(document.getElementById('ctxMeterText').textContent),
    projectChat: (a) => document.body.dataset.view === 'chat' && document.querySelector('#chatScopeProject.on') && document.getElementById('list').children.length >= a.min,
  };
  const A = { n: info.scenes, title: info.titleA }, Bo = { n: 6, title: 'Short Book' };
  const SC = { title: info.largestTitle, blocks: info.largestBlocks };
  const rows = [];
  const add = (step, samples, budget, unit = 'ms', note = '') => rows.push({ step, samples, value: median(samples), budget, unit, note });

  // Library open (from A's outline).
  let s = [];
  for (let i = 0; i < RUNS; i++) { await goHash('#/p/' + info.pidA + '', C.outline, A); s.push(await timeNav({ hash: '#/library' }, C.library)); await settle(); }
  add('library open', s, NAV_BUDGET);

  // Outline open of A, coming from the library with project B open (A is not the open project).
  s = [];
  for (let i = 0; i < RUNS; i++) {
    await goHash('#/p/' + info.pidB + '', C.outline, Bo);
    await goHash('#/library', C.library);
    s.push(await timeNav({ hash: '#/p/' + info.pidA + '' }, C.outline, A)); await settle();
  }
  add('outline open (switch project)', s, NAV_BUDGET);
  // Outline open of A while A is already open (library -> outline).
  s = [];
  for (let i = 0; i < RUNS; i++) { await goHash('#/library', C.library); s.push(await timeNav({ hash: '#/p/' + info.pidA + '' }, C.outline, A)); await settle(); }
  add('outline open (same project)', s, NAV_BUDGET);

  // Largest scene, blocks surface.
  s = [];
  for (let i = 0; i < RUNS; i++) { await goHash('#/p/' + info.pidA + '', C.outline, A); s.push(await timeNav({ hash: '#/s/' + info.largestId }, C.scene, SC)); await settle(); }
  add('largest scene open (blocks)', s, NAV_BUDGET);

  // Write mode and back.
  const sw = [], sb = [];
  for (let i = 0; i < RUNS; i++) {
    sw.push(await timeNav({ click: '#hdrMode' }, C.write)); await settle();
    sb.push(await timeNav({ click: '#hdrMode' }, C.blocks, SC)); await settle();
  }
  add('switch to Write', sw, NAV_BUDGET);
  add('switch back to Blocks', sb, NAV_BUDGET);

  // Typing in Write mode: 30 input events, long tasks observed through the debounced save.
  await timeNav({ click: '#hdrMode' }, C.write); await settle(400);
  const lt = [], ltCount = [], handler = [];
  for (let i = 0; i < RUNS; i++) {
    const r = await page.evaluate(() => new Promise((resolve) => {
      const ta = document.getElementById('sceneText');
      const entries = [];
      const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) entries.push(e.duration); });
      try { po.observe({ type: 'longtask', buffered: false }); } catch (e) { po.observe({ entryTypes: ['longtask'] }); }
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      let n = 0, maxHandler = 0;
      const step = () => {
        ta.value += n % 6 === 5 ? ' ' : 'abcde'[n % 5];
        const t0 = performance.now();
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        maxHandler = Math.max(maxHandler, performance.now() - t0);
        if (++n < 30) setTimeout(step, 35);
        else setTimeout(() => { // past the 700 ms debounce: the save is included
          const wait = () => document.getElementById('sceneSaved').textContent === 'Saved' ? setTimeout(() => { po.disconnect(); resolve({ entries, maxHandler }); }, 150) : setTimeout(wait, 20);
          wait();
        }, 800);
      };
      step();
    }));
    lt.push(r.entries.length ? Math.max(...r.entries) : 0);
    ltCount.push(r.entries.length);
    handler.push(r.maxHandler);
  }
  add('typing: max long task', lt, LONGTASK_BUDGET, 'ms', 'long tasks per run: ' + ltCount.join('/'));
  add('typing: max input handler', handler, LONGTASK_BUDGET);
  await timeNav({ click: '#hdrMode' }, C.blocks, SC); await settle(400);

  // Scene chat of the last scene (story-so-far layer), from A's outline.
  s = [];
  let meter = '';
  for (let i = 0; i < RUNS; i++) {
    await goHash('#/p/' + info.pidA + '', C.outline, A);
    s.push(await timeNav({ hash: '#/s/' + info.lastId + '/chat' }, C.sceneChat)); await settle();
    meter = await page.textContent('#ctxMeterText');
  }
  add('scene chat open (last scene)', s, NAV_BUDGET, 'ms', 'meter: ' + meter.trim());

  // Project chat with the 150-message history, from the scene chat (thread switch re-renders history).
  s = [];
  const PC = { min: 60 };
  let rendered = 0;
  for (let i = 0; i < RUNS; i++) {
    await goHash('#/s/' + info.lastId + '/chat', C.sceneChat);
    s.push(await timeNav({ hash: '#/p/' + info.pidA + '/chat' }, C.projectChat, PC)); await settle();
    rendered = await page.evaluate(() => document.getElementById('list').children.length);
  }
  add('project chat open (150 messages)', s, NAV_BUDGET, 'ms', 'rendered rows: ' + rendered);

  // Bundle export from the library menu: click "Export bundle" -> download event.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ownchat-perf-'));
  const bundlePath = path.join(dir, 'a.ownchat.zip');
  s = [];
  for (let i = 0; i < RUNS; i++) {
    await goHash('#/library', C.library);
    await page.click('#projectList .project-row[data-id="' + info.pidA + '"] .row-menu, #projectList .project-row[data-id="' + info.pidA + '"] [aria-label="Project actions"]');
    await page.waitForSelector('#menuOverlay.open');
    const t0 = Date.now();
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.click('#menuItems [data-act="bundle"]')]);
    s.push(Date.now() - t0);
    await dl.saveAs(bundlePath);
    await settle(400);
  }
  add('bundle export', s, IO_BUDGET, 'ms', (fs.statSync(bundlePath).size / 1024).toFixed(0) + ' KB');

  // Import of that bundle as a copy: file chosen -> menu -> "Import as a copy" -> outline rendered.
  s = [];
  for (let i = 0; i < RUNS; i++) {
    await goHash('#/library', C.library);
    const t0 = Date.now();
    await page.setInputFiles('#bundleInput', bundlePath);
    await page.waitForSelector('#menuOverlay.open', { timeout: 15000 });
    const tRead = Date.now() - t0;
    const tCopy = await timeNav({ click: '#menuItems [data-act="copy"]' }, (a) => document.body.dataset.view === 'outline' && !location.hash.includes(a.pid) && document.querySelectorAll('#outlineList .scene-row').length === a.n, { pid: info.pidA, n: info.scenes });
    s.push(tRead + tCopy);
    await settle(400);
  }
  add('bundle import (copy)', s, IO_BUDGET);

  // Library again, now holding the three imported copies as well (~460k words in 5 projects).
  s = [];
  for (let i = 0; i < RUNS; i++) { await goHash('#/p/' + info.pidA, C.outline, A); s.push(await timeNav({ hash: '#/library' }, () => document.body.dataset.view === 'library' && document.querySelectorAll('#projectList .project-row').length >= 5)); await settle(); }
  add('library open (5 projects)', s, NAV_BUDGET);
  fs.rmSync(dir, { recursive: true, force: true });

  // Store-level breakdown on the live database (informational).
  const breakdown = await page.evaluate(async ({ pidA, largestId }) => {
    const { openDb } = await import('/write/app/db.js');
    const { createStore } = await import('/write/app/store.js');
    const st = createStore(await openDb());
    const out = {};
    const t = async (k, fn) => { const xs = []; for (let i = 0; i < 3; i++) { const t0 = performance.now(); await fn(); xs.push(performance.now() - t0); } xs.sort((a, b) => a - b); out[k] = xs[1]; };
    await t('store.listProjects (5 projects)', () => st.listProjects());
    await t('store.getOutline(A)', () => st.getOutline(pidA));
    await t('store.listSceneSummaries(A)', () => st.listSceneSummaries(pidA));
    await t('store.getScene(largest)', () => st.getScene(largestId));
    await t('store.listVersions(largest)', () => st.listVersions(largestId));
    await t('store.loadProjectData(A)', () => st.loadProjectData(pidA));
    return out;
  }, info);

  return { rows, breakdown, errors, apiCalls };
}

function report(res) {
  const pad = (s, n) => String(s).padEnd(n);
  const lpad = (s, n) => String(s).padStart(n);
  console.log('\nCPU slowdown: ' + CPU_RATE + 'x');
  console.log(pad('step', 36) + lpad('median', 9) + lpad('budget', 9) + '  status  runs / note');
  console.log('-'.repeat(100));
  let bad = 0;
  for (const r of res.rows) {
    const status = r.value <= r.budget ? 'OK' : 'OVER';
    if (r.value > 2 * r.budget) bad++;
    console.log(pad(r.step, 36) + lpad(r.value.toFixed(0), 9) + lpad(r.budget, 9) + '  ' + pad(status, 6) + '  ' + r.samples.map((x) => x.toFixed(0)).join('/') + (r.note ? '  ' + r.note : ''));
  }
  console.log('\nstore calls (median ms):');
  for (const k of Object.keys(res.breakdown)) console.log('  ' + pad(k, 34) + lpad(res.breakdown[k].toFixed(1), 8));
  if (res.errors.length) console.log('\npage errors:', JSON.stringify(res.errors).slice(0, 800));
  console.log('\nOpenRouter requests (mocked): ' + res.apiCalls);
  return bad;
}

(async () => {
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const BASE = 'http://127.0.0.1:' + server.address().port;
  let browser, code = 0;
  const t0 = Date.now();
  try {
    browser = await chromium.launch();
    const res = await run(browser, BASE);
    const bad = report(res);
    if (bad) { console.log(`\n${bad} step(s) above twice their budget`); code = 1; }
  } catch (e) { console.error(e); if (pageErrors.length) console.error('page errors:', JSON.stringify(pageErrors).slice(0, 1500)); code = 1; }
  finally { if (browser) await browser.close().catch(() => {}); await new Promise((res) => server.close(res)); }
  console.log(`\nTotal ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  process.exit(code);
})();
