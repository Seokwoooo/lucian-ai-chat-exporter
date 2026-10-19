// Captures the real extension UI (dist/) in Chrome for Testing for the store screenshots, once per
// listing language. Sites are served from synthetic content (content.mjs); nothing real is contacted.
//
//   npm run build && node scripts/store-assets/capture.mjs [en|ko ...]
//
// Output: test-output/store-captures/<lang>/*.png + handoff.md


/* global document, window, chrome -- page-side code run through puppeteer */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';
import { chatgptPayload } from './content.mjs';
import { chatPage } from './mock-page.mjs';

const DIST = resolve('dist');
const OUT = resolve('test-output/store-captures');
const KATEX = resolve('node_modules/katex/dist');
const PROVIDERS = resolve('src/static/providers');
const CONV_ID = { en: '6731c0de-5a1e-4b7a-9c2f-0e1d2c3b4a51', ko: '6731c0de-5a1e-4b7a-9c2f-0e1d2c3b4a52' };
const TOKEN = 'store-capture-not-a-real-token';

function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const base = join(homedir(), '.cache/lucian-cft/chrome');
  for (const dir of existsSync(base) ? readdirSync(base).sort().reverse() : []) {
    for (const rel of ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-linux64/chrome']) {
      if (existsSync(join(base, dir, rel))) return join(base, dir, rel);
    }
  }
  throw new Error('Chrome for Testing not found (npm run e2e:install-chrome)');
}

const json = (data, status = 200) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });

function route(lang, { url, headers }) {
  const u = new URL(url);
  if (u.host !== 'chatgpt.com') return null;
  if (u.pathname === `/c/${CONV_ID[lang]}`) return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: chatPage(lang) };
  if (u.pathname.startsWith('/__static/katex/')) {
    const f = join(KATEX, u.pathname.slice('/__static/katex/'.length));
    if (!f.startsWith(KATEX) || !existsSync(f)) return { status: 404, body: '' };
    const type = f.endsWith('.css') ? 'text/css' : f.endsWith('.woff2') ? 'font/woff2' : f.endsWith('.woff') ? 'font/woff' : 'application/octet-stream';
    return { status: 200, headers: { 'content-type': type, 'access-control-allow-origin': '*' }, body: readFileSync(f) };
  }
  if (u.pathname.startsWith('/__static/providers/')) {
    const f = join(PROVIDERS, u.pathname.slice('/__static/providers/'.length));
    if (!f.startsWith(PROVIDERS) || !existsSync(f)) return { status: 404, body: '' };
    return { status: 200, headers: { 'content-type': 'image/svg+xml' }, body: readFileSync(f) };
  }
  if (u.pathname === '/api/auth/session') return json({ accessToken: TOKEN, user: { id: 'store' } });
  if (u.pathname === `/backend-api/conversation/${CONV_ID[lang]}`) {
    if (headers.authorization !== `Bearer ${TOKEN}`) return json({ detail: 'unauthorized' }, 401);
    return json(chatgptPayload(lang));
  }
  return json({ detail: 'not found' }, 404);
}

async function intercept(lang, session) {
  session.on('Fetch.requestPaused', async (ev) => {
    const headers = Object.fromEntries(Object.entries(ev.request.headers).map(([k, v]) => [k.toLowerCase(), v]));
    const res = route(lang, { url: ev.request.url, headers });
    try {
      if (!res) return void (await session.send('Fetch.failRequest', { requestId: ev.requestId, errorReason: 'BlockedByClient' }));
      const body = Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.body, 'utf8');
      await session.send('Fetch.fulfillRequest', {
        requestId: ev.requestId,
        responseCode: res.status,
        responseHeaders: Object.entries(res.headers ?? {}).map(([name, value]) => ({ name, value })),
        body: body.toString('base64'),
      });
    } catch {
      /* target went away */
    }
  });
  await session.send('Fetch.enable', { patterns: [{ urlPattern: 'https://*' }] });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Stops the handoff illustration mid-flight (MD document on the arc), as the README shots do. */
async function freezeVisual(p, inPanel = false) {
  await p.evaluate((inPanel) => {
    const root = inPanel ? document.querySelector('[data-lucian-panel]')?.shadowRoot : document;
    root?.querySelectorAll('svg.hv-arc').forEach((s) => { s.pauseAnimations(); s.setCurrentTime(1); });
    root?.querySelectorAll('.hv').forEach((h) => h.getAnimations({ subtree: true }).forEach((a) => { a.pause(); a.currentTime = 1000; }));
    // Page button: stop the rotating ring at a pleasant angle.
    document.querySelectorAll('[data-lucian-action]').forEach((h) => h.shadowRoot?.getAnimations?.().forEach((a) => { a.pause(); a.currentTime = 1800; }));
  }, inPanel);
}

async function captureLang(lang) {
  const out = join(OUT, lang);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const downloads = mkdtempSync(join(tmpdir(), 'lucian-store-dl-'));
  const profile = mkdtempSync(join(tmpdir(), 'lucian-store-profile-'));
  mkdirSync(join(profile, 'Default'), { recursive: true });
  writeFileSync(join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false, directory_upgrade: true } }));
  const locale = lang === 'en' ? 'en-US' : 'ko-KR';
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: true,
    userDataDir: profile,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run', '--no-default-browser-check', `--lang=${locale}`, '-AppleLanguages', `(${locale})`, '--hide-scrollbars'],
    defaultViewport: { width: 1280, height: 800, deviceScaleFactor: 2 },
  });
  const attach = async (t) => {
    if (t.type() !== 'page' && t.type() !== 'service_worker') return;
    try { await intercept(lang, await t.createCDPSession()); } catch { /* not attachable */ }
  };
  browser.on('targetcreated', (t) => void attach(t));
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'), { timeout: 20_000 });
  const extId = new URL(sw.url()).host;
  await attach(sw);

  const popup = await browser.newPage();
  // A short viewport makes full-page shots exactly as tall as the popup's content.
  await popup.setViewport({ width: 360, height: 100, deviceScaleFactor: 2 });
  await popup.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'load' });

  const waitJob = async (tabId, pred, timeoutMs = 60_000) => {
    const t0 = Date.now();
    for (;;) {
      const job = await popup.evaluate(async (id) => (await chrome.storage.session.get(`job:${id}`))[`job:${id}`], tabId);
      if (job && pred(job)) return job;
      if (Date.now() - t0 > timeoutMs) throw new Error(`timeout: ${JSON.stringify(job)}`);
      await sleep(150);
    }
  };
  const newest = (ext, since) => {
    const f = readdirSync(downloads).filter((n) => n.endsWith(`.${ext}`)).map((n) => ({ n, t: statSync(join(downloads, n)).mtimeMs })).filter((x) => x.t >= since - 1000).sort((a, b) => b.t - a.t)[0];
    if (!f) throw new Error(`no .${ext} download`);
    return join(downloads, f.n);
  };

  // ---------- chat page ----------
  const pageUrl = `https://chatgpt.com/c/${CONV_ID[lang]}`;
  const page = await browser.newPage();
  await page.goto(pageUrl, { waitUntil: 'load' });
  await page.bringToFront();
  await page.waitForSelector('[data-lucian-action]', { timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  // Scroll so the last answer's toolbar sits low in the view, leaving room for the panel above it.
  await page.evaluate(() => {
    const bars = [...document.querySelectorAll('[data-lucian-action]')];
    const last = bars[bars.length - 1];
    const sc = document.getElementById('scroll');
    sc.scrollTop += last.getBoundingClientRect().top - (window.innerHeight - 250);
  });
  await sleep(700);
  await freezeVisual(page);
  await page.screenshot({ path: join(out, 'chat.png') });
  const tabId = await popup.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id ?? -1, pageUrl);

  // ---------- popup helpers ----------
  const openPopup = async ({ dark = false, more = false } = {}) => {
    await popup.bringToFront();
    await popup.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }]);
    await popup.goto(`chrome-extension://${extId}/popup.html?tabId=${tabId}`, { waitUntil: 'load' });
    await popup.waitForSelector('#handoffBtn:not([disabled])');
    const open = await popup.$eval('#moreBtn', (b) => b.getAttribute('aria-expanded') === 'true');
    if (open !== more) await popup.click('#moreBtn');
    await sleep(350);
  };
  const shot = async (name) => {
    await freezeVisual(popup);
    await popup.screenshot({ path: join(out, `${name}.png`), fullPage: true });
  };
  /** Runs one popup action to its end; keeps the job and the file, then deletes the download so names never get " (1)". */
  const run = async (selector, name, ext) => {
    const s0 = Date.now();
    await popup.click(selector);
    const job = await waitJob(tabId, (j) => j.startedAt >= s0 - 50 && ['done', 'error', 'print'].includes(j.phase) && (j.phase !== 'print' || !!j.result));
    if (job.phase === 'error') throw new Error(`${name}: ${JSON.stringify(job.error)}`);
    writeFileSync(join(out, `${name}-job.json`), JSON.stringify(job, null, 2));
    if (ext) {
      const f = newest(ext, s0);
      writeFileSync(join(out, `${name}.${ext}`), readFileSync(f));
      rmSync(f);
    }
    await sleep(400);
    return job;
  };
  const withDetails = async (name) => {
    if (await popup.$('#detailsBtn:not([hidden])')) {
      await popup.click('#detailsBtn');
      await sleep(250);
    }
    await shot(name);
    await (await popup.$('#status')).screenshot({ path: join(out, `status-${name.replace(/^popup-/, '')}.png`) });
  };

  // ---------- popup, idle ----------
  await openPopup();
  await shot('popup');
  await openPopup({ more: true });
  await shot('popup-more');
  await openPopup({ dark: true, more: true });
  await shot('popup-dark-more');
  await openPopup({ dark: true });
  await shot('popup-dark');

  // ---------- in-page button and panel ----------
  await page.bringToFront();
  const triggers = await page.$$('[data-lucian-action] >>> button');
  await triggers[triggers.length - 1].click();
  const primary = await page.waitForSelector('[data-lucian-panel] >>> .primary', { visible: true });
  await sleep(450);
  await freezeVisual(page, true);
  await page.screenshot({ path: join(out, 'chat-panel.png') });
  // Where the panel and the clicked page button are, for the composer's crops and callouts.
  const layout = await page.evaluate(() => {
    const rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
    const hosts = [...document.querySelectorAll('[data-lucian-action]')];
    const root = document.querySelector('[data-lucian-panel]').shadowRoot;
    return { panel: rect(root.querySelector('.panel')), primary: rect(root.querySelector('.primary')), button: rect(hosts[hosts.length - 1]) };
  });
  writeFileSync(join(out, 'layout.json'), JSON.stringify(layout, null, 2));
  const t0 = Date.now();
  await primary.click();
  const hjob = await waitJob(tabId, (j) => j.startedAt >= t0 - 50 && ['done', 'error'].includes(j.phase));
  if (hjob.phase !== 'done') throw new Error(`handoff failed: ${JSON.stringify(hjob.error)}`);
  await page.waitForFunction(() => document.querySelector('[data-lucian-panel]')?.shadowRoot?.querySelector('.status')?.getAttribute('data-level') === 'ok', { timeout: 10_000 });
  await sleep(300);
  await freezeVisual(page, true);
  await page.screenshot({ path: join(out, 'chat-panel-done.png') });
  await (await page.$('[data-lucian-panel] >>> .status')).screenshot({ path: join(out, 'panel-status.png') });
  // All formats in the panel (checks that every label fits the grid).
  await page.evaluate(() => document.querySelector('[data-lucian-panel]').shadowRoot.querySelector('.more').click());
  await sleep(250);
  await (await page.$('[data-lucian-panel] >>> .panel')).screenshot({ path: join(out, 'panel-more.png') });
  await page.evaluate(() => document.querySelector('[data-lucian-panel]').shadowRoot.querySelector('.more').click());
  const hfile = newest('md', t0);
  writeFileSync(join(out, 'handoff.md'), readFileSync(hfile));
  writeFileSync(join(out, 'handoff-job.json'), JSON.stringify(hjob, null, 2));
  rmSync(hfile);
  await page.keyboard.press('Escape');

  // ---------- popup, results ----------
  await openPopup();
  await run('#handoffBtn', 'popup-handoff', 'md');
  await shot('popup-handoff-done');
  await withDetails('popup-handoff-verified');

  for (const [fmt, ext, more] of [['docx', 'docx', true], ['html', 'html', true], ['hwpx', 'hwpx', true]]) {
    await openPopup({ more });
    await run(`.fmt[data-format="${fmt}"]`, `export-${fmt}`, ext);
    await withDetails(`popup-${fmt}-verified`);
  }

  // PDF: the local print page, then the popup's verification list.
  await openPopup();
  const before = new Set((await browser.pages()).map((p) => p.url()));
  await run('.fmt[data-format="pdf"]', 'export-pdf');
  let printPage;
  for (let i = 0; i < 50 && !printPage; i++) {
    printPage = (await browser.pages()).find((p) => p.url().includes('/print.html') && !before.has(p.url()));
    if (!printPage) await sleep(150);
  }
  await printPage.bringToFront();
  await printPage.setViewport({ width: 860, height: 1400, deviceScaleFactor: 2 });
  await printPage.evaluate(() => document.fonts.ready);
  await sleep(800);
  await printPage.screenshot({ path: join(out, 'print.png') });
  writeFileSync(join(out, 'print-layout.json'), JSON.stringify(await printPage.evaluate(() => {
    const top = (el) => el.getBoundingClientRect().top + window.scrollY;
    return { title: top(document.querySelector('h1')), m2: top(document.getElementById('m-2')), m4: top(document.getElementById('m-4')), code: top(document.querySelector('#m-4 figure.code')) };
  }), null, 2));
  await printPage.screenshot({ path: join(out, 'print-full.png'), fullPage: true });
  await printPage.close();
  await popup.bringToFront();
  await withDetails('popup-pdf-verified');

  await browser.close();
  rmSync(profile, { recursive: true, force: true });
  rmSync(downloads, { recursive: true, force: true });
  console.log(`${lang}: captured → ${out}`);
}

const langs = process.argv.slice(2).length ? process.argv.slice(2) : ['en', 'ko'];
for (const lang of langs) await captureLang(lang);
