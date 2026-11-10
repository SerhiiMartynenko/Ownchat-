// Browser end-to-end check: automatic switching between direct OpenRouter and the proxy when one path is blocked,
// plus Settings -> Advanced -> Test connection.
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

const DIRECT = 'https://openrouter.ai/api/v1/chat/completions';
const PROXY = 'https://ownchat-proxy.ownchat-serhii.workers.dev/api/v1/chat/completions';
const SSE = { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': '*' };
const sseOk = (text) => 'data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\ndata: [DONE]\n\n';
// Responses for each path. A CORS-blocked 403 is unreadable to the page: fetch rejects with a TypeError,
// exactly like a refused preflight. Playwright adds a permissive Access-Control-Allow-Origin to fulfilled
// responses that lack one, so the blocked variant sends a mismatched origin to force the CORS failure.
// A 403 WITH a matching CORS header is a readable block page.
const R = {
  ok: (text) => r => r.fulfill({ status: 200, headers: SSE, body: sseOk(text) }),
  corsBlocked: () => r => r.fulfill({ status: 403, headers: { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': 'https://not-this-origin.example' }, body: '<html>blocked</html>' }),
  readable403: () => r => r.fulfill({ status: 403, headers: { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' }, body: 'Origin not allowed' }),
  json401: () => r => r.fulfill({ status: 401, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: { message: 'No auth credentials found', code: 401 } }) })
};
// Expected browser console noise from the deliberately blocked/refused requests in these scenarios
// (CORS refusal, net::ERR_FAILED, 401/403 resource loads). Anything else counts as an error.
const EXPECTED_NOISE = /blocked by CORS policy|net::ERR_FAILED|status of 40[13]|Failed to load resource/i;

async function scenario(browser, name, opts) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error' && !EXPECTED_NOISE.test(m.text())) errors.push('console: ' + m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('dialog', d => d.accept());
  await ctx.route('https://cdn.jsdelivr.net/**', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
  const reqs = [];
  const track = (handler) => async r => {
    if (r.request().method() === 'POST') reqs.push({ url: r.request().url(), headers: r.request().headers(), body: r.request().postData() });
    return handler(r);
  };
  await page.route(DIRECT, track(opts.direct));
  await page.route(PROXY, track(opts.proxy));
  await page.addInitScript((s) => {
    if (!localStorage.getItem('e2e.seeded')) {
      localStorage.setItem('ownchat.write.settings.v1', JSON.stringify(s));
      localStorage.setItem('e2e.seeded', '1');
    }
  }, { apiKey: opts.apiKey === undefined ? 'k' : opts.apiKey, model: 'test/main-model', utilityModel: 'test/utility-model', thinking: 'off', system: '', endpoint: opts.endpoint });
  await page.goto(BASE + '/write/');
  await page.waitForSelector('html[data-ready="1"]', { timeout: 8000 });
  await page.waitForTimeout(300);
  const stored = async () => JSON.parse(await page.evaluate(() => localStorage.getItem('ownchat.write.settings.v1')));
  const env = { ctx, page, reqs, errors, stored };
  try {
    await opts.run(env);
  } finally {
    const std = new Set(['accept', 'accept-language', 'user-agent', 'referer', 'origin', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'content-length']);
    const extra = new Set();
    reqs.forEach(r => Object.keys(r.headers).forEach(k => { if (!std.has(k)) extra.add(k); }));
    check(name + ': requests carry only authorization + content-type', reqs.length > 0 && [...extra].sort().join(',') === 'authorization,content-type', [...extra]);
    check(name + ': no unexpected console errors', errors.length === 0, errors);
    await ctx.close();
  }
}

async function toChatAndSend(page, text) {
  if (!(await page.locator('#viewChat.active').count())) {
    await page.click('#hdrChat');
    await page.waitForSelector('#viewChat.active', { timeout: 5000 });
    await page.waitForTimeout(200);
  }
  await page.fill('#input', text);
  await page.click('#send');
  await page.waitForFunction(() => document.querySelector('#list .msg.assistant .msg-actions:not([hidden])') && !document.querySelector('#send.stop'), null, { timeout: 8000 });
  await page.waitForTimeout(150);
}
const lastAssistant = (page) => page.evaluate(() => { const m = document.querySelectorAll('#list .msg.assistant'); return m.length ? m[m.length - 1].textContent : ''; });
const waitToast = (page, re) => page.waitForFunction((src) => new RegExp(src).test(document.getElementById('toast').textContent), re.source, { timeout: 5000 }).then(() => true, () => false);

async function run(browser) {
  await scenario(browser, 'A direct blocked -> proxy', {
    endpoint: '', direct: R.corsBlocked(), proxy: R.ok('VIA-PROXY'),
    run: async ({ page, reqs, stored }) => {
      await toChatAndSend(page, 'hello');
      check('A. reply from the proxy renders', /VIA-PROXY/.test(await lastAssistant(page)), await lastAssistant(page));
      check('A. toast says switched to proxy', await waitToast(page, /Switched to your proxy/), await page.textContent('#toast'));
      check('A. stored endpoint is the proxy', (await stored()).endpoint === PROXY, await stored());
      check('A. direct tried first, then proxy', reqs.map(r => r.url).join(' ') === DIRECT + ' ' + PROXY, reqs.map(r => r.url));
    }
  });
  await scenario(browser, 'B proxy refused -> direct', {
    endpoint: PROXY, direct: R.ok('VIA-DIRECT'), proxy: R.readable403(),
    run: async ({ page, reqs, stored }) => {
      await toChatAndSend(page, 'hello');
      check('B. reply from direct renders', /VIA-DIRECT/.test(await lastAssistant(page)), await lastAssistant(page));
      check('B. toast says switched to direct', await waitToast(page, /Switched to direct/), await page.textContent('#toast'));
      check('B. stored endpoint is empty', (await stored()).endpoint === '', await stored());
      check('B. proxy tried first, then direct', reqs.map(r => r.url).join(' ') === PROXY + ' ' + DIRECT, reqs.map(r => r.url));
    }
  });
  await scenario(browser, 'C both blocked', {
    endpoint: '', direct: R.corsBlocked(), proxy: R.readable403(),
    run: async ({ page, stored }) => {
      await toChatAndSend(page, 'hello');
      const err = await page.evaluate(() => { const e = document.querySelectorAll('#list .msg.assistant .err'); return e.length ? e[e.length - 1].textContent : ''; });
      check('C. error bubble names both paths', /could not be reached from this network/.test(err) && /Direct: CORS preflight failed/.test(err) && /Proxy: refused \(403: Origin not allowed\)/.test(err), err);
      check('C. retry button shown', (await page.locator('#list .msg.assistant [data-a=retry]').count()) === 1);
      check('C. stored endpoint unchanged', (await stored()).endpoint === '', await stored());
    }
  });
  await scenario(browser, 'D test connection', {
    endpoint: '', apiKey: '', direct: R.corsBlocked(), proxy: R.json401(),
    run: async ({ page, reqs, stored }) => {
      if (!(await page.locator('#viewChat.active').count())) { await page.click('#hdrChat'); await page.waitForSelector('#viewChat.active', { timeout: 5000 }); }
      if (!(await page.locator('#settingsOverlay.open').count())) await page.click('#openSettings');
      await page.waitForSelector('#settingsOverlay.open');
      check('D. result hidden on open', !(await page.isVisible('#connResult')));
      await page.fill('#setKey', '');
      await page.click('#setTestConn');
      check('D. asks for a key first', (await page.textContent('#connResult')) === 'Add your OpenRouter API key first', await page.textContent('#connResult'));
      check('D. no request without a key', reqs.length === 0, reqs.length);
      await page.fill('#setKey', 'sk-test');
      await page.click('#setTestConn');
      await page.waitForFunction(() => /Proxy:/.test(document.getElementById('connResult').textContent) && !document.getElementById('setTestConn').disabled, null, { timeout: 8000 });
      const txt = await page.textContent('#connResult');
      check('D. direct reported as preflight failure', /Direct: CORS preflight failed/.test(txt), txt);
      check('D. proxy reported reachable, key rejected', /Proxy: reachable, but the key was rejected/.test(txt), txt);
      check('D. probe body is an empty-model request', reqs.length === 2 && reqs.every(r => r.body === JSON.stringify({ model: '', messages: [] })), reqs.map(r => r.body));
      check('D. lines are separate', (await page.evaluate(() => getComputedStyle(document.getElementById('connResult')).whiteSpace)) === 'pre-line');
      await page.screenshot({ path: SHOTS + 'fallback-testconn.png' });
      check('D. test does not change the saved endpoint', (await stored()).endpoint === '', await stored());
      await page.click('#setCancel');
      await page.click('#openSettings');
      check('D. result hidden again on reopen', !(await page.isVisible('#connResult')));
    }
  });
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
