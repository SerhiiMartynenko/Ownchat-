// Phase 1 browser end-to-end check for the writing tool (write/) and the root chat.
// Usage: npm run e2e   (needs Playwright + Chromium installed locally)
// Starts its own static server for the repo root on an ephemeral port.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

let chromium;
try { ({ chromium } = require('playwright')); } catch (e1) {
  try { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); } catch (e2) {
    console.error('This check needs Playwright with Chromium installed (npm i -D playwright && npx playwright install chromium).');
    process.exit(2);
  }
}

const ROOT = path.resolve(__dirname, '..');
const SHOTS = path.join(__dirname, 'out') + path.sep;
fs.mkdirSync(SHOTS, { recursive: true });
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.mjs': 'application/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { res.writeHead(400); return res.end(); }
  let file = path.join(ROOT, p);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end(); }
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
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('dialog', d => d.accept());
  await ctx.route('https://cdn.jsdelivr.net/**', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
  const reqs = [];
  await ctx.route('**/api/v1/chat/completions', async r => {
    const body = JSON.parse(r.request().postData());
    reqs.push({ body, headers: r.request().headers() });
    const d = o => 'data: ' + JSON.stringify(o) + '\n\n';
    const h = { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': '*' };
    await new Promise(res => setTimeout(res, 150));
    if (body.model === 'x-ai/grok-4.5') {
      return r.fulfill({ status: 200, headers: h, body: d({ choices: [{ delta: { content: 'SUMMARY-MARKER: folded' } }] }) + 'data: [DONE]\n\n' });
    }
    await r.fulfill({ status: 200, headers: h,
      body: d({ choices: [{ delta: { reasoning: 'hmm' } }] }) + d({ choices: [{ delta: { content: 'Hello ' } }] }) +
        d({ choices: [{ delta: { content: 'world' } }] }) +
        d({ choices: [], usage: { prompt_tokens: 1234, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 0 } } }) + 'data: [DONE]\n\n' });
  });
  await page.addInitScript(() => {
    if (!localStorage.getItem('e2e.seeded')) {
      localStorage.setItem('orchat.settings.v1', JSON.stringify({ apiKey: 'k', model: 'x-ai/grok-4.7', thinking: 'max', system: 'Be terse.', endpoint: '' }));
      localStorage.setItem('orchat.history.v1', JSON.stringify([{ id: 'L1', role: 'user', content: 'old msg', display: 'old msg' }, { id: 'L2', role: 'assistant', content: 'old reply' }]));
      localStorage.setItem('e2e.seeded', '1');
    }
  });
  const idb = (store) => page.evaluate((store) => new Promise((res, rej) => {
    const r = indexedDB.open('ownchat-write');
    r.onsuccess = () => { const g = r.result.transaction(store).objectStore(store).get('default'); g.onsuccess = () => { res(g.result); r.result.close(); }; g.onerror = () => rej(g.error); };
    r.onerror = () => rej(r.error);
  }), store);
  const ready = async () => { await page.waitForSelector('html[data-ready="1"]', { timeout: 8000 }); await page.waitForTimeout(400); };
  const toChat = async () => {
    if (!(await page.locator('#viewChat.active').count())) {
      await page.click('#hdrChat');
      await page.waitForSelector('#viewChat.active', { timeout: 5000 });
      await page.waitForTimeout(300);
    }
  };
  const closeSettingsIfOpen = async () => { if (await page.locator('#settingsOverlay.open').count()) await page.click('#setCancel'); };
  const sendAndWait = async (text) => {
    const n = await page.locator('.msg.assistant .msg-actions:not([hidden])').count();
    await page.fill('#input', text);
    await page.click('#send');
    await page.waitForFunction((n) => document.querySelectorAll('.msg.assistant .msg-actions:not([hidden])').length > n && !document.querySelector('#send.stop'), n, { timeout: 8000 });
    await page.waitForTimeout(300);
  };
  const chatReqs = () => reqs.filter(r => r.body.model !== 'x-ai/grok-4.5');
  const lastChat = () => chatReqs()[chatReqs().length - 1];
  const sysText = (b) => { const c = b.messages[0].content; return typeof c === 'string' ? c : c.map(p => p.text).join('\n'); };

  // a
  await page.goto(BASE + '/write/');
  await ready();
  await toChat();
  check('a. html[data-ready=1]', true);
  const ls = await page.evaluate(() => localStorage.getItem('ownchat.write.settings.v1'));
  check('a. settings copied to ownchat.write.settings.v1', ls && JSON.parse(ls).apiKey === 'k', ls);
  await closeSettingsIfOpen();
  check('a. #importLegacy visible', await page.isVisible('#importLegacy'));
  await page.click('#importLegacy');
  await page.waitForTimeout(300);
  const nMsgs = await page.locator('#list .msg').count();
  check('a. 2 messages rendered after import', nMsgs === 2, nMsgs);
  const t1 = await idb('threads');
  check('a. IndexedDB thread has 2 messages', t1 && t1.messages.length === 2, t1);
  check('a. import button hidden', !(await page.isVisible('#importLegacy')));

  // b
  await page.click('#openBible');
  await page.waitForSelector('#bibleOverlay.open');
  check('b. #bibleStyle = "Be terse."', (await page.inputValue('#bibleStyle')) === 'Be terse.');
  await page.fill('#bibleBrief', 'A novella about a lighthouse keeper.');
  await page.click('#bibleAddCard');
  await page.waitForSelector('#cardOverlay.open');
  await page.click('#cardType button[data-v=character]');
  await page.fill('#cardName', 'Mira');
  await page.fill('#cardAliases', 'the keeper');
  await page.fill('#cardBody', 'Stubborn, 40s.');
  await page.click('#cardPin button[data-v=mention]');
  await page.click('#cardSave');
  await page.waitForTimeout(200);
  await page.click('#bibleAddCard');
  await page.click('#cardType button[data-v=note]');
  await page.fill('#cardName', 'Tone');
  await page.fill('#cardBody', 'Dry humour.');
  await page.click('#cardPin button[data-v=always]');
  await page.click('#cardSave');
  await page.waitForTimeout(200);
  const rows = await page.locator('#bibleCards .card-row').count();
  check('b. 2 card rows in list', rows === 2, rows);
  check('b. Tone pin shown on', await page.locator('.card-row:has-text("Tone") .card-pin.on').count() === 1);
  await page.screenshot({ path: SHOTS + 'phase1-bible.png' });
  await page.click('#bibleDone');
  await page.waitForTimeout(300);
  await page.reload(); await ready();
  const bb = await idb('bible');
  check('b. bible persisted (2 cards, brief, styleGuide)', bb && bb.cards.length === 2 && bb.brief === 'A novella about a lighthouse keeper.' && bb.styleGuide === 'Be terse.', bb);
  await page.click('#openBible');
  check('b. brief shows after reload', (await page.inputValue('#bibleBrief')) === 'A novella about a lighthouse keeper.');
  await page.click('#bibleDone');

  // c
  await page.click('#openSettings');
  await page.waitForSelector('#settingsOverlay.open');
  check('c. #setUtility = x-ai/grok-4.5', (await page.inputValue('#setUtility')) === 'x-ai/grok-4.5');
  check('c. utility presets rendered', (await page.locator('#utilityPresets .preset').count()) > 0);
  await page.fill('#setModel', 'x-ai/grok-4.7');
  await page.click('#setSave');
  await page.waitForTimeout(200);
  check('c. no errors after settings save', errors.length === 0, errors);

  // d
  await sendAndWait('what does the keeper want?');
  check('d. bubble "Hello world"', /Hello world/.test(await page.locator('.bubble-a').last().innerText()));
  let b = lastChat().body;
  const st = typeof b.messages[0].content === 'string' ? b.messages[0].content : '';
  check('d. system message string with style/brief/cards', b.messages[0].role === 'system' && ['## Style guide', 'Be terse.', '## Brief', '### Mira', '### Tone'].every(x => st.includes(x)), b.messages[0]);
  const lm = b.messages[b.messages.length - 1];
  check('d. last message is the user message', lm.role === 'user' && lm.content === 'what does the keeper want?', lm);
  check('d. stream_options.include_usage', b.stream_options && b.stream_options.include_usage === true);

  // e
  check('e. meter visible', !(await page.locator('#ctxMeter').evaluate(e => e.hidden)));
  const mt = await page.textContent('#ctxMeterText');
  check('e. meter text', /~[\d.]+k? tokens · 2 cards/.test(mt), mt);
  await page.click('#ctxMeter');
  await page.waitForSelector('#ctxOverlay.open');
  const lr = await page.locator('#ctxLayers li.layer-row').count();
  check('e. 6 layer rows', lr === 6, lr);
  const usage = await page.textContent('#ctxUsage');
  check('e. usage shows 1,234', usage.includes('1,234'), usage);
  await page.screenshot({ path: SHOTS + 'phase1-ctx.png' });
  await page.click('#ctxClose');
  check('e. ctx closed', await page.locator('#ctxOverlay.open').count() === 0);

  // f
  await page.click('#openSettings');
  await page.fill('#setModel', 'anthropic/claude-sonnet-4.6');
  await page.click('#setSave');
  await sendAndWait('hi');
  b = lastChat().body;
  const sc = b.messages[0].content;
  check('f. anthropic system is array with ephemeral cache_control', b.model === 'anthropic/claude-sonnet-4.6' && Array.isArray(sc) && sc.length > 0 && sc.every(p => p.cache_control && p.cache_control.type === 'ephemeral'), sc);
  await page.click('#openSettings');
  await page.fill('#setModel', 'x-ai/grok-4.7');
  await page.click('#setSave');

  // g
  await page.evaluate(() => new Promise((res, rej) => {
    const r = indexedDB.open('ownchat-write');
    r.onsuccess = () => {
      const tx = r.result.transaction('threads', 'readwrite'); const s = tx.objectStore('threads');
      const g = s.get('default');
      g.onsuccess = () => {
        const t = g.result;
        for (let i = 0; i < 18; i++) t.messages.push(i % 2 === 0 ? { id: 'm' + i, role: 'user', content: 'MSG-' + i, display: 'MSG-' + i } : { id: 'm' + i, role: 'assistant', content: 'MSG-' + i });
        s.put(t);
      };
      tx.oncomplete = () => { r.result.close(); res(); }; tx.onerror = () => rej(tx.error);
    };
  }));
  await page.reload(); await ready();
  const beforeUtil = reqs.length;
  await sendAndWait('continue');
  await page.waitForFunction(() => true);
  let util = null;
  for (let i = 0; i < 40 && !util; i++) { util = reqs.slice(beforeUtil).find(r => r.body.model === 'x-ai/grok-4.5'); if (!util) await page.waitForTimeout(200); }
  check('g. utility request sent', !!util);
  if (util) {
    const ub = util.body, us = JSON.stringify(ub);
    check('g. utility request contains MSG-0', us.includes('MSG-0'));
    check('g. utility request has no reasoning key', !('reasoning' in ub), ub.reasoning);
    check('g. utility max_tokens 1500', ub.max_tokens === 1500, ub.max_tokens);
    const c0 = ub.messages.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
    check('g. prompt has "Current summary" and "New messages"', c0.includes('Current summary') && c0.includes('New messages'), c0.slice(0, 400));
  }
  let tt = null;
  for (let i = 0; i < 40; i++) { tt = await idb('threads'); if (tt.summarizedUpTo > 0) break; await page.waitForTimeout(200); }
  check('g. thread summarizedUpTo > 0', tt.summarizedUpTo > 0, { upTo: tt.summarizedUpTo, summary: tt.summary });
  await page.waitForTimeout(800); // let catch-up folds settle
  await sendAndWait('again');
  b = lastChat().body;
  const st2 = sysText(b);
  check('g. system contains SUMMARY-MARKER', st2.includes('SUMMARY-MARKER'), st2.slice(0, 300));
  const hist = b.messages.slice(1).map(m => m.content);
  check('g. MSG-0 / MSG-1 omitted from request', !hist.some(c => c === 'MSG-0' || c === 'MSG-1' || /MSG-[01]\b/.test(c)), hist);
  const listCount = await page.locator('#list .msg').count();
  check('g. #list shows all messages (>=22)', listCount >= 22, listCount);
  const mt2 = await page.textContent('#ctxMeterText');
  check('g. meter mentions folded', /folded/.test(mt2) && !/ 0 folded/.test(mt2), mt2);
  console.log('   meter: ' + mt2 + ' | requests: ' + reqs.map(r => r.body.model).join(','));

  // h
  await page.locator('.msg.assistant .act[data-a=card]').last().click();
  await page.waitForSelector('#cardOverlay.open');
  const cb = await page.inputValue('#cardBody');
  check('h. card editor prefilled with reply', cb === 'Hello world', cb);
  await page.screenshot({ path: SHOTS + 'phase1-card.png' });
  await page.click('#cardCancel');

  // i
  const std = new Set(['accept', 'accept-language', 'user-agent', 'referer', 'origin', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'content-length']);
  const extra = new Set();
  reqs.forEach(r => Object.keys(r.headers).forEach(k => { if (!std.has(k)) extra.add(k); }));
  check('i. only authorization + content-type custom headers', [...extra].sort().join(',') === 'authorization,content-type', [...extra]);

  check('no console errors / pageerrors (write app)', errors.length === 0, errors);

  // j
  const p2 = await ctx.newPage();
  const errs2 = [];
  p2.on('console', m => { if (m.type() === 'error') errs2.push(m.text()); });
  p2.on('pageerror', e => errs2.push(e.message));
  await p2.goto(BASE + '/');
  await p2.waitForTimeout(1000);
  check('j. root chat loads with no console errors', errs2.length === 0, errs2);

}

(async () => {
  await new Promise(res => server.listen(0, '127.0.0.1', res));
  BASE = 'http://127.0.0.1:' + server.address().port;
  let browser, crashed = false;
  try {
    browser = await chromium.launch();
    await run(browser);
  } catch (e) {
    crashed = true;
    console.error(e);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await new Promise(res => server.close(res));
  }
  const fails = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - fails}/${results.length} passed`);
  process.exit(fails || crashed ? 1 : 0);
})();
