// Service worker (tech doc §32): routes popup commands, keeps job state in chrome.storage.session
// so the popup can close and reopen at any time, collects the conversation from the content
// script, fetches assets (with a background fallback for CORS-blocked images), asks the
// offscreen document to build the file and downloads it with chrome.downloads.

import { cleanupCaches, getAsset, putAsset, putConversation } from '../shared/db';
import type { Locale } from '../shared/i18n';
import {
  COLLECT_PORT,
  jobStorageKey,
  type AssetRequest,
  type AssetStatus,
  type BuildRequest,
  type BuildResponse,
  type FromContent,
  type PopupRequest,
  type PrintReport,
} from '../shared/messages';
import { detectSite, extractConversationId } from '../shared/sites';
import type { Conversation, ExportFormat, JobKind, JobState, VerificationCheck } from '../shared/types';
import { base64ToBytes, sameDownloadName, sniffImageMime, uid } from '../shared/util';
import { collectAssetRequests } from '../export/images';
import { levelOf } from '../export/verify';

class JobError extends Error {
  constructor(
    public code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

const jobs = new Map<number, JobState>();
const running = new Set<number>();
const ASSET_FORMATS: ExportFormat[] = ['pdf', 'html', 'docx', 'hwpx', 'zip'];

// ---------- lifecycle ----------

chrome.runtime.onInstalled.addListener(() => void cleanupCaches().catch(() => undefined));
chrome.runtime.onStartup.addListener(() => void cleanupCaches().catch(() => undefined));

// ---------- job state ----------

let lastWrite = 0;
let pendingWrite: ReturnType<typeof setTimeout> | null = null;

async function saveJob(job: JobState, force = false): Promise<void> {
  jobs.set(job.tabId, job);
  const write = () => chrome.storage.session.set({ [jobStorageKey(job.tabId)]: job }).catch(() => undefined);
  const now = Date.now();
  if (force || now - lastWrite > 250) {
    lastWrite = now;
    if (pendingWrite) clearTimeout(pendingWrite);
    pendingWrite = null;
    await write();
  } else if (!pendingWrite) {
    pendingWrite = setTimeout(() => {
      pendingWrite = null;
      lastWrite = Date.now();
      void write();
    }, 250);
  }
}

async function getJob(tabId: number): Promise<JobState | null> {
  const mem = jobs.get(tabId);
  if (mem) return mem;
  const stored = await chrome.storage.session.get(jobStorageKey(tabId));
  const job = (stored[jobStorageKey(tabId)] as JobState | undefined) ?? null;
  // A job that was mid-flight when the service worker restarted cannot be resumed.
  if (job && !['done', 'error', 'print'].includes(job.phase) && !running.has(tabId)) {
    job.phase = 'error';
    job.error = { code: 'INTERRUPTED' };
    await saveJob(job, true);
  }
  return job;
}

function findJob(jobId: string): JobState | undefined {
  for (const j of jobs.values()) if (j.id === jobId) return j;
  return undefined;
}

/** Also looks in session storage: the service worker may have restarted while printing. */
async function findJobAnywhere(jobId: string): Promise<JobState | undefined> {
  const mem = findJob(jobId);
  if (mem) return mem;
  const all = await chrome.storage.session.get(null);
  for (const v of Object.values(all)) if ((v as JobState)?.id === jobId) return v as JobState;
  return undefined;
}

// ---------- message routing ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = msg as any;
  switch (m?.type) {
    case 'start-job': {
      const r = m as Extract<PopupRequest, { type: 'start-job' }>;
      const tabId = r.tabId ?? sender.tab?.id;
      if (tabId == null) {
        sendResponse({ ok: false, error: 'NO_TAB' });
        return false;
      }
      startJob(r.kind, r.format, tabId, r.locale).then(sendResponse);
      return true;
    }
    case 'get-job': {
      const tabId = (m as { tabId?: number }).tabId ?? sender.tab?.id;
      if (tabId == null) {
        sendResponse(null);
        return false;
      }
      getJob(tabId).then(sendResponse);
      return true;
    }
    case 'show-download':
      chrome.downloads.show((m as { downloadId: number }).downloadId);
      return false;
    case 'offscreen-progress': {
      const job = findJob(String((m as { jobId: string }).jobId));
      if (job && job.phase === 'processing') {
        job.progress = { label: String((m as { label: string }).label) };
        void saveJob(job);
      }
      return false;
    }
    case 'print-report': {
      const r = m as unknown as PrintReport;
      void findJobAnywhere(r.jobId).then((job) => {
        if (!job) return;
        job.result = { filename: `${job.title || 'conversation'}.pdf`, bytes: 0, verification: r.verification };
        job.timings.processMs = r.renderMs;
        job.phase = 'print';
        return saveJob(job, true);
      });
      return false;
    }
    case 'print-finished': {
      void findJobAnywhere(String((m as { jobId: string }).jobId)).then((job) => {
        if (!job) return;
        job.phase = 'done';
        job.finishedAt = Date.now();
        return saveJob(job, true);
      });
      return false;
    }
  }
  return false;
});

// ---------- job runner ----------

async function startJob(kind: JobKind, format: ExportFormat | undefined, tabId: number, locale: Locale): Promise<{ ok: boolean; jobId?: string; error?: string }> {
  if (running.has(tabId)) return { ok: false, error: 'BUSY' };
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.url) return { ok: false, error: 'NO_TAB' };
  const site = detectSite(tab.url);
  if (!site) return { ok: false, error: 'NOT_SUPPORTED' };
  if (!extractConversationId(site, tab.url)) return { ok: false, error: 'NOT_CONVERSATION' };
  const job: JobState = { id: uid('job-'), kind, format, tabId, site, phase: 'collecting', timings: {}, startedAt: Date.now() };
  running.add(tabId);
  await saveJob(job, true);
  void runJob(job, tab, locale)
    .catch(async (e) => {
      job.phase = 'error';
      job.error = { code: e instanceof JobError ? e.code : 'UNKNOWN', message: e instanceof Error ? e.message : String(e) };
      job.finishedAt = Date.now();
      await saveJob(job, true);
    })
    .finally(() => running.delete(tabId));
  return { ok: true, jobId: job.id };
}

async function runJob(job: JobState, tab: chrome.tabs.Tab, locale: Locale): Promise<void> {
  const tabId = job.tabId;
  const t0 = performance.now();
  // Retention is also enforced here, not only at browser start, for browsers left open for days.
  void cleanupCaches().catch(() => undefined);
  await ensureContentScript(tabId);
  const port = chrome.tabs.connect(tabId, { name: COLLECT_PORT });
  try {
    const conv = await collectConversation(port, job);
    job.timings.collectMs = performance.now() - t0;
    job.timings.networkMs = conv.extraction.networkMs;
    job.timings.parseMs = conv.extraction.parseMs;
    job.title = conv.title;
    const key = await putConversation(conv);

    let assets: AssetStatus[] = [];
    if (job.kind === 'export' && job.format && ASSET_FORMATS.includes(job.format)) {
      const requests = collectAssetRequests(conv, job.format === 'zip');
      if (requests.length) {
        job.phase = 'assets';
        job.progress = { done: 0, total: requests.length };
        await saveJob(job, true);
        const ta = performance.now();
        assets = await collectAssets(port, requests, job);
        job.timings.assetsMs = performance.now() - ta;
      }
    }
    port.disconnect();

    if (job.format === 'pdf') {
      job.phase = 'print';
      job.progress = undefined;
      await saveJob(job, true);
      const params = new URLSearchParams({ job: job.id, key, locale });
      await chrome.tabs.create({ url: chrome.runtime.getURL(`print.html?${params}`), index: (tab.index ?? 0) + 1, openerTabId: tabId });
      return;
    }

    job.phase = 'processing';
    job.progress = undefined;
    await saveJob(job, true);
    await ensureOffscreen();
    const res = (await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'build',
      jobId: job.id,
      conversationKey: key,
      kind: job.kind,
      format: job.format,
      locale,
      assets,
      appVersion: chrome.runtime.getManifest().version,
    } satisfies BuildRequest)) as BuildResponse | undefined;
    if (!res?.ok || !res.blobUrl || !res.filename || res.bytes == null || !res.verification) throw new JobError('BUILD_FAILED', res?.error);
    job.timings = { ...job.timings, ...res.timings };

    job.phase = 'downloading';
    await saveJob(job, true);
    const td = performance.now();
    const dl = await download(res.blobUrl, res.filename);
    job.timings.downloadMs = performance.now() - td;
    void chrome.runtime.sendMessage({ target: 'offscreen', type: 'revoke', url: res.blobUrl }).catch(() => undefined);

    const checks: VerificationCheck[] = [...res.verification.checks];
    if (dl.bytes === res.bytes) checks.push({ code: 'download.ok', status: 'pass', params: { size: res.bytes } });
    else checks.push({ code: 'download.mismatch', status: 'fail', params: { saved: dl.bytes, expected: res.bytes } });
    if (dl.filename && !sameDownloadName(dl.filename, res.filename)) checks.push({ code: 'download.renamed', status: 'warn', params: { name: dl.filename, expected: res.filename } });
    const verification = { ...res.verification, checks, level: levelOf(checks) };
    job.result = { filename: dl.filename || res.filename, bytes: res.bytes, verification, handoffStats: res.handoffStats, downloadId: dl.id };
    job.phase = 'done';
    job.finishedAt = Date.now();
    await saveJob(job, true);
  } finally {
    try {
      port.disconnect();
    } catch {
      /* already closed */
    }
  }
}

// ---------- content script plumbing ----------

async function ping(tabId: number): Promise<boolean> {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'lucian-ping' });
    return !!r?.ok;
  } catch {
    return false;
  }
}

/** Tabs opened before the extension was installed/updated have no content script yet. */
async function ensureContentScript(tabId: number): Promise<void> {
  if (await ping(tabId)) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['inject.js'], world: 'MAIN' });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch (e) {
    throw new JobError('CONTENT_UNAVAILABLE', e instanceof Error ? e.message : String(e));
  }
  for (let i = 0; i < 10; i++) {
    if (await ping(tabId)) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new JobError('CONTENT_UNAVAILABLE');
}

function collectConversation(port: chrome.runtime.Port, job: JobState): Promise<Conversation> {
  return new Promise((resolve, reject) => {
    let meta: Omit<Conversation, 'messages' | 'otherBranchMessages'> | null = null;
    const messages: Conversation['messages'] = [];
    const branches: NonNullable<Conversation['otherBranchMessages']> = [];
    let settled = false;
    const onMessage = (m: FromContent) => {
      switch (m.type) {
        case 'progress':
          job.progress = { label: m.label, done: m.done, total: m.total };
          void saveJob(job);
          break;
        case 'meta':
          meta = m.conversation;
          break;
        case 'messages':
          messages.push(...m.messages);
          job.progress = { label: 'messages', done: messages.length };
          void saveJob(job);
          break;
        case 'branches':
          branches.push(...m.branches);
          break;
        case 'done':
          settled = true;
          port.onMessage.removeListener(onMessage);
          if (!meta) reject(new JobError('PARSE', 'missing metadata'));
          else resolve({ ...meta, messages, otherBranchMessages: branches.length ? branches : undefined } as Conversation);
          break;
        case 'error':
          settled = true;
          port.onMessage.removeListener(onMessage);
          reject(new JobError(m.code, m.message));
          break;
      }
    };
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(() => {
      if (!settled) reject(new JobError('INTERRUPTED', chrome.runtime.lastError?.message));
    });
    port.postMessage({ type: 'collect' });
  });
}

/** Background fetch fallback (tech doc §32.3) for images the page context could not read (CORS). */
async function backgroundFetch(req: AssetRequest): Promise<{ blob: Blob; mime: string } | null> {
  if (!req.url || !/^https?:/i.test(req.url)) return null;
  try {
    const res = await fetch(req.url, { credentials: 'include' });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > 25 * 1024 * 1024) return null;
    const mime = req.kind === 'image' ? sniffImageMime(bytes) : res.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream';
    if (!mime) return null;
    return { blob: new Blob([bytes], { type: mime }), mime };
  } catch {
    return null;
  }
}

function collectAssets(port: chrome.runtime.Port, requests: AssetRequest[], job: JobState): Promise<AssetStatus[]> {
  return new Promise(async (resolve) => {
    const status = new Map<string, AssetStatus>();
    const toFetch: AssetRequest[] = [];
    // Reuse cached bytes (tech doc §30.5 image cache) when the same URL was fetched before.
    for (const r of requests) {
      const cached = await getAsset(r.key).catch(() => undefined);
      if (cached) status.set(r.key, { key: r.key, kind: r.kind, ok: true, mime: cached.mime, size: cached.size });
      else toFetch.push(r);
    }
    let done = status.size;
    const total = requests.length;
    const finish = () => resolve(requests.map((r) => status.get(r.key) ?? { key: r.key, kind: r.kind, ok: false, error: 'not-fetched' }));
    if (!toFetch.length) return finish();
    const byKey = new Map(toFetch.map((r) => [r.key, r]));
    const pending: Promise<void>[] = [];
    const onMessage = (m: FromContent) => {
      if (m.type === 'asset') {
        const req = byKey.get(m.key);
        if (!req) return;
        pending.push(
          (async () => {
            if (m.ok && m.base64) {
              const mime = m.mime ?? 'application/octet-stream';
              await putAsset(m.key, new Blob([base64ToBytes(m.base64) as BlobPart], { type: mime }), mime);
              status.set(m.key, { key: m.key, kind: req.kind, ok: true, mime, size: m.size });
            } else {
              const fb = await backgroundFetch(req);
              if (fb) {
                await putAsset(m.key, fb.blob, fb.mime);
                status.set(m.key, { key: m.key, kind: req.kind, ok: true, mime: fb.mime, size: fb.blob.size });
              } else {
                status.set(m.key, { key: m.key, kind: req.kind, ok: false, error: m.error ?? 'unavailable' });
              }
            }
            done++;
            job.progress = { label: 'assets', done, total };
            void saveJob(job);
          })(),
        );
      } else if (m.type === 'assets-done') {
        port.onMessage.removeListener(onMessage);
        void Promise.all(pending).then(finish);
      }
    };
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(() => void Promise.all(pending).then(finish));
    port.postMessage({ type: 'assets', items: toFetch });
  });
}

// ---------- offscreen & downloads ----------

let creating: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  const has = await (chrome.offscreen as unknown as { hasDocument?: () => Promise<boolean> }).hasDocument?.();
  if (has) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: 'offscreen.html',
        reasons: [chrome.offscreen.Reason.WORKERS, chrome.offscreen.Reason.BLOBS],
        justification: 'Builds export files and runs the handoff analysis worker locally.',
      })
      .catch((e: unknown) => {
        if (!String(e).includes('single offscreen')) throw e;
      })
      .finally(() => {
        creating = null;
      });
  }
  await creating;
}

// Download managers (e.g. Video DownloadHelper) answer onDeterminingFilename for every download,
// and Chrome then ignores the filename passed to downloads.download(): a blob: download ends up
// named after the blob UUID. Suggesting our own name for our own downloads restores it (the most
// recently installed extension's suggestion wins). Other downloads are left untouched.
const pendingNames = new Map<string, string>();

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const name = item.byExtensionId === chrome.runtime.id ? pendingNames.get(item.url) ?? pendingNames.get(item.finalUrl) : undefined;
  if (name) suggest({ filename: name, conflictAction: 'uniquify' });
});

function download(url: string, filename: string): Promise<{ id: number; bytes: number; filename: string }> {
  pendingNames.set(url, filename);
  return new Promise<{ id: number; bytes: number; filename: string }>((resolve, reject) => {
    let id = -1;
    const timer = setTimeout(() => {
      chrome.downloads.onChanged.removeListener(onChanged);
      reject(new JobError('DOWNLOAD_FAILED', 'timeout'));
    }, 10 * 60_000);
    const check = async () => {
      const [item] = await chrome.downloads.search({ id });
      if (!item) return;
      if (item.state === 'complete') {
        clearTimeout(timer);
        chrome.downloads.onChanged.removeListener(onChanged);
        resolve({ id, bytes: item.fileSize > 0 ? item.fileSize : item.bytesReceived, filename: item.filename.split(/[\\/]/).pop() ?? filename });
      } else if (item.state === 'interrupted') {
        clearTimeout(timer);
        chrome.downloads.onChanged.removeListener(onChanged);
        reject(new JobError('DOWNLOAD_FAILED', item.error));
      }
    };
    const onChanged = (delta: chrome.downloads.DownloadDelta) => {
      if (delta.id === id && delta.state) void check();
    };
    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads
      .download({ url, filename, saveAs: false, conflictAction: 'uniquify' })
      .then((newId) => {
        id = newId;
        void check();
      })
      .catch((e) => {
        clearTimeout(timer);
        chrome.downloads.onChanged.removeListener(onChanged);
        reject(new JobError('DOWNLOAD_FAILED', e instanceof Error ? e.message : String(e)));
      });
  }).finally(() => pendingNames.delete(url));
}
