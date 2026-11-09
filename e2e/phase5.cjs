// Phase 5 browser end-to-end check for the writing app: desktop sidebar and split layout, Escape handling,
// chat history window, storage protection notice and backup reminder. Usage: npm run e2e (Playwright + Chromium).
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


const SETTINGS = { apiKey: 'k', model: 'other/x', utilityModel: 'other/util', thinking: 'off', system: '', endpoint: '', editorMode: 'write' };
const WORDS520 = Array.from({ length: 520 }, (_, i) => 'word' + (i % 50)).join(' ');
const DAY = 864e5;

// Replaces navigator.storage. The flag lives in localStorage so it survives reloads; persist() only grants when
// localStorage['stub.grant'] is '1' (the app calls persist() silently at boot, which must not flip the flag).
function storageStub() {
  const flagGet = () => localStorage.getItem('stub.persisted') === '1';
  const flagSet = (v) => localStorage.setItem('stub.persisted', v ? '1' : '0');
  if (!localStorage.getItem('stub.init')) { localStorage.setItem('stub.init', '1'); flagSet(window.__stubInitial); }
  Object.defineProperty(window, '__persistFlag', { get: flagGet, set: flagSet, configurable: true });
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: {
      persisted: () => Promise.resolve(flagGet()),
      persist: () => {
        localStorage.setItem('stub.calls', String(Number(localStorage.getItem('stub.calls') || 0) + 1));
        if (localStorage.getItem('stub.grant') === '1') { flagSet(true); return Promise.resolve(true); }
        return Promise.resolve(flagGet());
      },
      estimate: () => Promise.resolve({ usage: 12345678, quota: 2100000000 }),
    },
  });
}

async function run(browser) {
  const errors = [];
  const reqs = [];
  const answers = [];
  const sysText = (b) => b.messages.filter(m => m.role === 'system').map(m => typeof m.content === 'string' ? m.content : (m.content || []).map(p => p.text).join('\n')).join('\n');

  async function mkPage(viewport, initialPersisted) {
    const ctx = await browser.newContext({ viewport, acceptDownloads: true });
    const page = await ctx.newPage();
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('dialog', d => { if (d.type() === 'prompt') d.accept(answers.length ? answers.shift() : ''); else d.accept(); });
    await ctx.route('https://cdn.jsdelivr.net/**', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
    await ctx.route('https://cdn.jsdelivr.net/npm/fflate@0.8.2/**', r => r.fulfill({ status: 200, headers: { 'Content-Type': 'application/javascript', 'Access-Control-Allow-Origin': '*' }, body: fs.readFileSync(SHIM, 'utf8') }));
    await ctx.route('**/api/v1/chat/completions', async r => {
      const body = JSON.parse(r.request().postData());
      reqs.push({ body, headers: r.request().headers() });
      const reply = 'Reply ok';
      const d = o => 'data: ' + JSON.stringify(o) + '\n\n';
      const sse = d({ choices: [{ delta: { content: reply } }] }) + 'data: [DONE]\n\n';
      try { await r.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': '*' }, body: sse }); } catch (e) { /* aborted */ }
    });
    await page.addInitScript((s) => {
      if (!localStorage.getItem('smoke.seeded')) {
        localStorage.setItem('ownchat.write.settings.v1', JSON.stringify(s));
        localStorage.setItem('smoke.seeded', '1');
      }
    }, SETTINGS);
    await page.addInitScript('window.__stubInitial = ' + JSON.stringify(!!initialPersisted) + ';(' + storageStub.toString() + ')();');
    return { ctx, page };
  }

  function helpers(page) {
    const h = {};
    h.ready = async () => { await page.waitForSelector('html[data-ready="1"]', { timeout: 8000 }); await page.waitForTimeout(300); };
    h.attr = (n) => page.evaluate((n) => document.body.dataset[n], n);
    h.waitView = (v) => page.waitForSelector('#view' + v[0].toUpperCase() + v.slice(1) + '.active', { timeout: 5000 });
    h.headerVisible = () => page.evaluate(() => Array.from(document.querySelectorAll('[data-views]')).filter(e => !e.hidden).map(e => e.id).sort().join(','));
    h.hash = () => page.evaluate(() => location.hash);
    h.waitHash = async (re, ms = 4000) => { try { await page.waitForFunction((s) => new RegExp(s).test(location.hash), re.source, { timeout: ms }); } catch (e) {} return re.test(await h.hash()); };
    h.toastHas = async (t, ms = 4000) => { try { await page.waitForFunction((t) => (document.getElementById('toast').textContent || '').includes(t), t, { timeout: ms }); return true; } catch (e) { return false; } };
    h.poll = async (fn, ms = 4000) => { const t0 = Date.now(); let v; while (Date.now() - t0 < ms) { v = await fn(); if (v) return v; await page.waitForTimeout(150); } return v; };
    h.idb = (fn, arg) => page.evaluate(async ({ src, arg }) => {
      const db = await new Promise((res, rej) => { const r = indexedDB.open('ownchat-write'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      try { return await (new Function('db', 'arg', 'return (' + src + ')(db, arg)'))(db, arg); } finally { db.close(); }
    }, { src: fn.toString(), arg });
    h.dump = () => h.idb(async (db) => {
      const out = {};
      for (const n of Array.from(db.objectStoreNames)) out[n] = await new Promise(ok => { const g = db.transaction(n).objectStore(n).getAll(); g.onsuccess = () => ok(g.result); });
      return out;
    });
    h.box = (sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }, sel);
    h.sendAndWait = async (text) => {
      const n = reqs.length;
      await page.fill('#input', text);
      await page.click('#send');
      await page.waitForFunction(() => !document.querySelector('#send.stop'), null, { timeout: 8000 });
      for (let i = 0; i < 30 && reqs.length === n; i++) await page.waitForTimeout(100);
      await page.waitForTimeout(300);
      return reqs[reqs.length - 1];
    };
    return h;
  }

  // ================= Desktop =================
  {
    const { ctx, page } = await mkPage({ width: 1366, height: 900 }, true);
    const h = helpers(page);
    await page.goto(BASE + '/write/');
    await h.ready();
    if ((await h.attr('view')) !== 'library') { await page.click('#hdrBack'); await h.waitView('library'); }
    answers.push('Desk Novel');
    if (await page.isVisible('#libraryNew')) await page.click('#libraryNew'); else await page.click('#hdrNewProject');
    await h.waitView('outline');
    const pid = decodeURIComponent((await h.hash()).split('/')[2]);
    answers.push('Chapter One');
    await page.click('#outlineEmptyAdd'); await page.waitForSelector('.chapter');
    answers.push('Chapter Two');
    await page.click('#outlineAddChapter'); await page.waitForFunction(() => document.querySelectorAll('.chapter').length === 2);
    for (const [i, t] of [[0, 'Alpha'], [0, 'Beta'], [1, 'Gamma']]) {
      answers.push(t);
      await page.locator('.chapter .add-scene').nth(i).click();
      await page.waitForFunction((t) => Array.from(document.querySelectorAll('.scene-row')).some(e => e.textContent.includes(t)), t);
    }
    const d0 = await h.dump();
    const sc = (t) => d0.scenes.find(s => s.title === t);
    const alphaId = sc('Alpha').id, betaId = sc('Beta').id;
    check('0. setup: 2 chapters and 3 scenes in IndexedDB', d0.chapters.filter(c => c.projectId === pid).length === 2 && d0.scenes.filter(s => s.projectId === pid).length === 3);

    // 1. Sidebar with scene
    await page.reload(); await h.ready();
    await page.goto(BASE + '/write/#/s/' + alphaId);
    await page.reload(); await h.ready();
    await h.waitView('scene');
    check('1. data-layout is wide', (await h.attr('layout')) === 'wide', await h.attr('layout'));
    check('1. #viewOutline and #viewScene both visible', await page.isVisible('#viewOutline') && await page.isVisible('#viewScene'));
    const ob = await h.box('#viewOutline'), sb = await h.box('#viewScene');
    check('1. sidebar at x~0 width ~300, editor to its right', ob && sb && Math.abs(ob.x) < 2 && Math.abs(ob.w - 300) < 4 && sb.x >= ob.x + ob.w - 2 && sb.w > 500, [ob, sb]);
    const cur = page.locator('.scene-row.current');
    check('1. exactly one .scene-row.current with the open scene id', await cur.count() === 1 && (await cur.getAttribute('data-id')) === alphaId, await cur.count());
    check('1. #outlineHeadTitle is the project title', (await page.textContent('#outlineHeadTitle')).trim() === 'Desk Novel', await page.textContent('#outlineHeadTitle'));
    check('1. scene header set unchanged', (await h.headerVisible()) === 'hdrBack,hdrChat,hdrMenu,hdrMode,openBible,openSettings', await h.headerVisible());
    await page.screenshot({ path: OUT + 'p5-desktop-scene.png' });

    // 2. Split chat
    await page.click('#hdrChat');
    check('2. hash is #/s/<id>/chat', await h.waitHash(new RegExp('^#/s/' + alphaId + '/chat$')), await h.hash());
    await page.waitForSelector('#viewChat.active');
    check('2. data-view is split', (await h.attr('view')) === 'split', await h.attr('view'));
    check('2. scene, chat and outline all visible', await page.isVisible('#viewScene') && await page.isVisible('#viewChat') && await page.isVisible('#viewOutline'));
    check('2. split header set', (await h.headerVisible()) === 'hdrBack,hdrMenu,hdrMode,modelPill,newChat,openBible,openSettings', await h.headerVisible());
    await page.screenshot({ path: OUT + 'p5-desktop-split.png' });
    const r = await h.sendAndWait('Hello from split');
    const st = r ? sysText(r.body) : '';
    check('2. request system text has "## Current scene:" and the title', st.includes('## Current scene:') && st.includes('Alpha'), st.slice(0, 300));

    // 3. Sidebar row switches the scene chat
    await page.locator('.scene-row[data-id="' + betaId + '"]').click();
    check('3. hash is the other scene chat', await h.waitHash(new RegExp('^#/s/' + betaId + '/chat$')), await h.hash());
    await page.waitForTimeout(500);
    check('3. still split', (await h.attr('view')) === 'split');
    check('3. #sceneTitle changed to Beta', (await page.inputValue('#sceneTitle')) === 'Beta', await page.inputValue('#sceneTitle'));
    check('3. #list is empty (new thread)', await page.locator('#list > *').count() === 0, await page.locator('#list > *').count());
    const cur2 = page.locator('.scene-row.current');
    check('3. .current moved to Beta', await cur2.count() === 1 && (await cur2.getAttribute('data-id')) === betaId);

    // 4. Back, resize
    await page.click('#hdrBack');
    check('4. Back goes to #/s/<id>', await h.waitHash(new RegExp('^#/s/' + betaId + '$')), await h.hash());
    await page.waitForTimeout(400);
    check('4. chat hidden, scene visible', !(await page.isVisible('#viewChat')) && await page.isVisible('#viewScene') && (await h.attr('view')) === 'scene', await h.attr('view'));
    await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(500);
    check('4. 390px: layout narrow, sidebar hidden', (await h.attr('layout')) === 'narrow' && !(await page.isVisible('#viewOutline')), await h.attr('layout'));
    await page.screenshot({ path: OUT + 'p5-narrow.png' });
    await page.setViewportSize({ width: 1366, height: 900 }); await page.waitForTimeout(500);
    check('4. back at 1366: wide, sidebar visible', (await h.attr('layout')) === 'wide' && await page.isVisible('#viewOutline'));
    await page.setViewportSize({ width: 1100, height: 800 }); await page.waitForTimeout(500);
    await page.click('#hdrChat'); await page.waitForSelector('#viewChat.active');
    check('4. 1100px: scene chat is data-view chat (not split) with the sidebar visible', (await h.attr('view')) === 'chat' && await page.isVisible('#viewOutline') && !(await page.isVisible('#viewScene')), [await h.attr('view')]);
    await page.click('#hdrBack'); await h.waitView('scene');
    await page.setViewportSize({ width: 1366, height: 900 }); await page.waitForTimeout(500);

    // 5. Escape
    await page.click('#openSettings'); await page.waitForSelector('#settingsOverlay.open');
    await page.keyboard.press('Escape'); await page.waitForTimeout(400);
    check('5. Escape closes Settings', await page.locator('#settingsOverlay.open').count() === 0);
    await page.click('#openBible'); await page.waitForSelector('#bibleOverlay.open');
    await page.click('#bibleAddCard'); await page.waitForSelector('#cardOverlay.open');
    await page.keyboard.press('Escape'); await page.waitForTimeout(400);
    check('5. first Escape closes the card editor only', await page.locator('#cardOverlay.open').count() === 0 && await page.locator('#bibleOverlay.open').count() === 1);
    await page.keyboard.press('Escape'); await page.waitForTimeout(400);
    check('5. second Escape closes the bible', await page.locator('#bibleOverlay.open').count() === 0);

    // 6. History window
    await h.idb(async (db, arg) => {
      const tx = db.transaction('threads', 'readwrite');
      const g = await new Promise(ok => { const q = tx.objectStore('threads').get('t-' + arg.pid); q.onsuccess = () => ok(q.result); });
      const msgs = [];
      for (let i = 0; i < 130; i++) {
        const u = i % 2 === 0, text = (u ? 'Question ' : 'Answer ') + i + ' about the long story.';
        msgs.push(u ? { id: 'h' + i, role: 'user', content: text, display: text } : { id: 'h' + i, role: 'assistant', content: text });
      }
      tx.objectStore('threads').put(Object.assign({}, g || {}, { id: 't-' + arg.pid, projectId: arg.pid, messages: msgs, summary: '', summarizedUpTo: 0, summarizedUpToId: null, updatedAt: Date.now() }));
      await new Promise(ok => { tx.oncomplete = ok; });
    }, { pid });
    await page.goto(BASE + '/write/#/p/' + pid + '/chat');
    await page.reload(); await h.ready();
    await h.waitView('chat');
    await page.waitForTimeout(500);
    const nList = () => page.locator('#list > *').count();
    check('6. 60 messages rendered, #showEarlier visible', (await nList()) === 60 && await page.isVisible('#showEarlier'), await nList());
    const top0 = await page.evaluate(() => document.getElementById('scroll').scrollTop);
    await page.click('#showEarlier'); await page.waitForTimeout(500);
    const top1 = await page.evaluate(() => document.getElementById('scroll').scrollTop);
    check('6. click -> 120 messages, scroll did not jump to top', (await nList()) === 120 && top1 > 0, [await nList(), top0, top1]);
    await page.click('#showEarlier'); await page.waitForTimeout(500);
    check('6. click -> 130 messages, #showEarlier hidden', (await nList()) === 130 && !(await page.isVisible('#showEarlier')), await nList());
    await ctx.close();
  }

  // ================= Phone =================
  {
    const { ctx, page } = await mkPage({ width: 390, height: 844 }, false);
    const h = helpers(page);
    const calls = () => page.evaluate(() => Number(localStorage.getItem('stub.calls') || 0));
    await page.goto(BASE + '/write/');
    await h.ready();
    if ((await h.attr('view')) !== 'library') { await page.click('#hdrBack'); await h.waitView('library'); }
    answers.push('Phone Novel');
    if (await page.isVisible('#libraryNew')) await page.click('#libraryNew'); else await page.click('#hdrNewProject'); await h.waitView('outline');
    const pid = decodeURIComponent((await h.hash()).split('/')[2]);
    answers.push('Ch');
    await page.click('#outlineEmptyAdd'); await page.waitForSelector('.chapter');
    answers.push('Long');
    await page.click('.chapter .add-scene'); await page.waitForSelector('.scene-row');
    await page.locator('.scene-row').first().click(); await h.waitView('scene');
    await page.fill('#sceneText', WORDS520);
    await h.poll(async () => (await h.dump()).scenes.some(s => s.wordCount >= 500), 5000);
    await page.waitForTimeout(500);
    await page.click('#hdrBack'); await h.waitView('outline');
    await page.click('#hdrBack'); await h.waitView('library');
    await page.waitForTimeout(500);

    // 7. Storage notice
    check('7. persisted() is false initially', (await page.evaluate(() => window.__persistFlag)) === false);
    check('7. #libraryNotice visible with "stored only in this browser"', await page.isVisible('#libraryNotice') && (await page.textContent('#libraryNoticeText')).includes('stored only in this browser'), await page.textContent('#libraryNoticeText'));
    check('7. action text is "Protect storage"', (await page.textContent('#libraryNoticeAct')).trim() === 'Protect storage');
    await page.screenshot({ path: OUT + 'p5-notice.png' });
    const c0 = await calls();
    await page.evaluate(() => localStorage.setItem('stub.grant', '1'));
    await page.click('#libraryNoticeAct');
    check('7. toast "Storage protected"', await h.toastHas('Storage protected'));
    await page.waitForTimeout(500);
    check('7. persist() was called and the flag is now true', (await calls()) > c0 && (await page.evaluate(() => window.__persistFlag)) === true, [c0, await calls()]);
    check('7. notice hidden right after Protect (no reload needed)', !(await page.isVisible('#libraryNotice')));
    await page.click('#openSettings'); await page.waitForSelector('#settingsOverlay.open');
    await h.poll(async () => (await page.textContent('#storageStatus')).startsWith('Protected'), 3000);
    const ss = await page.textContent('#storageStatus');
    check('7. Settings status starts "Protected" and shows 12.3 MB', ss.startsWith('Protected') && ss.includes('12.3 MB'), ss);
    check('7. #storageProtect hidden', !(await page.isVisible('#storageProtect')));
    await page.keyboard.press('Escape'); await page.waitForTimeout(300);

    // 8. Backup reminder
    const seed = (exportedAgo) => h.idb(async (db, a) => {
      const now = Date.now();
      const tx = db.transaction(['meta', 'projects'], 'readwrite');
      const m = await new Promise(ok => { const q = tx.objectStore('meta').get('app'); q.onsuccess = () => ok(q.result); });
      const meta = Object.assign({ id: 'app' }, m || {}, { exports: { [a.pid]: now - a.ago * a.day } });
      delete meta.notices;
      tx.objectStore('meta').put(meta);
      const p = await new Promise(ok => { const q = tx.objectStore('projects').get(a.pid); q.onsuccess = () => ok(q.result); });
      p.updatedAt = now - a.day; p.createdAt = now - 30 * a.day;
      tx.objectStore('projects').put(p);
      await new Promise(ok => { tx.oncomplete = ok; });
    }, { pid, ago: exportedAgo, day: DAY });
    await seed(10);
    await page.goto(BASE + '/write/#/library');
    await page.reload(); await h.ready();
    await h.waitView('library');
    await page.waitForTimeout(500);
    const nt = await page.isVisible('#libraryNotice') ? await page.textContent('#libraryNoticeText') : '';
    check('8. backup notice visible: "not exported for 10 days"', /not exported for 10 days/.test(nt), nt);
    check('8. action is "Export backup"', (await page.textContent('#libraryNoticeAct')).trim() === 'Export backup');
    const dl = page.waitForEvent('download', { timeout: 8000 });
    await page.click('#libraryNoticeAct');
    let got = null; try { got = await dl; } catch (e) {}
    check('8. a download occurred', !!got && /\.zip$/.test(got.suggestedFilename()), got && got.suggestedFilename());
    await page.waitForTimeout(800);
    check('8. notice hides after export', !(await page.isVisible('#libraryNotice')));
    const meta1 = (await h.dump()).meta.find(m => m.id === 'app');
    check('8. meta.exports[pid] is recent', !!meta1 && meta1.exports && Date.now() - meta1.exports[pid] < 60000, meta1 && meta1.exports);
    await seed(10);
    await page.reload(); await h.ready(); await h.waitView('library'); await page.waitForTimeout(500);
    check('8. notice back after reseed', await page.isVisible('#libraryNotice'));
    await page.click('#libraryNoticeLater'); await page.waitForTimeout(500);
    const meta2 = (await h.dump()).meta.find(m => m.id === 'app');
    check('8. Later hides it and stores meta.notices.backupAt', !(await page.isVisible('#libraryNotice')) && !!meta2.notices && meta2.notices.backupAt > 0, meta2.notices);
    await page.reload(); await h.ready(); await h.waitView('library'); await page.waitForTimeout(500);
    check('8. still hidden after reload', !(await page.isVisible('#libraryNotice')));
    await ctx.close();
  }

  // ================= 9. Headers and console =================
  const allowed = new Set(['authorization', 'content-type']);
  const normal = new Set(['accept', 'accept-encoding', 'accept-language', 'content-length', 'origin', 'referer', 'user-agent', 'host', 'connection', 'cache-control', 'pragma', 'priority']);
  const stray = [];
  for (const q of reqs) for (const k of Object.keys(q.headers)) { const l = k.toLowerCase(); if (!allowed.has(l) && !normal.has(l) && !/^(sec-|:)/.test(l)) stray.push(k); }
  check('9. only authorization and content-type custom headers on API requests', reqs.length > 0 && stray.length === 0, stray);
  check('9. no console errors / pageerrors', errors.length === 0, errors);
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
