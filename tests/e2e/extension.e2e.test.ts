// End-to-end test: the built extension (dist/) running in Chrome for Testing against mocked
// ChatGPT / Claude / Gemini / Grok pages. Drives the real popup UI, waits for real downloads and
// validates the produced files.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import puppeteer, { type Browser, type CDPSession, type Page, type Target } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JobState } from '../../src/shared/types';
import { PAGES, calls, route } from './mock-sites';

const DIST = resolve('dist');
// Files are named "<site>-export.<ext>": "claude.md" would collide with CLAUDE.md on
// case-insensitive file systems.
const OUT = resolve('test-output/e2e');
const SHOTS = resolve('docs/images');

function findChrome(): string | undefined {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const base = join(homedir(), '.cache/lucian-cft/chrome');
  if (!existsSync(base)) return undefined;
  for (const dir of readdirSync(base).sort().reverse()) {
    for (const rel of [
      'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'chrome-linux64/chrome',
      'chrome-win64/chrome.exe',
    ]) {
      const p = join(base, dir, rel);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

const CHROME = findChrome();
const log = (...a: unknown[]) => process.env.E2E_DEBUG && process.stderr.write(`[e2e] ${a.map(String).join(' ')}\n`);
let browser: Browser;
let extId = '';
let downloads = '';
let popup: Page;
const sessions: CDPSession[] = [];

async function intercept(session: CDPSession): Promise<void> {
  sessions.push(session);
  session.on('Fetch.requestPaused', async (ev: { requestId: string; request: { url: string; method: string; headers: Record<string, string>; postData?: string } }) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(ev.request.headers)) headers[k.toLowerCase()] = v;
    const res = route({ url: ev.request.url, method: ev.request.method, headers, postData: ev.request.postData });
    try {
      if (!res) {
        await session.send('Fetch.failRequest', { requestId: ev.requestId, errorReason: 'BlockedByClient' });
        return;
      }
      const body = typeof res.body === 'string' ? Buffer.from(res.body, 'utf8') : Buffer.from(res.body);
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

async function attach(target: Target): Promise<void> {
  const type = target.type();
  // Only tabs and the extension service worker issue the requests the mocks answer. Dedicated
  // workers and the offscreen document are left alone.
  if (type !== 'page' && type !== 'service_worker') return;
  try {
    await intercept(await target.createCDPSession());
  } catch {
    /* not attachable */
  }
}

async function tabIdFor(url: string): Promise<number> {
  return popup.evaluate(async (u) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((t) => t.url === u)?.id ?? -1;
  }, url);
}

async function waitJob(tabId: number, predicate: (j: JobState) => boolean, timeoutMs = 60_000): Promise<JobState> {
  const t0 = Date.now();
  for (;;) {
    const job = (await popup.evaluate(async (id) => (await chrome.storage.session.get(`job:${id}`))[`job:${id}`], tabId)) as JobState | undefined;
    if (job && predicate(job)) return job;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for job: ${JSON.stringify(job)}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

function newestDownload(ext: string, since: number): string {
  const files = readdirSync(downloads)
    .filter((f) => f.endsWith(`.${ext}`) && !f.endsWith('.crdownload'))
    .map((f) => ({ f, t: statSync(join(downloads, f)).mtimeMs }))
    .filter((x) => x.t >= since - 1000)
    .sort((a, b) => b.t - a.t);
  if (!files.length) throw new Error(`no .${ext} download (files: ${readdirSync(downloads).join(', ')})`);
  return join(downloads, files[0].f);
}

async function openPopupFor(site: keyof typeof PAGES): Promise<number> {
  const page = await browser.newPage();
  log('open', site);
  await page.goto(PAGES[site], { waitUntil: 'load' });
  log('site loaded', site);
  await new Promise((r) => setTimeout(r, 400));
  const tabId = await tabIdFor(PAGES[site]);
  log('tab', tabId);
  expect(tabId).toBeGreaterThan(0);
  // Headless Chrome does not paint background tabs, so input events sent to them never complete.
  await popup.bringToFront();
  await popup.goto(`chrome-extension://${extId}/popup.html?tabId=${tabId}`, { waitUntil: 'load' });
  await popup.waitForSelector('#handoffBtn:not([disabled])');
  return tabId;
}

async function runAndWait(tabId: number, selector: string, timeoutMs = 60_000): Promise<{ job: JobState; ms: number }> {
  const t0 = Date.now();
  if (selector.includes('data-format') && !(await popup.$eval('#moreFormats', (el) => !(el as HTMLElement).hidden)) && /hwpx|html|txt|json|zip/.test(selector)) {
    await popup.click('#moreBtn');
  }
  await popup.click(selector);
  log('clicked', selector);
  const job = await waitJob(tabId, (j) => j.startedAt >= t0 - 50 && ['done', 'error', 'print'].includes(j.phase) && (j.phase !== 'print' || !!j.result), timeoutMs);
  return { job, ms: Date.now() - t0 };
}

const describeIf = CHROME && existsSync(join(DIST, 'manifest.json')) ? describe : describe.skip;

describeIf('extension E2E (Chrome for Testing, mocked sites)', () => {
  const report: Record<string, unknown>[] = [];

  beforeAll(async () => {
    rmSync(OUT, { recursive: true, force: true });
    mkdirSync(OUT, { recursive: true });
    mkdirSync(SHOTS, { recursive: true });
    downloads = mkdtempSync(join(tmpdir(), 'lucian-dl-'));
    // Download directory via profile preferences (not CDP download overrides), so files keep the
    // names chosen by the extension through chrome.downloads, as in a normal browser.
    const profile = mkdtempSync(join(tmpdir(), 'lucian-profile-'));
    mkdirSync(join(profile, 'Default'), { recursive: true });
    writeFileSync(
      join(profile, 'Default', 'Preferences'),
      JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false, directory_upgrade: true }, savefile: { default_directory: downloads } }),
    );
    // A second extension that answers onDeterminingFilename for every download, like download
    // managers (Video DownloadHelper…) do. With it installed Chrome ignored the filename given to
    // chrome.downloads.download and saved blob downloads under their UUID (seen on a user's Chrome).
    const manager = mkdtempSync(join(tmpdir(), 'lucian-dlmanager-'));
    writeFileSync(
      join(manager, 'manifest.json'),
      JSON.stringify({ manifest_version: 3, name: 'Download manager (test)', version: '1.0', permissions: ['downloads'], background: { service_worker: 'dm.js' } }),
    );
    writeFileSync(join(manager, 'dm.js'), 'chrome.downloads.onDeterminingFilename.addListener((item, suggest) => { suggest({ filename: item.filename }); });\n');
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      userDataDir: profile,
      // GitHub's Ubuntu runners restrict unprivileged user namespaces, which Chrome's sandbox needs.
      args: [`--disable-extensions-except=${manager},${DIST}`, `--load-extension=${manager},${DIST}`, '--no-first-run', '--no-default-browser-check', '--lang=ko-KR', ...(process.env.CI ? ['--no-sandbox'] : [])],
      defaultViewport: { width: 1280, height: 900 },
    });
    log('launched');
    browser.on('targetcreated', (t: Target) => {
      log('target', t.type(), t.url());
      void attach(t);
    });
    const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'), { timeout: 20_000 });
    extId = new URL(sw.url()).host;
    log('extension', extId);
    await attach(sw);
    log('attached sw');
    popup = await browser.newPage();
    log('popup page created');
    await popup.setViewport({ width: 360, height: 640, deviceScaleFactor: 2 });
    log('viewport');
    await popup.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'load' });
    log('popup loaded');
  }, 60_000);

  afterAll(async () => {
    writeFileSync(join(OUT, 'e2e-report.json'), JSON.stringify({ chrome: CHROME, report, calls: [...new Set(calls)] }, null, 2));
    await browser?.close();
  });

  it('shows the unsupported-site notice outside AI sites', async () => {
    // Without the "tabs" permission the extension cannot read the URL of a non-AI tab, exactly as
    // in real use. Find the about:blank tab as the active tab of the window instead.
    const page = await browser.newPage();
    await page.goto('about:blank');
    await page.bringToFront();
    const id = await popup.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id ?? -1);
    expect(id).toBeGreaterThan(0);
    await popup.bringToFront();
    await popup.goto(`chrome-extension://${extId}/popup.html?tabId=${id}`, { waitUntil: 'load' });
    await popup.waitForSelector('#notice:not([hidden])');
    expect(await popup.$eval('#handoffBtn', (b) => (b as HTMLButtonElement).disabled)).toBe(true);
    await popup.screenshot({ path: join(SHOTS, 'popup-unsupported.png') });
    await page.close();
  });

  it('in-page button under finished answers starts a handoff on every site', async () => {
    // One button per answer toolbar; user-message toolbars get none.
    const expected = { chatgpt: 2, claude: 1, gemini: 1, grok: 1 } as const;
    for (const site of ['chatgpt', 'claude', 'gemini', 'grok'] as const) {
      const page = await browser.newPage();
      await page.goto(PAGES[site], { waitUntil: 'load' });
      await page.bringToFront();
      await page.waitForSelector('[data-lucian-action]', { timeout: 10_000 });
      await new Promise((r) => setTimeout(r, 400));
      expect(await page.$$eval('[data-lucian-action]', (els) => els.length), site).toBe(expected[site]);
      const trigger = await page.waitForSelector('[data-lucian-action] >>> button');
      await trigger!.click();
      const primary = await page.waitForSelector('[data-lucian-panel] >>> .primary', { visible: true });
      if (site === 'chatgpt') {
        await new Promise((r) => setTimeout(r, 300)); // let the fade-in finish
        const box = await page.$eval('[data-lucian-panel]', (h) => {
          const r = h.shadowRoot!.querySelector('.panel')!.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        });
        await page.screenshot({ path: join(SHOTS, 'page-button-panel.png'), clip: { x: Math.max(0, box.x - 16), y: Math.max(0, box.y - 16), width: box.width + 32, height: box.height + 72 } });
      }
      const t0 = Date.now();
      await primary!.click();
      const tabId = await tabIdFor(PAGES[site]);
      const job = await waitJob(tabId, (j) => j.startedAt >= t0 - 50 && ['done', 'error'].includes(j.phase));
      expect(job.phase, `${site}: ${JSON.stringify(job.error)}`).toBe('done');
      expect(job.result?.filename, site).toMatch(/^lucian-handoff-\d{4}-\d{2}-\d{2}( \(\d+\))?\.md$/);
      expect(job.result?.verification.checks.some((c) => c.code === 'download.renamed')).toBe(false);
      expect(job.result?.verification.level, `${site}: ${JSON.stringify(job.result?.verification.checks)}`).toBe('ok');
      expect(newestDownload('md', job.startedAt)).toMatch(/lucian-handoff-\d{4}-\d{2}-\d{2}( \(\d+\))?\.md$/);
      // The panel reports the result itself (UI language follows the browser: Korean or English;
      // headless Chrome on Linux ignores --lang for chrome.i18n).
      await page.waitForFunction(
        () => {
          const box = document.querySelector('[data-lucian-panel]')?.shadowRoot?.querySelector('.status');
          return box?.getAttribute('data-level') === 'ok' && /인수인계 파일을 저장했습니다|Handoff file saved/.test(box.querySelector('.title')?.textContent ?? '');
        },
        { timeout: 10_000 },
      );
      if (site === 'chatgpt') {
        const box = await page.$eval('[data-lucian-panel]', (h) => {
          const r = h.shadowRoot!.querySelector('.panel')!.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        });
        await page.screenshot({ path: join(SHOTS, 'page-button-done.png'), clip: { x: Math.max(0, box.x - 16), y: Math.max(0, box.y - 16), width: box.width + 32, height: box.height + 32 } });
      }
      await page.keyboard.press('Escape');
      expect(await page.$eval('[data-lucian-panel]', (h) => (h.shadowRoot!.querySelector('.panel') as HTMLElement).hidden)).toBe(true);
      if (site === 'claude') {
        // Hover-only toolbars: when the site removes its buttons, ours goes with them.
        await page.evaluate(() => document.querySelector('[data-testid="message-actions"] button')!.remove());
        await page.waitForFunction(() => !document.querySelector('[data-lucian-action]'), { timeout: 3000 });
      }
      await page.close();
    }
  }, 120_000);

  for (const site of ['chatgpt', 'claude', 'gemini', 'grok'] as const) {
    it(`${site}: handoff and every export format`, async () => {
      const tabId = await openPopupFor(site);

      // Handoff
      const h = await runAndWait(tabId, '#handoffBtn');
      expect(h.job.phase, JSON.stringify(h.job.error)).toBe('done');
      const handoffFile = newestDownload('md', h.job.startedAt);
      expect(handoffFile).toMatch(/lucian-handoff-\d{4}-\d{2}-\d{2}( \(\d+\))?\.md$/);
      const handoff = readFileSync(handoffFile, 'utf8');
      expect(handoff).toMatch(/## (0\. 기본 정보|0\. Source)/);
      expect(handoff).toMatch(/\[#m1\]/);
      expect(h.job.result?.verification.checks.some((c) => c.code === 'download.ok' && c.status === 'pass')).toBe(true);
      expect(h.job.result?.verification.checks.filter((c) => c.status === 'fail'), `${site}/handoff failed checks`).toEqual([]);
      expect(h.job.result?.verification.checks.find((c) => c.code === 'output.ok')?.status).toBe('pass');
      writeFileSync(join(OUT, `${site}-handoff.md`), handoff);
      report.push({ site, kind: 'handoff', ms: h.ms, timings: h.job.timings, level: h.job.result?.verification.level });
      if (site === 'chatgpt') {
        await popup.click('#detailsBtn');
        await popup.screenshot({ path: join(SHOTS, 'popup-handoff-done.png') });
      }

      for (const format of ['md', 'docx', 'hwpx', 'html', 'txt', 'json', 'zip'] as const) {
        const r = await runAndWait(tabId, `.fmt[data-format="${format}"]`);
        expect(r.job.phase, `${site}/${format}: ${JSON.stringify(r.job.error)}`).toBe('done');
        const v = r.job.result!.verification;
        const failed = v.checks.filter((c) => c.status === 'fail');
        expect(failed, `${site}/${format} failed checks`).toEqual([]);
        expect(v.checks.some((c) => c.code === 'messages.match' && c.status === 'pass')).toBe(true);
        expect(v.checks.some((c) => c.code === 'download.ok' && c.status === 'pass')).toBe(true);
        const file = newestDownload(format, r.job.startedAt);
        const bytes = readFileSync(file);
        expect(bytes.byteLength).toBe(r.job.result!.bytes);
        writeFileSync(join(OUT, `${site}-export.${format}`), bytes);
        if (format === 'docx' || format === 'hwpx' || format === 'zip') expect(() => unzipSync(new Uint8Array(bytes))).not.toThrow();
        if (format === 'json') expect(JSON.parse(bytes.toString('utf8')).conversation.messages.length).toBe(v.counts.messages);
        if (['docx', 'hwpx', 'html', 'zip'].includes(format) && v.counts.images > 0) {
          expect(v.checks.some((c) => c.code === 'images.all' && c.status === 'pass'), `${site}/${format} images`).toBe(true);
        }
        report.push({ site, kind: format, ms: r.ms, timings: r.job.timings, level: v.level, bytes: bytes.byteLength, images: `${v.counts.images - v.counts.imagesMissing}/${v.counts.images}` });
        if (site === 'chatgpt' && format === 'docx') await popup.screenshot({ path: join(SHOTS, 'popup-export-done.png') });
      }

      // ZIP backup contains the original attachment where the service exposes one (ChatGPT).
      if (site === 'chatgpt') {
        const zip = unzipSync(new Uint8Array(readFileSync(join(OUT, 'chatgpt-export.zip'))));
        const names = Object.keys(zip);
        expect(names.some((n) => n.endsWith('/attachments/spec.pdf'))).toBe(true);
        expect(names.some((n) => /\/images\/image-001\.png$/.test(n))).toBe(true);
        const md = strFromU8(zip[names.find((n) => n.endsWith('/conversation.md'))!]);
        expect(md).toContain('](attachments/spec.pdf)');
      }

      // PDF: print page renders locally; we also produce the actual PDF through Chrome's printer.
      const before = new Set((await browser.pages()).map((p) => p.url()));
      const p = await runAndWait(tabId, '.fmt[data-format="pdf"]');
      expect(p.job.phase).toMatch(/print|done/);
      expect(p.job.result?.verification.checks.find((c) => c.code === 'pdf.rendered')?.status).toBe('pass');
      const printPage = (await browser.pages()).find((pg) => pg.url().includes('/print.html') && !before.has(pg.url()));
      expect(printPage).toBeTruthy();
      const pdfPath = join(OUT, `${site}-export.pdf`);
      await printPage!.pdf({ path: pdfPath, format: 'A4', printBackground: true });
      expect(readFileSync(pdfPath).subarray(0, 5).toString()).toBe('%PDF-');
      report.push({ site, kind: 'pdf', ms: p.ms, level: p.job.result?.verification.level });
      if (site === 'chatgpt') {
        await printPage!.bringToFront();
        await printPage!.setViewport({ width: 900, height: 1200 });
        await printPage!.screenshot({ path: join(SHOTS, 'print-preview.png') });
      }
      await printPage!.close();
    }, 240_000);
  }

  it('1M-token conversation: handoff and exports through the whole extension (performance)', async () => {
    const tabId = await openPopupFor('big');
    const rows: Record<string, unknown>[] = [];
    const record = (kind: string, r: { job: JobState; ms: number }) => {
      const tm = Object.fromEntries(Object.entries(r.job.timings ?? {}).map(([k, v]) => [k, Math.round(v as number)]));
      const row = { kind, wallMs: r.ms, ...tm, bytes: r.job.result?.bytes, messages: r.job.result?.verification.counts.messages, handoff: r.job.result?.handoffStats };
      rows.push(row);
      log('1M', JSON.stringify(row));
      return row;
    };
    const cold = await runAndWait(tabId, '#handoffBtn', 300_000);
    expect(cold.job.phase, JSON.stringify(cold.job.error)).toBe('done');
    record('handoff (cold)', cold);
    // Requirement: < 10 s from "data acquired" to "Markdown done".
    expect(cold.job.timings.processMs ?? Infinity).toBeLessThan(10_000);
    expect(cold.job.result?.verification.checks.find((c) => c.code === 'messages.match')?.status).toBe('pass');
    const warm = await runAndWait(tabId, '#handoffBtn', 300_000);
    expect(warm.job.phase).toBe('done');
    record('handoff (warm cache)', warm);
    for (const format of ['md', 'html', 'docx', 'hwpx'] as const) {
      const r = await runAndWait(tabId, `.fmt[data-format="${format}"]`, 300_000);
      expect(r.job.phase, `${format}: ${JSON.stringify(r.job.error)}`).toBe('done');
      record(format, r);
    }
    const result = { chrome: CHROME?.match(/mac_arm-([\d.]+)/)?.[1] ?? CHROME, date: new Date().toISOString(), rows };
    writeFileSync(join(OUT, 'perf-1m.json'), JSON.stringify(result, null, 2));
    mkdirSync('bench-results', { recursive: true });
    writeFileSync('bench-results/e2e-chrome-1m.json', JSON.stringify(result, null, 2));
  }, 900_000);

  it('dark mode popup renders', async () => {
    const tabId = await tabIdFor(PAGES.chatgpt);
    await popup.bringToFront();
    await popup.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await popup.goto(`chrome-extension://${extId}/popup.html?tabId=${tabId}`, { waitUntil: 'load' });
    await popup.waitForSelector('#status:not([hidden])');
    await popup.screenshot({ path: join(SHOTS, 'popup-dark.png') });
    await popup.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    await popup.goto(`chrome-extension://${extId}/popup.html?tabId=${tabId}`, { waitUntil: 'load' });
    await popup.click('#moreBtn');
    await popup.screenshot({ path: join(SHOTS, 'popup-light.png') });
  });

  it('PDF text extraction keeps Korean text (pdftotext)', () => {
    try {
      // -layout spacing depends on font metrics (Noto CJK on Linux), so compare normalized text.
      const txt = execFileSync('pdftotext', ['-layout', join(OUT, 'chatgpt-export.pdf'), '-'], { encoding: 'utf8' }).replace(/\s+/g, ' ');
      expect(txt).toContain('Null 오류 분석');
      expect(txt).toContain('캔버스로 정리해 줘');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; // pdftotext not installed
      throw e;
    }
  });
});
