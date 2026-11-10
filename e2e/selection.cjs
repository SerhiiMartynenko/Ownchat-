// Selection-aware chat browser check for the writing app: the chat sees the whole scene with the editor's
// selection marked in place, the selection chip, message notes and tags, Blocks and Write mode, phone and
// split layouts. Usage: npm run e2e (Playwright + Chromium). Own static server; OpenRouter is mocked.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

let chromium;
try { ({ chromium } = require('playwright')); } catch (e1) {
  try { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); } catch (e2) {
    console.error('Needs Playwright with Chromium.'); process.exit(2);
  }
}

const ROOT = path.resolve(__dirname, '..');
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



const SETTINGS = { apiKey: 'k', model: 'test/main-model', utilityModel: 'test/utility-model', thinking: 'off', system: '', endpoint: '', editorMode: 'write' };
const P = [
  'The rain had not stopped for three days, and the river was rising past the old stone markers by the mill.',
  'Anna walked the bank at dusk with a lantern, listening for the bell that warned of the flood gates opening upstream.',
  'Her brother had promised to meet her at the bridge, but the bridge was empty and the water was loud.',
  'She waited until the lantern burned low and the cold reached her fingers through the wool of her gloves.',
  'In the morning the river had taken the bridge, and nobody in the village spoke his name again.'
];
const NOTE = '(The author has selected the passage between [[SELECTION]] and [[/SELECTION]] in the editor.';
const wc = (s) => s.split(/\s+/).filter(Boolean).length;

async function run(browser) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  const answers = [];
  page.on('dialog', d => { if (d.type() === 'prompt') d.accept(answers.length ? answers.shift() : ''); else d.accept(); });
  await ctx.route('https://cdn.jsdelivr.net/**', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));

  // ---- OpenRouter mock: every chat request is captured; digests and folds get an empty-ish reply ----
  const reqs = [];
  const partsText = (c) => typeof c === 'string' ? c : (c || []).map(p => p.text).join('\n');
  const sysText = (b) => b.messages.filter(m => m.role === 'system').map(m => partsText(m.content)).join('\n');
  const lastUser = (b) => partsText(b.messages[b.messages.length - 1].content);
  const isChat = (q) => { const s = sysText(q.body); return !s.includes('digest of one scene') && !s.includes('running summary of a conversation'); };
  await ctx.route('**/api/v1/chat/completions', async r => {
    const body = JSON.parse(r.request().postData());
    reqs.push({ body, headers: r.request().headers() });
    const sys = sysText(body);
    const reply = sys.includes('digest of one scene') ? 'A scene summary.\n\n### Proposed facts\n- none' : 'Reply ok';
    const d = o => 'data: ' + JSON.stringify(o) + '\n\n';
    const sse = d({ choices: [{ delta: { content: reply } }] }) + 'data: [DONE]\n\n';
    try { await r.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': '*' }, body: sse }); } catch (e) { /* aborted */ }
  });

  const idbDump = () => page.evaluate(() => new Promise((res, rej) => {
    const r = indexedDB.open('ownchat-write');
    r.onerror = () => rej(r.error);
    r.onsuccess = async () => {
      const db = r.result, out = { stores: Array.from(db.objectStoreNames).sort(), data: {} };
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
  const hash = () => page.evaluate(() => location.hash);
  const toastHas = async (t, ms = 4000) => { try { await page.waitForFunction((t) => (document.getElementById('toast').textContent || '').includes(t), t, { timeout: ms }); return true; } catch (e) { return false; } };
  const poll = async (fn, ms = 4000) => { const t0 = Date.now(); let v; while (Date.now() - t0 < ms) { v = await fn(); if (v) return v; await page.waitForTimeout(150); } return v; };
  const chipText = () => page.evaluate(() => { const c = document.getElementById('selChip'); return c.hidden ? null : document.getElementById('selChipText').textContent; });
  const waitChip = async (want, ms = 3000) => { try { await page.waitForFunction((w) => { const c = document.getElementById('selChip'); const t = c.hidden ? null : document.getElementById('selChipText').textContent; return t === w; }, want, { timeout: ms }); } catch (e) {} return chipText(); };
  const sendAndWait = async (text) => {
    const n = reqs.filter(isChat).length;
    await page.fill('#input', text);
    await page.click('#send');
    await page.waitForFunction(() => !document.querySelector('#send.stop'), null, { timeout: 8000 });
    await poll(async () => reqs.filter(isChat).length > n, 3000);
    await page.waitForTimeout(300);
    const chats = reqs.filter(isChat);
    return chats[chats.length - 1];
  };
  const writeSelect = (a, b) => page.evaluate(([a, b]) => { const t = document.getElementById('sceneText'); t.focus(); t.setSelectionRange(a, b); document.dispatchEvent(new Event('selectionchange')); }, [a, b]);
  const setMode = async (m) => {
    if ((await page.getAttribute('#viewScene', 'data-mode')) !== m) await page.click('#hdrMode');
    await page.waitForFunction((m) => document.getElementById('viewScene').getAttribute('data-mode') === m, m, { timeout: 3000 });
  };
  const lastAsst = () => page.locator('.msg.assistant').last();
  const sceneRec = async (id) => (await idbDump()).data.scenes.find(s => s.id === id);

  // ---- Setup: a project with one scene of 5 paragraphs ----
  await page.goto(BASE + '/write/');
  await ready();
  if ((await view()) !== 'library') { await page.click('#hdrBack'); await waitView('library'); }
  answers.push('River');
  if (await page.isVisible('#libraryNew')) await page.click('#libraryNew'); else await page.click('#hdrNewProject');
  await waitView('outline');
  answers.push('Chapter One');
  await page.click('#outlineEmptyAdd'); await page.waitForSelector('.chapter');
  answers.push('Flood');
  await page.click('.chapter .add-scene'); await page.waitForSelector('.scene-row');
  await page.locator('.scene-row', { hasText: 'Flood' }).first().click(); await waitView('scene');
  const sceneId = decodeURIComponent((await hash()).split('/')[2]);
  await page.fill('#sceneText', P.join('\n\n'));
  await poll(async () => { const s = await sceneRec(sceneId); return s && s.wordCount === wc(P.join(' ')); }, 5000);
  await page.waitForFunction(() => document.getElementById('sceneSaved').textContent === 'Saved', null, { timeout: 3000 }).catch(() => {});
  check('setup: scene saved with 5 paragraphs', ((await sceneRec(sceneId)) || { blocks: [] }).blocks.length === 5);

  // ---- A. Blocks selection of paragraphs 2–3, then the scene chat ----
  await setMode('blocks');
  await page.locator('#blockList .block').nth(1).locator('.block-handle').click();
  await page.locator('#blockList .block').nth(2).locator('.block-handle').click();
  check('A. two paragraphs selected in the editor', await page.locator('#blockList .block.selected').count() === 2);
  await page.click('#hdrChat'); await waitView('chat');
  check('A. chip says "Selection: 2 paragraphs · On"', (await waitChip('Selection: 2 paragraphs · On')) === 'Selection: 2 paragraphs · On', await chipText());
  check('A. scene chip stays hidden in the scene chat', !(await page.isVisible('#sceneChip')));
  let r = await sendAndWait('make this darker');
  let st = r ? sysText(r.body) : '';
  check('A. system text has all 5 paragraphs', !!r && P.every(p => st.includes(p)), st.slice(0, 800));
  check('A. [[SELECTION]] right before paragraph 2', st.includes(P[0] + '\n\n[[SELECTION]]' + P[1]), st.slice(0, 800));
  check('A. [[/SELECTION]] right after paragraph 3', st.includes(P[2] + '[[/SELECTION]]\n\n' + P[3]));
  const bodyA = st.slice(st.indexOf(NOTE) + NOTE.length);
  const noteEnd = bodyA.indexOf('\n');
  check('A. one pair of markers in the scene body (besides the note)', bodyA.slice(noteEnd).split('[[SELECTION]]').length === 2 && bodyA.slice(noteEnd).split('[[/SELECTION]]').length === 2, bodyA.slice(0, 300));
  check('A. the note line is present', st.includes('## Current scene: Flood\n' + NOTE));
  const ut = r ? lastUser(r.body) : '';
  check('A. last user message starts with the selection note and ends with the text', ut.startsWith('[The author had paragraphs 2–3 of the current scene selected: "') && ut.endsWith('"]\n\nmake this darker'), ut);
  check('A. the note quotes the start and end of the selection, not all of it', ut.includes('Anna walked the bank') && ut.includes('…') && ut.includes('the water was loud.') && !ut.includes(P[1]), ut);
  const userMsg = page.locator('.msg.user').last();
  check('A. bubble shows the tag', (await userMsg.locator('.msg-sel').textContent()) === 'Selection · paragraphs 2–3', await userMsg.locator('.msg-sel').textContent().catch(() => null));
  check('A. bubble text is the typed text only', (await userMsg.locator('.bubble').textContent()) === 'make this darker');
  let th = await poll(async () => (await idbDump()).data.threads.find(t => t.id === 'ts-' + sceneId && t.messages.length >= 2));
  const m0 = th && th.messages[0];
  check('A. stored message has selection', !!m0 && !!m0.selection && m0.selection.label === 'paragraphs 2–3' && m0.selection.paraFrom === 2 && m0.selection.paraTo === 3 && m0.selection.paraCount === 5 && m0.selection.partial === false && typeof m0.selection.excerpt === 'string' && m0.display === 'make this darker', m0);
  await page.screenshot({ path: OUT + 'selection-phone-chat.png' });
  await page.click('#ctxMeter'); await page.waitForSelector('#ctxOverlay.open');
  const sceneRow = await page.locator('#ctxLayers li.layer-row').nth(3).innerText();
  check('A. context sheet scene row says selection marked', /Current scene/.test(sceneRow) && /selection marked/.test(sceneRow), sceneRow);
  await page.click('#ctxClose');

  // ---- B. Chip off ----
  await page.click('#selChip');
  check('B. chip says Off', (await waitChip('Selection: 2 paragraphs · Off')) === 'Selection: 2 paragraphs · Off', await chipText());
  r = await sendAndWait('and again');
  st = r ? sysText(r.body) : '';
  check('B. no markers and no note in the request', !!r && !st.includes('[[SELECTION]]') && !st.includes('[[/SELECTION]]') && !st.includes(NOTE) && st.includes(P[1]), st.slice(0, 400));
  check('B. no note prefix on the message', !!r && lastUser(r.body) === 'and again', r && lastUser(r.body));
  check('B. no tag on that bubble', await page.locator('.msg.user').last().locator('.msg-sel').count() === 0);
  th = await poll(async () => (await idbDump()).data.threads.find(t => t.id === 'ts-' + sceneId && t.messages.length >= 4));
  check('B. stored message without selection', !!th && !('selection' in th.messages[2]), th && th.messages[2]);

  // ---- C. To scene -> Replace selection ----
  await page.waitForFunction(() => { const m = Array.from(document.querySelectorAll('.msg.assistant')).pop(); return m && m.querySelector('.act[data-a=scene]'); }, null, { timeout: 4000 }).catch(() => {});
  await lastAsst().locator('.act[data-a=scene]').click();
  await page.waitForSelector('#menuOverlay.open');
  const acts = await page.locator('#menuItems [data-act]').evaluateAll(els => els.map(e => e.getAttribute('data-act')));
  check('C. menu offers Replace selection first', acts.join() === 'selection,append,replace,cancel', acts);
  await menuPick('selection');
  check('C. replace toast', await toastHas('Replaced · version saved'));
  const sc = await poll(async () => { const s = await sceneRec(sceneId); return s && s.blocks.length === 4 && s; });
  check('C. paragraphs 2–3 replaced by the reply, 1, 4, 5 untouched', !!sc && sc.blocks.map(b => b.text).join('|') === [P[0], 'Reply ok', P[3], P[4]].join('|'), sc && sc.blocks.map(b => b.text));
  await waitView('scene');

  // ---- D. No selection ----
  await page.click('#hdrChat'); await waitView('chat');
  await page.waitForTimeout(200);
  check('D. chip hidden without a selection', (await chipText()) === null, await chipText());
  r = await sendAndWait('no selection now');
  st = r ? sysText(r.body) : '';
  check('D. request has no markers or note', !!r && !st.includes('[[SELECTION]]') && !st.includes(NOTE) && st.includes('Reply ok') && lastUser(r.body) === 'no selection now', st.slice(0, 300));

  // ---- E. Write mode: a span inside one sentence ----
  await page.click('#hdrBack'); await waitView('scene');
  await setMode('write');
  const span = 'the cold reached her fingers';
  const raw = await page.inputValue('#sceneText');
  const at = raw.indexOf(span);
  await writeSelect(at, at + span.length);
  await page.waitForTimeout(150);
  await page.click('#hdrChat'); await waitView('chat');
  check('E. chip says part of paragraph 3', (await waitChip('Selection: part of paragraph 3 · On')) === 'Selection: part of paragraph 3 · On', await chipText());
  r = await sendAndWait('tighten this');
  st = r ? sysText(r.body) : '';
  check('E. markers inline around exactly the span', st.includes('burned low and [[SELECTION]]' + span + '[[/SELECTION]] through the wool'), st.slice(0, 900));
  check('E. message note names part of paragraph 3', !!r && lastUser(r.body).startsWith('[The author had part of paragraph 3 of the current scene selected: "' + span + '"]\n\ntighten this'), r && lastUser(r.body));
  check('E. bubble tag', (await page.locator('.msg.user').last().locator('.msg-sel').textContent()) === 'Selection · part of paragraph 3');

  // ---- F. Split layout: the chip follows the editor without navigation ----
  await page.setViewportSize({ width: 1300, height: 800 });
  await page.waitForFunction(() => document.body.dataset.view === 'split', null, { timeout: 5000 }).catch(() => {});
  check('F. split view beside the editor', (await view()) === 'split', await view());
  const hashF = await hash();
  const raw2 = await page.inputValue('#sceneText');
  const p5 = raw2.indexOf(P[4]);
  await writeSelect(p5, p5 + P[4].length);
  check('F. selecting paragraph 4 updates the chip', (await waitChip('Selection: 1 paragraph · On')) === 'Selection: 1 paragraph · On', await chipText());
  await writeSelect(0, raw2.indexOf('Reply ok') + 'Reply ok'.length);
  check('F. selecting paragraphs 1–2 updates the chip', (await waitChip('Selection: 2 paragraphs · On')) === 'Selection: 2 paragraphs · On', await chipText());
  await page.click('#selChip');
  check('F. chip can be switched off', (await waitChip('Selection: 2 paragraphs · Off')) === 'Selection: 2 paragraphs · Off', await chipText());
  await writeSelect(0, P[0].indexOf(' river'));
  check('F. a new selection turns it back on', (await waitChip('Selection: part of paragraph 1 · On')) === 'Selection: part of paragraph 1 · On', await chipText());
  r = await sendAndWait('split check');
  st = r ? sysText(r.body) : '';
  check('F. split request marks the new selection', st.includes('## Current scene: Flood\n' + NOTE) && st.includes('[[SELECTION]]The rain had not stopped for three days, and the[[/SELECTION]] river'), st.slice(0, 700));
  await page.screenshot({ path: OUT + 'selection-split.png' });
  await writeSelect(5, 5);
  check('F. clearing the selection hides the chip', (await waitChip(null)) === null, await chipText());
  check('F. no navigation happened', (await hash()) === hashF, [hashF, await hash()]);

  // ---- G. Reload on the chat route keeps the tag ----
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(BASE + '/write/#/s/' + sceneId + '/chat');
  await page.reload(); await ready();
  await waitView('chat');
  const tags = await page.locator('.msg.user .msg-sel').allTextContents();
  check('G. bubbles keep their selection tags after a reload', tags.join('|') === ['Selection · paragraphs 2–3', 'Selection · part of paragraph 3', 'Selection · part of paragraph 1'].join('|'), tags);
  check('G. no selection chip after the reload (the editor is closed)', (await chipText()) === null, await chipText());
  const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  check('G. no horizontal scroll at 390 px', noOverflow);
  await page.screenshot({ path: OUT + 'selection-reload.png' });

  // ---- Headers and console ----
  const allowed = new Set(['authorization', 'content-type']);
  const normal = new Set(['accept', 'accept-encoding', 'accept-language', 'content-length', 'origin', 'referer', 'user-agent', 'host', 'connection', 'cache-control', 'pragma', 'priority']);
  const stray = [];
  for (const q of reqs) for (const k of Object.keys(q.headers)) { const l = k.toLowerCase(); if (!allowed.has(l) && !normal.has(l) && !/^(sec-|:)/.test(l)) stray.push(k); }
  check('only authorization and content-type custom headers on API requests', reqs.length > 0 && stray.length === 0, stray);
  check('no console errors / pageerrors', errors.length === 0, errors);
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
