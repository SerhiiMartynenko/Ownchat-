// Phase 2 browser end-to-end check for the writing app: v1 migration, projects, outline,
// scene editor, scene context, export/import. Usage: npm run e2e (Playwright + Chromium).
// Starts its own static server for the repo root on an ephemeral port.
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
  const reqs = [];
  await ctx.route('**/api/v1/chat/completions', async r => {
    const body = JSON.parse(r.request().postData());
    reqs.push({ body, headers: r.request().headers() });
    const d = o => 'data: ' + JSON.stringify(o) + '\n\n';
    await r.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': '*' },
      body: d({ choices: [{ delta: { content: 'Reply ok' } }] }) + 'data: [DONE]\n\n' });
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
  await page.addInitScript(() => {
    if (!localStorage.getItem('smoke.seeded')) {
      localStorage.setItem('ownchat.write.settings.v1', JSON.stringify({ apiKey: 'k', model: 'x-ai/grok-4.7', utilityModel: 'x-ai/grok-4.5', thinking: 'off', system: '', endpoint: '' }));
      localStorage.setItem('smoke.seeded', '1');
    }
  });
  const ready = async () => { await page.waitForSelector('html[data-ready="1"]', { timeout: 8000 }); await page.waitForTimeout(300); };
  const view = () => page.evaluate(() => document.body.dataset.view);
  const waitView = (v) => page.waitForSelector('#view' + v[0].toUpperCase() + v.slice(1) + '.active', { timeout: 5000 });
  const sysText = (b) => { const c = b.messages[0] && b.messages[0].role === 'system' ? b.messages[0].content : ''; return typeof c === 'string' ? c : c.map(p => p.text).join('\n'); };
  const sendAndWait = async (text) => {
    const n = reqs.length;
    await page.fill('#input', text);
    await page.click('#send');
    await page.waitForFunction(() => !document.querySelector('#send.stop'), null, { timeout: 8000 });
    for (let i = 0; i < 20 && reqs.length === n; i++) await page.waitForTimeout(100);
    await page.waitForTimeout(250);
    return reqs[reqs.length - 1];
  };
  const menuPick = async (act) => { await page.waitForSelector('#menuOverlay.open'); await page.click('#menuItems [data-act="' + act + '"]'); await page.waitForTimeout(300); };
  const headerVisible = () => page.evaluate(() => Array.from(document.querySelectorAll('[data-views]')).filter(e => !e.hidden).map(e => e.id).sort().join(','));


  // A. v1 -> v2 migration
  await page.goto(BASE + '/__blank');
  await page.evaluate(() => new Promise((res, rej) => {
    const r = indexedDB.open('ownchat-write', 1);
    r.onupgradeneeded = () => { const db = r.result; db.createObjectStore('bible', { keyPath: 'id' }); db.createObjectStore('threads', { keyPath: 'id' }); };
    r.onerror = () => rej(r.error);
    r.onsuccess = () => {
      const db = r.result, tx = db.transaction(['bible', 'threads'], 'readwrite');
      tx.objectStore('bible').put({ id: 'default', v: 1, brief: 'B', styleGuide: 'S', cards: [{ id: 'c1', type: 'character', name: 'Mira', aliases: ['the keeper'], body: 'Stubborn.', pinned: false, status: 'approved', createdAt: 1, updatedAt: 1 }], updatedAt: 1 });
      tx.objectStore('threads').put({ id: 'default', messages: [{ id: 'm1', role: 'user', content: 'old msg', display: 'old msg' }, { id: 'm2', role: 'assistant', content: 'old reply' }], summary: 'SUM', summarizedUpTo: 0, summarizedUpToId: null, summaryModel: '', summaryUpdatedAt: 0, lastUsage: null, updatedAt: 1 });
      tx.oncomplete = () => { db.close(); res(); };
      tx.onerror = () => rej(tx.error);
    };
  }));
  await page.evaluate(() => localStorage.setItem('ownchat.write.settings.v1', JSON.stringify({ apiKey: 'k', model: 'x-ai/grok-4.7', utilityModel: 'x-ai/grok-4.5', thinking: 'off', system: '', endpoint: '', editorMode: 'write' })));
  await page.goto(BASE + '/write/');
  await ready();
  check('A. migrated v1 data lands on the outline of "My project"', (await view()) === 'outline' && (await page.textContent('#hdrTitle')) === 'My project', [await view(), await page.textContent('#hdrTitle')]);
  let dump = await idbDump();
  check('A. IndexedDB is version 2 with the v2 stores', dump.version === 2 && ['bible', 'chapters', 'meta', 'projects', 'scenes', 'threads', 'versions'].every(n => dump.stores.includes(n)), [dump.version, dump.stores]);
  check('A. exactly 1 project adopting the default bible and thread', dump.data.projects.length === 1 && dump.data.projects[0].bibleId === 'default' && dump.data.projects[0].threadId === 'default', dump.data.projects);
  const th0 = dump.data.threads.find(t => t.id === 'default');
  check('A. default thread record has projectId', !!th0 && th0.projectId === dump.data.projects[0].id, th0);
  const mig = dump.data.meta.find(m => m.migratedV1At || (m.id && /migrat/i.test(m.id)) || (m.key && /migrat/i.test(m.key)));
  check('A. meta migratedV1At is set', !!mig && !!(mig.migratedV1At || mig.value || mig.v), dump.data.meta);
  await page.reload(); await ready();
  dump = await idbDump();
  check('A. reload keeps exactly 1 project', dump.data.projects.length === 1, dump.data.projects.length);
  await page.click('#hdrChat'); await waitView('chat');
  check('A. migrated chat shows 2 messages', (await page.locator('#list > *').count()) === 2, await page.locator('#list > *').count());
  await page.click('#hdrBack'); await waitView('outline');
  await page.click('#openBible');
  await page.waitForSelector('#bibleBrief', { state: 'visible', timeout: 5000 });
  check('A. migrated bible brief is "B"', (await page.inputValue('#bibleBrief')) === 'B', await page.inputValue('#bibleBrief'));
  check('A. migrated bible has a "Mira" card', (await page.locator('text=Mira').count()) > 0);
  await page.screenshot({ path: OUT + 'p2-migrated-bible.png' });
  await page.goto(BASE + '/write/');
  await ready();

  // 1. load of the migrated project
  check('1. load lands on outline', (await view()) === 'outline', await view());
  check('1. title is "My project"', (await page.textContent('#hdrTitle')) === 'My project', await page.textContent('#hdrTitle'));
  check('1. hash is #/p/<id>', /^#\/p\/[^/]+$/.test(await page.evaluate(() => location.hash)));
  check('1. outline header controls', (await headerVisible()) === 'hdrBack,hdrChat,hdrMenu,openBible', await headerVisible());
  check('1. outline empty state shown', await page.isVisible('#outlineEmpty'));

  // 2. back to library, create project
  await page.click('#hdrBack'); await waitView('library');
  check('2. library lists 1 project', (await page.locator('.project-row').count()) === 1);
  check('2. library title "Projects"', (await page.textContent('#hdrTitle')) === 'Projects');
  check('2. library header controls', (await headerVisible()) === 'hdrImport,hdrNewProject,openSettings', await headerVisible());
  answers.push('Novel A');
  await page.click('#hdrNewProject'); await waitView('outline');
  check('2. new project outline titled "Novel A"', (await page.textContent('#hdrTitle')) === 'Novel A');

  // 3. chapter and scene
  answers.push('Chapter One');
  await page.click('#outlineEmptyAdd'); await page.waitForSelector('.chapter');
  answers.push('Opening');
  await page.click('.chapter .add-scene'); await page.waitForSelector('.scene-row');
  check('3. 1 chapter, 1 scene', (await page.locator('.chapter').count()) === 1 && (await page.locator('.scene-row').count()) === 1);
  check('3. scene summary placeholder', (await page.textContent('.scene-row .scene-summary')) === 'No summary yet');
  answers.push('Chapter Two');
  await page.click('#outlineAddChapter'); await page.waitForFunction(() => document.querySelectorAll('.chapter').length === 2);
  await page.locator('.chapter').nth(1).locator('.chapter-head .row-menu').click();
  await menuPick('up');
  const chTitles = await page.locator('.chapter-title').allTextContents();
  check('3. chapter move up reorders', chTitles.join('|') === 'Chapter Two|Chapter One', chTitles);
  await page.screenshot({ path: OUT + 'p2-outline.png' });

  // 4. scene editor and autosave
  await page.click('.scene-row'); await waitView('scene');
  check('4. scene title field', (await page.inputValue('#sceneTitle')) === 'Opening');
  const TEXT = 'Mira climbed the stairs of the lighthouse.\n\nThe lamp had been dark for three nights.';
  await page.fill('#sceneText', TEXT);
  await page.waitForFunction(() => document.getElementById('sceneSaved').textContent === 'Saved', null, { timeout: 3000 }).catch(() => {});
  check('4. #sceneSaved becomes "Saved"', (await page.textContent('#sceneSaved')) === 'Saved', await page.textContent('#sceneSaved'));
  check('4. word count 15', (await page.textContent('#sceneWords')) === '15 words', await page.textContent('#sceneWords'));
  await page.screenshot({ path: OUT + 'p2-scene.png' });
  await page.reload(); await ready();
  check('4. reload stays on scene', (await view()) === 'scene');
  check('4. text survives reload', (await page.inputValue('#sceneText')) === TEXT);
  check('4. word count survives reload', (await page.textContent('#sceneWords')) === '15 words');

  // 5. chat with scene context
  await page.click('#hdrChat'); await waitView('chat');
  await page.click('#chatScopeProject');
  await page.waitForFunction(() => /^#\/p\/[^/]+\/chat$/.test(location.hash), null, { timeout: 4000 }).catch(() => {});
  await page.waitForSelector('#sceneChip', { state: 'visible', timeout: 4000 }).catch(() => {});
  check('5. chat title "Novel A"', (await page.textContent('#hdrTitle')) === 'Novel A');
  check('5. scene chip on', (await page.isVisible('#sceneChip')) && /Scene: Opening · On/.test(await page.textContent('#sceneChip')) && await page.locator('#sceneChip.on').count() === 1, await page.textContent('#sceneChip'));
  check('5. meter mentions scene', /· scene/.test(await page.textContent('#ctxMeterText')), await page.textContent('#ctxMeterText'));
  let r = await sendAndWait('What happens next?');
  let st = sysText(r.body);
  check('5. request has "## Current scene: Opening" and text', st.includes('## Current scene: Opening') && st.includes('The lamp had been dark'), st.slice(0, 300));
  await page.screenshot({ path: OUT + 'p2-chat.png' });
  await page.click('#sceneChip');
  check('5. chip off', /· Off/.test(await page.textContent('#sceneChip')) && await page.locator('#sceneChip.on').count() === 0);
  r = await sendAndWait('And then?');
  check('5. request without scene after toggle off', !sysText(r.body).includes('## Current scene'), sysText(r.body).slice(0, 200));
  await page.click('#ctxMeter'); await page.waitForSelector('#ctxOverlay.open');
  check('5. ctx sheet 7 rows', (await page.locator('#ctxLayers li.layer-row').count()) === 7);
  const sceneRow = await page.locator('#ctxLayers li.layer-row').nth(3).innerText();
  check('5. scene row says off', /Current scene/.test(sceneRow) && /off/.test(sceneRow), sceneRow);
  await page.click('#ctxClose');
  await page.click('#sceneChip');   // back on

  // 6. back navigation
  await page.click('#hdrBack'); await waitView('scene');
  check('6. back from chat returns to scene', (await view()) === 'scene');
  await page.click('#hdrBack'); await waitView('outline');
  check('6. back from scene returns to outline', (await view()) === 'outline');
  check('6. outline shows 15 words for the scene', (await page.textContent('.scene-row .row-meta')) === '15 words');

  // 7. export bundle and manuscript
  await page.click('#hdrMenu');
  const dlP = page.waitForEvent('download', { timeout: 8000 });
  await menuPick('bundle');
  const dl = await dlP;
  const name = dl.suggestedFilename();
  check('7. bundle download name ends with .ownchat.zip', name.endsWith('.ownchat.zip'), name);
  const zipPath = OUT + name;
  await dl.saveAs(zipPath);
  let files = {};
  try { const e = shim.unzipSync(new Uint8Array(fs.readFileSync(zipPath))); for (const k of Object.keys(e)) files[k] = shim.strFromU8(e[k]); } catch (e) { files = {}; }
  check('7. bundle has manifest.json', !!files['manifest.json'], Object.keys(files));
  const scenePath = Object.keys(files).find(k => k.startsWith('scenes/'));
  check('7. bundle scene file holds the text', !!scenePath && files[scenePath].includes('Mira climbed the stairs'), scenePath);
  await page.click('#hdrMenu');
  const dl2P = page.waitForEvent('download', { timeout: 8000 });
  await menuPick('manuscript');
  const dl2 = await dl2P;
  check('7. manuscript download .md', /\.md$/.test(dl2.suggestedFilename()), dl2.suggestedFilename());

  // 8. import as copy
  await page.click('#hdrBack'); await waitView('library');
  const before = await page.locator('.project-row').count();
  await page.setInputFiles('#bundleInput', zipPath);
  await menuPick('copy');
  await waitView('outline');
  check('8. import copy opens its outline', /Novel A \(imported\)/.test(await page.textContent('#hdrTitle')), await page.textContent('#hdrTitle'));
  check('8. imported outline has the scene', (await page.locator('.scene-row').count()) === 1);
  await page.click('#hdrBack'); await waitView('library');
  const after = await page.locator('.project-row').count();
  check('8. project count +1', after === before + 1, { before, after });
  await page.screenshot({ path: OUT + 'p2-library.png' });

  // 9. delete via row menu
  const victim = page.locator('.project-row', { hasText: 'Novel A (imported)' });
  await victim.locator('.row-menu').click();
  await menuPick('delete');
  await page.waitForFunction((n) => document.querySelectorAll('.project-row').length === n, after - 1, { timeout: 4000 }).catch(() => {});
  check('9. project deleted', (await page.locator('.project-row').count()) === after - 1 && (await page.locator('.project-row', { hasText: 'Novel A (imported)' }).count()) === 0);

  // 9b. replace, then import of a deleted project keeps its ids (no question asked)
  const manifestId = JSON.parse(files['manifest.json']).project.id;
  const n9 = await page.locator('.project-row').count();
  await page.setInputFiles('#bundleInput', zipPath);
  await menuPick('replace');
  await waitView('outline');
  check('9b. replace opens the same project id', (await page.evaluate(() => location.hash)) === '#/p/' + encodeURIComponent(manifestId));
  await page.click('#hdrBack'); await waitView('library');
  check('9b. replace keeps the project count', (await page.locator('.project-row').count()) === n9);
  await page.locator('.project-row', { hasText: /^Novel A/ }).first().locator('.row-menu').click();
  await menuPick('delete');
  await page.waitForFunction((n) => document.querySelectorAll('.project-row').length === n, n9 - 1, { timeout: 4000 }).catch(() => {});
  await page.setInputFiles('#bundleInput', zipPath);
  await waitView('outline');
  check('9b. import of a missing project keeps its id without a menu', (await page.evaluate(() => location.hash)) === '#/p/' + encodeURIComponent(manifestId) && (await page.locator('#menuOverlay.open').count()) === 0);
  check('9b. its scene text is intact', (await page.locator('.scene-row .row-meta').first().textContent()) === '15 words');
  await page.click('#hdrBack'); await waitView('library');
  check('9b. back from outline returns to library', (await view()) === 'library');

  // 10. unknown route
  await page.evaluate(() => { location.hash = '#/p/does-not-exist'; });
  await page.waitForTimeout(500);
  check('10. unknown id falls back to library', (await view()) === 'library' && (await page.evaluate(() => location.hash)) === '#/library');


  // 10b. delete cascade in IndexedDB
  dump = await idbDump();
  const novel = dump.data.projects.find(p => p.title === 'Novel A');
  if (novel) {
    await page.locator('.project-row', { hasText: /^Novel A/ }).first().locator('.row-menu').click();
    await menuPick('delete');
    await page.waitForTimeout(600);
    const d2 = await idbDump();
    const gone = !d2.data.projects.some(p => p.id === novel.id) && !d2.data.chapters.some(c => c.projectId === novel.id) && !d2.data.scenes.some(c => c.projectId === novel.id) && !d2.data.threads.some(c => c.projectId === novel.id);
    check('10b. deleting a project cascades to chapters, scenes and threads', gone, { chapters: d2.data.chapters.length, scenes: d2.data.scenes.length, threads: d2.data.threads.length });
  } else check('10b. Novel A present for cascade check', false, dump.data.projects.map(p => p.title));

  // 10c. request headers
  const allowed = new Set(['authorization', 'content-type']);
  const stray = [];
  for (const q of reqs) for (const k of Object.keys(q.headers)) if (/^(http-referer|x-title|x-openrouter)/i.test(k) || (!allowed.has(k.toLowerCase()) && /^x-/i.test(k))) stray.push(k);
  check('10c. only authorization and content-type custom headers on API requests', reqs.length > 0 && stray.length === 0, stray);

  check('no console errors / pageerrors (write app)', errors.length === 0, errors);

  // 11. root chat
  const p2 = await ctx.newPage();
  const errs2 = [];
  p2.on('console', m => { if (m.type() === 'error') errs2.push(m.text()); });
  p2.on('pageerror', e => errs2.push(e.message));
  await p2.goto(BASE + '/');
  await p2.waitForTimeout(1000);
  check('11. root chat loads with no console errors', errs2.length === 0, errs2);
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
