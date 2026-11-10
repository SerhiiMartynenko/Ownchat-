// Phase 3 browser end-to-end check for the writing app: blocks editor, selection, AI actions with the
// preview sheet, versions, Write/Blocks mode toggle. Usage: npm run e2e (Playwright + Chromium).
// Starts its own static server for the repo root on an ephemeral port. OpenRouter is mocked.
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

const P = [
  'Mara crossed the bridge at dusk.',
  'The river below ran black and quick.',
  'She thought of Tomas and the unanswered letter.',
  'A lamp flickered in the tower window.'
];
const SETTINGS = { apiKey: 'k', model: 'other/x', thinking: 'max', system: '', endpoint: '', editorMode: 'blocks' };

async function run(browser) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
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
  let mockMode = 'rewrite';
  const sysText = (b) => { const c = b.messages[0] && b.messages[0].role === 'system' ? b.messages[0].content : ''; return typeof c === 'string' ? c : c.map(p => p.text).join('\n'); };
  const userText = (b) => { const m = b.messages[b.messages.length - 1]; return typeof m.content === 'string' ? m.content : m.content.map(p => p.text).join('\n'); };
  const targetOf = (b) => { const m = userText(b).match(/## Target\n([\s\S]*?)(?:\n\n## |$)/); return m ? m[1] : null; };
  const instrOf = (b) => { const m = userText(b).match(/## Instruction\n([\s\S]*)$/); return m ? m[1] : ''; };
  await ctx.route('**/api/v1/chat/completions', async r => {
    const body = JSON.parse(r.request().postData());
    reqs.push({ body, headers: r.request().headers() });
    const d = o => 'data: ' + JSON.stringify(o) + '\n\n';
    const editor = sysText(body).includes('Return ONLY the replacement prose');
    let reply = 'Reply ok';
    if (editor) {
      const t = targetOf(body);
      if (mockMode === 'chat') reply = "Sure! Here is what I'd suggest: you could try something more vivid here.";
      else if (t == null) reply = 'The lamp guttered.\n\nShe waited.';
      else reply = 'Rewritten: ' + t.trim().split(/(?<=[.!?])\s/)[0];
    }
    if (mockMode === 'slow') await new Promise(res => setTimeout(res, 1500));
    const n = 3, step = Math.ceil(reply.length / n);
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
  const scene = async () => { const d = await idbDump(); return d.data.scenes[0]; };
  const texts = (s) => (s.blocks || []).map(b => b.text);
  const sceneVersions = async () => { const d = await idbDump(); const sc = d.data.scenes[0]; return d.data.versions.filter(v => v.sceneId === sc.id).sort((a, b) => a.createdAt - b.createdAt); };
  const rowCount = () => page.locator('#blockList .block').count();
  const rowText = (i) => page.locator('#blockList .block').nth(i).locator('.block-text').textContent();
  const handle = (i) => page.locator('#blockList .block').nth(i).locator('.block-handle');
  const selCount = () => page.locator('#blockList .block.selected').count();
  const barShown = () => page.isVisible('#blockBar');
  const toastHas = async (t, ms = 4000) => { try { await page.waitForFunction((t) => (document.getElementById('toast').textContent || '').includes(t), t, { timeout: ms }); return true; } catch (e) { return false; } };
  const waitDone = async () => { await page.waitForSelector('#previewOverlay.open', { timeout: 5000 }); await page.waitForSelector('#previewStop', { state: 'hidden', timeout: 8000 }); await page.waitForTimeout(150); };
  const waitClosed = () => page.waitForSelector('#previewOverlay.open', { state: 'detached', timeout: 5000 }).catch(() => page.waitForFunction(() => !document.getElementById('previewOverlay').classList.contains('open'), null, { timeout: 5000 }));
  const waitSaved = async (pred, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const s = await scene(); if (s && pred(s)) return s; await page.waitForTimeout(150); } return scene(); };
  const lastReq = () => reqs[reqs.length - 1];
  const act = async (a) => { await page.click('#blockBar [data-act="' + a + '"]'); };
  const reject = async () => { await page.click('#previewReject'); await waitClosed(); };
  const clearSel = async () => { if (await barShown()) await page.click('#blockBarClose'); };
  const editRow = async (i, fn) => {
    await page.locator('#blockList .block').nth(i).locator('.block-text').click();
    const ta = page.locator('#blockList .block.editing textarea.block-edit');
    await ta.waitFor();
    return ta;
  };

  // ---- A. Setup ----
  await page.goto(BASE + '/write/');
  await ready();
  if ((await view()) !== 'library') { await page.click('#hdrBack'); await waitView('library'); }
  answers.push('Blocks Novel');
  if (await page.isVisible('#libraryNew')) await page.click('#libraryNew'); else await page.click('#hdrNewProject');
  await waitView('outline');
  answers.push('Chapter One');
  await page.click('#outlineEmptyAdd'); await page.waitForSelector('.chapter');
  answers.push('Bridge');
  await page.click('.chapter .add-scene'); await page.waitForSelector('.scene-row');
  await page.click('.scene-row'); await waitView('scene');
  check('A. scene view opens in blocks mode', (await page.getAttribute('#viewScene', 'data-mode')) === 'blocks');
  check('A. scene header set is exactly hdrBack,hdrChat,hdrMenu,hdrMode,openBible,openSettings', (await headerVisible()) === 'hdrBack,hdrChat,hdrMenu,hdrMode,openBible,openSettings', await headerVisible());
  check('A. #hdrMode reads "Write" in blocks mode', (await page.textContent('#hdrMode')).trim() === 'Write', await page.textContent('#hdrMode'));
  check('A. #blockList has no rows, only the footer', (await rowCount()) === 0 && (await page.locator('#blockList .block-footer').count()) === 1);
  check('A. #sceneText hidden in blocks mode', !(await page.isVisible('#sceneText')));

  // ---- B. Editing ----
  await page.click('#blockAdd');
  let ta = page.locator('#blockList .block.editing textarea.block-edit');
  await ta.waitFor();
  await ta.fill(P.join('\n\n'));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelectorAll('#blockList .block').length === 4, null, { timeout: 3000 }).catch(() => {});
  check('B. four paragraphs commit to 4 rows', (await rowCount()) === 4, await rowCount());
  check('B. row texts match', (await page.locator('#blockList .block .block-text').allTextContents()).join('|') === P.join('|'));
  try { await page.waitForFunction(() => document.getElementById('sceneSaved').textContent === 'Saved', null, { timeout: 3000 }); } catch (e) {}
  check('B. #sceneSaved reads "Saved" within 3 s', (await page.textContent('#sceneSaved')) === 'Saved', await page.textContent('#sceneSaved'));
  let sc = await waitSaved(s => s.blocks.length === 4);
  const ids0 = sc.blocks.map(b => b.id);
  check('B. IndexedDB scene has 4 blocks with unique ids', sc.blocks.length === 4 && new Set(ids0).size === 4 && ids0.every(Boolean), sc.blocks);
  check('B. IndexedDB block texts match', texts(sc).join('|') === P.join('|'), texts(sc));
  const shown = parseInt(await page.textContent('#sceneWords'), 10);
  check('B. wordCount matches #sceneWords', sc.wordCount === shown && shown > 0, [sc.wordCount, await page.textContent('#sceneWords')]);
  await page.reload(); await ready();
  check('B. reload keeps 4 rows in blocks mode', (await rowCount()) === 4 && (await page.getAttribute('#viewScene', 'data-mode')) === 'blocks', [await rowCount(), await view()]);
  await page.screenshot({ path: OUT + 'p3-blocks.png' });
  ta = await editRow(1);
  await ta.fill(P[1] + ' Cold air rose from it.');
  await page.keyboard.press('Escape');
  sc = await waitSaved(s => s.blocks[1] && s.blocks[1].text.endsWith('Cold air rose from it.'));
  const P1 = P[1] + ' Cold air rose from it.';
  check('B. edited row 2 updates the DOM', (await rowText(1)) === P1, await rowText(1));
  check('B. edited row 2 updates IndexedDB', sc.blocks[1].text === P1, texts(sc));
  check('B. block ids unchanged after the in-place edit', sc.blocks.map(b => b.id).join() === ids0.join(), [sc.blocks.map(b => b.id), ids0]);
  P[1] = P1;

  // ---- C. Selection ----
  await handle(1).click();
  check('C. handle 2 selects one row and shows the bar', (await selCount()) === 1 && (await barShown()));
  await handle(2).click();
  check('C. handle 3 extends the range to 2 rows', (await selCount()) === 2, await selCount());
  await handle(2).click();
  check('C. clicking the end handle shrinks to 1 row', (await selCount()) === 1, await selCount());
  await page.click('#blockBarClose');
  check('C. close clears selection and hides the bar', (await selCount()) === 0 && !(await barShown()));
  const box = await page.locator('#blockList .block').nth(0).locator('.block-text').boundingBox();
  await page.mouse.move(box.x + 20, box.y + box.height / 2);
  await page.mouse.down(); await page.waitForTimeout(600); await page.mouse.up();
  check('C. long-press selects row 1', (await selCount()) === 1 && (await page.locator('#blockList .block').nth(0).evaluate(e => e.classList.contains('selected'))) && (await barShown()), await selCount());
  await page.screenshot({ path: OUT + 'p3-selection.png' });
  await page.click('#blockBarClose');

  // ---- D. Rewrite with bible ----
  await page.click('#openBible');
  await page.waitForSelector('#bibleOverlay.open');
  await page.fill('#bibleStyle', 'Close third person, past tense.');
  await page.click('#bibleAddCard');
  await page.waitForSelector('#cardOverlay.open');
  await page.click('#cardType button[data-v=character]');
  await page.fill('#cardName', 'Tomas');
  await page.fill('#cardBody', 'Mara\'s estranged brother.');
  await page.click('#cardPin button[data-v=mention]');
  await page.click('#cardSave');
  await page.click('#bibleDone');
  await page.waitForTimeout(400);
  await handle(2).click();
  let n0 = reqs.length;
  mockMode = 'slow';
  await act('rewrite');
  await page.waitForSelector('#previewOverlay.open');
  const streamingSeen = await page.isVisible('#previewStop');
  const acceptDisabled = await page.locator('#previewAccept').isDisabled();
  check('D. while streaming Stop is visible and Accept disabled', streamingSeen && acceptDisabled, [streamingSeen, acceptDisabled]);
  // Progress line while no text has arrived yet (the slow mock waits 1500 ms before replying).
  const waitingSeen = await page.waitForFunction(() => /Waiting for the model… \d+s/.test(document.getElementById('previewStats').textContent || ''), null, { timeout: 1200, polling: 50 }).then(() => true, () => false);
  check('D. stats read "Waiting for the model… Ns" before the first words', waitingSeen && (await page.isVisible('#previewStop')), await page.textContent('#previewStats'));
  // "Thinking… Ns" (preview.noteReasoning) is not covered here: route.fulfill delivers the whole SSE body at
  // once, so the mock cannot send a reasoning delta, pause, then stream content; the preview API is module-private.
  await waitDone();
  mockMode = 'rewrite';
  let rq = lastReq();
  check('D. action request has no reasoning and max_tokens 16000 even with thinking "max"', !('reasoning' in rq.body) && rq.body.max_tokens === 16000, { reasoning: rq.body.reasoning, max_tokens: rq.body.max_tokens });
  check('D. one request sent', reqs.length === n0 + 1, reqs.length - n0);
  const st = sysText(rq.body), ut = userText(rq.body);
  check('D. exactly 2 messages (system + user), stream:true', rq.body.messages.length === 2 && rq.body.messages[0].role === 'system' && rq.body.messages[1].role === 'user' && rq.body.stream === true, rq.body.messages.map(m => m.role));
  check('D. system has sentinel, style guide and story bible with Tomas', st.includes('Return ONLY the replacement prose') && st.includes('## Style guide') && st.includes('Close third person') && st.includes('## Story bible') && st.includes('Tomas'), st.slice(0, 400));
  check('D. user text has before / target / after / instruction sections', ut.includes('## Text before\n' + P[0] + '\n\n' + P[1]) && ut.includes('## Target\n' + P[2]) && ut.includes('## Text after\n' + P[3]) && ut.includes('## Instruction'), ut);
  const hk = Object.keys(rq.headers).filter(k => !['authorization', 'content-type'].includes(k) && /^(x-|http-referer)/i.test(k));
  check('D. request has no stray custom headers', hk.length === 0 && !!rq.headers.authorization, hk);
  check('D. preview Accept reads "Accept"', (await page.textContent('#previewAccept')).trim() === 'Accept');
  check('D. diff shows span.ins and stats "n → m words"', (await page.locator('#previewBody span.ins').count()) > 0 && /\d+ → \d+ words/.test(await page.textContent('#previewStats')), await page.textContent('#previewStats'));
  check('D. no streaming caret after finish', (await page.locator('#previewBody .caret').count()) === 0);
  await page.screenshot({ path: OUT + 'p3-preview-diff.png' });
  await page.click('#previewDiffToggle');
  check('D. Diff toggle to clean removes spans', (await page.locator('#previewBody span.ins, #previewBody span.del').count()) === 0 && (await page.textContent('#previewDiffToggle')) === 'Diff');
  await page.click('#previewDiffToggle');
  check('D. toggle back to diff restores spans', (await page.locator('#previewBody span.ins').count()) > 0);
  await reject();
  sc = await scene();
  check('D. Reject leaves the scene unchanged and no versions', texts(sc).join('|') === P.join('|') && (await sceneVersions()).length === 0, texts(sc));
  check('D. selection kept after Reject', (await selCount()) === 1);
  await act('rewrite'); await waitDone();
  await page.click('#previewAccept');
  check('D. toast "Applied · version saved"', await toastHas('Applied · version saved'));
  await waitClosed();
  sc = await waitSaved(s => s.blocks[2] && s.blocks[2].text.startsWith('Rewritten:'));
  check('D. row 3 DOM starts with "Rewritten:"', (await rowText(2)).startsWith('Rewritten:'), await rowText(2));
  check('D. IndexedDB row 3 updated', sc.blocks[2].text.startsWith('Rewritten:'), texts(sc));
  let vs = await sceneVersions();
  check('D. exactly 1 version, reason rewrite, holds the OLD row 3', vs.length === 1 && vs[0].reason === 'rewrite' && vs[0].blocks[2].text === P[2], vs);
  check('D. selection cleared after Accept', (await selCount()) === 0 && !(await barShown()));
  const rw3 = sc.blocks[2].text;

  // ---- E. Anthropic variant ----
  const setModel = async (m) => {
    await page.evaluate((m) => { const k = 'ownchat.write.settings.v1'; const s = JSON.parse(localStorage.getItem(k)); s.model = m; localStorage.setItem(k, JSON.stringify(s)); }, m);
    await page.reload(); await ready();
  };
  await setModel('anthropic/x');
  await handle(0).click();
  await act('tighten'); await waitDone();
  rq = lastReq();
  const sc0 = rq.body.messages[0].content;
  check('E. anthropic system content is an array of <= 2 parts with cache_control', Array.isArray(sc0) && sc0.length >= 1 && sc0.length <= 2 && sc0.every(p => p.type === 'text' && p.cache_control), sc0);
  check('E. tighten instruction sent', /Tighten/.test(instrOf(rq.body)), instrOf(rq.body));
  check('E. request model is anthropic/x', rq.body.model === 'anthropic/x');
  check('E. anthropic action request has no reasoning and max_tokens 16000', !('reasoning' in rq.body) && rq.body.max_tokens === 16000, { reasoning: rq.body.reasoning, max_tokens: rq.body.max_tokens });
  await reject();
  await setModel('other/x');
  check('E. model restored to other/x', JSON.parse(await page.evaluate(() => localStorage.getItem('ownchat.write.settings.v1'))).model === 'other/x');

  // ---- F. Tone ----
  await handle(3).click();
  await act('tone');
  await page.waitForSelector('#menuOverlay.open');
  const toneActs = await page.locator('#menuItems [data-act]').evaluateAll(els => els.map(e => e.getAttribute('data-act')));
  const TONES = ['Darker', 'Lighter', 'More tense', 'More intimate', 'More lyrical', 'Plainer'];
  check('F. tone menu lists the six tones and __custom', TONES.every(t => toneActs.includes(t)) && toneActs.includes('__custom'), toneActs);
  await menuPick('Darker');
  await waitDone();
  check('F. request instruction contains "Darker"', instrOf(lastReq().body).includes('Darker'), instrOf(lastReq().body));
  check('F. preview title mentions the tone', /Darker/.test(await page.textContent('#previewTitle')), await page.textContent('#previewTitle'));
  await reject();
  await clearSel();

  // ---- G. Custom and Retry ----
  await handle(0).click();
  answers.push('Make it rain');
  await act('custom'); await waitDone();
  check('G. custom instruction sent verbatim', instrOf(lastReq().body).includes('Make it rain'), instrOf(lastReq().body));
  n0 = reqs.length;
  await page.fill('#previewInstruction', 'shorter');
  await page.click('#previewRetry');
  await page.waitForTimeout(200); await waitDone();
  check('G. Retry sends a second request containing "shorter"', reqs.length === n0 + 1 && instrOf(lastReq().body).includes('shorter') && instrOf(lastReq().body).includes('Make it rain'), instrOf(lastReq().body));
  await reject();
  await clearSel();

  // ---- H. Continue ----
  n0 = reqs.length;
  await page.click('#blockContinue');
  await waitDone();
  rq = lastReq();
  check('H. Continue request has no "## Target"', reqs.length === n0 + 1 && !userText(rq.body).includes('## Target') && userText(rq.body).includes('## Text before'), userText(rq.body).slice(0, 200));
  check('H. Accept reads "Insert", diff toggle hidden', (await page.textContent('#previewAccept')).trim() === 'Insert' && !(await page.isVisible('#previewDiffToggle')));
  check('H. stats read "+ n words"', /\+ \d+ words/.test(await page.textContent('#previewStats')), await page.textContent('#previewStats'));
  await page.click('#previewAccept');
  check('H. toast "Inserted · version saved"', await toastHas('Inserted · version saved'));
  sc = await waitSaved(s => s.blocks.length === 6);
  check('H. 6 rows, new rows last', (await rowCount()) === 6 && (await rowText(4)) === 'The lamp guttered.' && (await rowText(5)) === 'She waited.', await page.locator('#blockList .block .block-text').allTextContents());
  vs = await sceneVersions();
  check('H. version reason "continue" added', vs.length === 2 && vs[1].reason === 'continue', vs.map(v => v.reason));
  await handle(0).click();
  await act('continue'); await waitDone();
  await page.click('#previewAccept');
  sc = await waitSaved(s => s.blocks.length === 8);
  const all = await page.locator('#blockList .block .block-text').allTextContents();
  check('H. Continue with row 1 selected inserts after row 1 (8 rows)', all.length === 8 && all[0] === P[0] && all[1] === 'The lamp guttered.' && all[2] === 'She waited.' && all[3] === P[1], all);

  // ---- I. Chat-like reply ----
  mockMode = 'chat';
  await page.waitForTimeout(500);
  await handle(0).click();
  await act('rewrite'); await waitDone();
  check('I. #previewWarn shows the reply warning', (await page.isVisible('#previewWarn')) && (await page.textContent('#previewWarn')).includes('This looks like a reply, not prose. Retry or accept anyway.'), await page.textContent('#previewWarn'));
  await reject();
  await clearSel();
  mockMode = 'rewrite';

  // ---- J. Stop ----
  mockMode = 'slow';
  await handle(0).click();
  await act('rewrite');
  await page.waitForSelector('#previewOverlay.open');
  check('J. Stop visible while waiting', await page.isVisible('#previewStop'));
  await page.click('#previewStop');
  await page.waitForSelector('#previewStop', { state: 'hidden', timeout: 4000 });
  check('J. Stop hides and warn says "Stopped"', (await page.textContent('#previewWarn')).includes('Stopped'), await page.textContent('#previewWarn'));
  check('J. stopped before any text: body empty, no crossed-out original', (await page.locator('#previewBody .del').count()) === 0 && (await page.textContent('#previewBody')) === '', await page.textContent('#previewBody'));
  check('J. warn reads "Stopped before any text arrived. Retry."', (await page.isVisible('#previewWarn')) && (await page.textContent('#previewWarn')) === 'Stopped before any text arrived. Retry.', await page.textContent('#previewWarn'));
  check('J. Accept disabled, Diff toggle hidden, Retry visible', (await page.locator('#previewAccept').isDisabled()) && !(await page.isVisible('#previewDiffToggle')) && (await page.isVisible('#previewRetry')), [await page.locator('#previewAccept').isDisabled(), await page.isVisible('#previewDiffToggle'), await page.isVisible('#previewRetry')]);
  await reject();
  await clearSel();
  mockMode = 'rewrite';
  await page.waitForTimeout(1800);

  // ---- K. Sentence-level ----
  const nv = (await sceneVersions()).length;
  ta = await editRow(0);
  await ta.evaluate(el => el.setSelectionRange(0, 4));
  await page.waitForSelector('#blockBar', { state: 'visible', timeout: 3000 }).catch(() => {});
  check('K. selecting text in the textarea shows the bar', await barShown());
  await act('rewrite'); await waitDone();
  check('K. request ## Target is "Mara"', targetOf(lastReq().body) === 'Mara', targetOf(lastReq().body));
  await page.click('#previewAccept');
  check('K. toast "Applied · version saved"', await toastHas('Applied · version saved'));
  sc = await waitSaved(s => s.blocks[0].text.startsWith('Rewritten:'));
  check('K. row 1 begins "Rewritten:" and keeps "crossed the bridge"', sc.blocks[0].text.startsWith('Rewritten:') && sc.blocks[0].text.includes('crossed the bridge'), sc.blocks[0].text);
  check('K. DOM row 1 matches', (await rowText(0)) === sc.blocks[0].text, await rowText(0));
  vs = await sceneVersions();
  check('K. rewrite version count grew by 1', vs.length === nv + 1 && vs[vs.length - 1].reason === 'rewrite', vs.map(v => v.reason));
  await clearSel();

  // ---- L. Versions ----
  await page.click('#hdrMenu');
  await menuPick('save-version');
  check('L. save-version toast "Version saved"', await toastHas('Version saved'));
  await page.waitForTimeout(300);
  await page.click('#hdrMenu');
  await menuPick('save-version');
  check('L. second save-version toast "No changes since the last version"', await toastHas('No changes since the last version'));
  // The store skips the pre-restore snapshot when the current text equals the latest version, so make an edit first.
  ta = await editRow(3);
  await ta.fill(P[3] + ' Wind.');
  await page.keyboard.press('Escape');
  await page.click('#hdrMenu');
  await menuPick('versions');
  await page.waitForSelector('#versionsOverlay.open');
  await page.waitForSelector('#versionList .version-row');
  vs = await sceneVersions();
  const domIds = await page.locator('#versionList .version-row').evaluateAll(els => els.map(e => e.getAttribute('data-id')));
  const byId = Object.fromEntries(vs.map(v => [v.id, v]));
  const times = domIds.map(i => byId[i] && byId[i].createdAt);
  check('L. version rows equal IndexedDB versions for the scene', domIds.length === vs.length && domIds.every(i => byId[i]), [domIds.length, vs.length]);
  check('L. rows are newest first', times.every((t, i) => i === 0 || t <= times[i - 1]), times);
  check('L. rows show when / reason / words', (await page.locator('#versionList .version-row').first().locator('.version-when, .version-reason, .version-words').count()) === 3);
  await page.screenshot({ path: OUT + 'p3-versions.png' });
  const oldest = vs[0];
  check('L. oldest version is the first rewrite snapshot', oldest.reason === 'rewrite' && oldest.blocks[2].text === P[2], oldest);
  await page.locator('#versionList .version-row').last().click();
  await page.waitForSelector('#previewOverlay.open');
  check('L. tapping a row opens preview with Accept "Restore"', (await page.textContent('#previewAccept')).trim() === 'Restore', await page.textContent('#previewAccept'));
  await page.click('#previewAccept');
  check('L. restore toast', await toastHas('Restored · previous text saved as a version'));
  sc = await waitSaved(s => s.blocks.length === 4 && s.blocks[2].text === P[2]);
  check('L. row 3 is the original text again', (await rowText(2)) === P[2] && sc.blocks[2].text === P[2], await rowText(2));
  vs = await sceneVersions();
  check('L. a version with reason "restore" exists', vs.some(v => v.reason === 'restore' && v.blocks[3].text === P[3] + ' Wind.'), vs.map(v => v.reason));
  check('L. restored scene has 4 rows', (await rowCount()) === 4, await rowCount());

  // ---- M. Mode toggle ----
  await page.click('#hdrMode');
  await page.waitForFunction(() => document.getElementById('viewScene').getAttribute('data-mode') === 'write', null, { timeout: 3000 });
  sc = await scene();
  check('M. #hdrMode switches to write mode, reads "Blocks"', (await page.textContent('#hdrMode')).trim() === 'Blocks');
  check('M. #sceneText visible with paragraphs joined by blank lines', (await page.isVisible('#sceneText')) && (await page.inputValue('#sceneText')) === texts(sc).join('\n\n'), await page.inputValue('#sceneText'));
  check('M. block list hidden in write mode', !(await page.isVisible('#blockBar')) && !(await page.isVisible('#blockAdd')));
  await page.fill('#sceneText', (await page.inputValue('#sceneText')) + '\n\nFinal line.');
  sc = await waitSaved(s => s.blocks.length === 5, 5000);
  check('M. write-mode edit autosaves (5 blocks)', sc.blocks.length === 5 && (await page.textContent('#sceneSaved')) !== undefined, texts(sc));
  await page.click('#hdrMode');
  await page.waitForFunction(() => document.getElementById('viewScene').getAttribute('data-mode') === 'blocks', null, { timeout: 3000 });
  check('M. back to blocks: 5 rows, last is "Final line."', (await rowCount()) === 5 && (await rowText(4)) === 'Final line.', await rowCount());
  await page.reload(); await ready();
  check('M. reload keeps blocks mode (last mode persisted)', (await page.getAttribute('#viewScene', 'data-mode')) === 'blocks' && (await rowCount()) === 5);
  await page.click('#hdrMode');
  await page.waitForFunction(() => document.getElementById('viewScene').getAttribute('data-mode') === 'write');
  n0 = reqs.length;
  await page.click('#hdrMenu');
  await menuPick('continue');
  await waitDone();
  check('M. scene-menu Continue works in write mode (no Target)', reqs.length === n0 + 1 && !userText(lastReq().body).includes('## Target'));
  await page.click('#previewAccept');
  check('M. write-mode Insert toast', await toastHas('Inserted · version saved'));
  await page.waitForFunction(() => document.getElementById('sceneText').value.includes('The lamp guttered.'), null, { timeout: 4000 }).catch(() => {});
  check('M. textarea gains the inserted text', (await page.inputValue('#sceneText')).includes('The lamp guttered.'), await page.inputValue('#sceneText'));
  await page.click('#hdrMode');
  await page.waitForFunction(() => document.getElementById('viewScene').getAttribute('data-mode') === 'blocks');

  // ---- M2. Action bar in write mode ----
  const writeSelect = (a, b) => page.evaluate(([a, b]) => { const t = document.getElementById('sceneText'); t.focus(); t.setSelectionRange(a, b); document.dispatchEvent(new Event('selectionchange')); }, [a, b]);
  const taSel = () => page.evaluate(() => { const t = document.getElementById('sceneText'); return [t.selectionStart, t.selectionEnd]; });
  await page.click('#hdrMode');
  await page.waitForFunction(() => document.getElementById('viewScene').getAttribute('data-mode') === 'write');
  await page.waitForTimeout(200);
  check('M2. write mode: bar hidden without a selection', !(await barShown()));
  let raw = await page.inputValue('#sceneText');
  let paras = raw.split('\n\n');
  const pick = 'ran black and quick';
  const sa = raw.indexOf(paras[1]) + paras[1].indexOf(pick), sb = sa + pick.length;
  await writeSelect(sa, sb);
  await page.waitForSelector('#blockBar', { state: 'visible', timeout: 3000 }).catch(() => {});
  check('M2. selecting text in #sceneText shows #blockBar', await barShown());
  await page.screenshot({ path: OUT + 'p3-write-bar.png' });
  let nv2 = (await sceneVersions()).length;
  n0 = reqs.length;
  await act('rewrite'); await waitDone();
  rq = lastReq();
  const ut2 = userText(rq.body);
  check('M2. one request; target is exactly the selection', reqs.length === n0 + 1 && targetOf(rq.body) === pick, targetOf(rq.body));
  check('M2. window has the neighbours, not the far paragraphs', ut2.includes('## Text before\n' + paras[0] + '\n\nThe river below') && ut2.includes(paras[2]) && ut2.includes(paras[3]) && !ut2.includes(paras[4]) && !ut2.includes(paras[paras.length - 1]) && rq.body.messages.length === 2, ut2);
  check('M2. preview diff is against the selection (4 -> 5 words)', /4 → 5 words/.test(await page.textContent('#previewStats')), await page.textContent('#previewStats'));
  await page.click('#previewAccept');
  check('M2. toast "Applied · version saved"', await toastHas('Applied · version saved'));
  await waitClosed();
  const expected = raw.slice(0, sa) + 'Rewritten: ' + pick + raw.slice(sb);
  check('M2. #sceneText is the spliced text', (await page.inputValue('#sceneText')) === expected, await page.inputValue('#sceneText'));
  sc = await waitSaved(s => texts(s).join('\n\n') === expected);
  check('M2. IndexedDB blocks match the spliced text', texts(sc).join('\n\n') === expected, texts(sc));
  vs = await sceneVersions();
  check('M2. one version added (reason rewrite) and the bar is hidden', vs.length === nv2 + 1 && vs[vs.length - 1].reason === 'rewrite' && !(await barShown()), [vs.length, nv2, await barShown()]);
  // Close button collapses the selection.
  raw = await page.inputValue('#sceneText');
  await writeSelect(0, 4);
  await page.waitForSelector('#blockBar', { state: 'visible', timeout: 3000 }).catch(() => {});
  await page.click('#blockBarClose');
  const cs2 = await taSel();
  check('M2. close collapses the selection and hides the bar', cs2[0] === cs2[1] && !(await barShown()), [cs2, await barShown()]);
  // Continue from the bar inserts after the paragraph holding the selection end.
  paras = raw.split('\n\n');
  await writeSelect(5, 12);
  await page.waitForSelector('#blockBar', { state: 'visible', timeout: 3000 }).catch(() => {});
  n0 = reqs.length;
  await act('continue'); await waitDone();
  const ut3 = userText(lastReq().body);
  check('M2. bar Continue: no target, window ends at paragraph 1', reqs.length === n0 + 1 && !ut3.includes('## Target') && ut3.includes('## Text before\n' + paras[0] + '\n\n## ') && ut3.includes('## Text after\n' + paras[1]), ut3);
  await page.click('#previewAccept');
  check('M2. bar Continue Insert toast', await toastHas('Inserted · version saved'));
  const exp2 = [paras[0], 'The lamp guttered.', 'She waited.'].concat(paras.slice(1)).join('\n\n');
  await page.waitForFunction((e) => document.getElementById('sceneText').value === e, exp2, { timeout: 4000 }).catch(() => {});
  check('M2. inserted after paragraph 1', (await page.inputValue('#sceneText')) === exp2, await page.inputValue('#sceneText'));
  // Text edited while the preview is open: Accept refuses.
  raw = await page.inputValue('#sceneText');
  await writeSelect(0, 4);
  await page.waitForSelector('#blockBar', { state: 'visible', timeout: 3000 }).catch(() => {});
  nv2 = (await sceneVersions()).length;
  await act('tighten'); await waitDone();
  await page.evaluate(() => { const t = document.getElementById('sceneText'); t.value = t.value + ' Edited.'; t.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.click('#previewAccept');
  check('M2. Accept after an edit says the text changed, no version', await toastHas('The text changed. Run the action again.') && (await sceneVersions()).length === nv2 && (await page.inputValue('#sceneText')) === raw + ' Edited.');
  await waitClosed();
  await page.waitForTimeout(900);
  // Back in blocks mode the blocks rules apply again.
  await page.click('#hdrMode');
  await page.waitForFunction(() => document.getElementById('viewScene').getAttribute('data-mode') === 'blocks');
  check('M2. back to blocks: bar hidden with nothing selected', !(await barShown()) && (await selCount()) === 0);
  await handle(0).click();
  const onB = await barShown();
  await page.click('#blockBarClose');
  check('M2. blocks selection still shows and closes the bar', onB && !(await barShown()) && (await selCount()) === 0);
  await page.screenshot({ path: OUT + 'p3-write-bar-after.png' });

  // ---- N. Outline menu, headers, errors ----
  await page.click('#hdrBack'); await waitView('outline');
  await page.click('#hdrMenu');
  await page.waitForSelector('#menuOverlay.open');
  const items = await page.locator('#menuItems [data-act]').evaluateAll(els => els.map(e => e.getAttribute('data-act')));
  check('N. project menu has rename and delete', items.includes('rename') && items.includes('delete'), items);
  await page.keyboard.press('Escape');
  const allowed = new Set(['authorization', 'content-type']);
  const normal = new Set(['accept', 'accept-encoding', 'accept-language', 'content-length', 'origin', 'referer', 'user-agent', 'host', 'connection', 'cache-control', 'pragma', 'priority']);
  const stray = [];
  for (const q of reqs) for (const k of Object.keys(q.headers)) { const l = k.toLowerCase(); if (!allowed.has(l) && !normal.has(l) && !/^(sec-|:)/.test(l)) stray.push(k); }
  check('N. only authorization and content-type custom headers on API requests', reqs.length > 0 && stray.length === 0, stray);
  check('N. no console errors / pageerrors', errors.length === 0, errors);
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
