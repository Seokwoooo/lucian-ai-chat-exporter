// Offscreen document: builds output files away from the AI site's page and the popup, so long
// jobs continue when the popup closes. Handoff runs in a Web Worker; exporters are loaded on
// demand. Results are handed to the service worker as blob: URLs for chrome.downloads.

import { getAsset, getConversation } from '../shared/db';
import type { BuildRequest, BuildResponse } from '../shared/messages';
import type { Conversation, HandoffStats, JobTimings, VerificationCheck } from '../shared/types';
import { formatDate } from '../shared/util';
import { describeImage, EMBEDDABLE, type ImageStore, type StoredImage } from '../export/images';
import { buildVerification, levelOf, verifyTextOutput } from '../export/verify';
import type { WorkerMessage } from '../handoff/worker';

const urls = new Set<string>();

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;
  if (msg.type === 'build') {
    build(msg as BuildRequest)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) } satisfies BuildResponse));
    return true;
  }
  if (msg.type === 'revoke' && typeof msg.url === 'string') {
    URL.revokeObjectURL(msg.url);
    urls.delete(msg.url);
    sendResponse({ ok: true });
  }
  if (msg.type === 'ping') sendResponse({ ok: true });
  return false;
});

function progress(jobId: string, label: string): void {
  void chrome.runtime.sendMessage({ type: 'offscreen-progress', jobId, label }).catch(() => undefined);
}

function blobUrl(bytes: Uint8Array | string, mime: string): string {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  urls.add(url);
  return url;
}

async function build(req: BuildRequest): Promise<BuildResponse> {
  const t0 = performance.now();
  const conv = await getConversation(req.conversationKey);
  if (!conv) return { ok: false, error: 'conversation not found' };
  if (req.kind === 'handoff') return buildHandoff(req, conv);
  return buildExport(req, conv, t0);
}

// ---------- handoff ----------

function runWorker(req: BuildRequest): Promise<Extract<WorkerMessage, { type: 'done' }>> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(chrome.runtime.getURL('handoff-worker.js'), { type: 'module' });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('handoff worker timeout'));
    }, 5 * 60_000);
    worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
      const m = e.data;
      if (m.type === 'phase') progress(req.jobId, m.phase);
      else {
        clearTimeout(timer);
        worker.terminate();
        if (m.type === 'done') resolve(m);
        else reject(new Error(m.message));
      }
    };
    worker.onerror = (e) => {
      clearTimeout(timer);
      worker.terminate();
      reject(new Error(e.message || 'worker error'));
    };
    worker.postMessage({ type: 'handoff', conversationKey: req.conversationKey });
  });
}

async function buildHandoff(req: BuildRequest, conv: Conversation): Promise<BuildResponse> {
  const r = await runWorker(req);
  const bytes = new TextEncoder().encode(r.markdown);
  const headers = r.lang === 'ko' ? ['## 0. 기본 정보', '## 1. 핵심 목표', '## 2. 확정된 주요 결정', '## 5. 현재 진행 상황', '## 부록'] : ['## 0. Source', '## 1. Core goal', '## 2. Confirmed decisions', '## 5. Current state', '## Appendix'];
  const output = verifyTextOutput(bytes, headers);
  const verification = buildVerification(conv, 'handoff', { output, formatLabel: 'Markdown' });
  const extra: VerificationCheck[] = [];
  extra.push(
    r.stats.mode === 'full'
      ? { code: 'handoff.full', status: 'info' }
      : { code: 'handoff.compressed', status: 'info', params: { src: r.stats.sourceTokens.toLocaleString('en-US'), out: r.stats.outputTokens.toLocaleString('en-US') } },
  );
  if (r.stats.uncertain > 0) extra.push({ code: 'handoff.uncertain', status: 'info', params: { n: r.stats.uncertain } });
  if (r.stats.cacheHits > 0) extra.push({ code: 'handoff.cache', status: 'info', params: { hits: r.stats.cacheHits } });
  verification.checks.splice(1, 0, ...extra);
  verification.level = levelOf(verification.checks);
  const tm = r.timings;
  const timings: JobTimings = {
    loadMs: tm.loadMs,
    normalizeMs: tm.normalizeMs,
    dedupeMs: tm.dedupeMs,
    scoreMs: tm.scoreMs,
    renderMs: tm.renderMs,
    processMs: tm.loadMs + tm.normalizeMs + tm.dedupeMs + tm.scoreMs + tm.renderMs,
  };
  const stats: HandoffStats = {
    sourceTokens: r.stats.sourceTokens,
    outputTokens: r.stats.outputTokens,
    messages: r.stats.messages,
    decisions: r.stats.decisions,
    constraints: r.stats.constraints,
    openTasks: r.stats.openTasks,
    cacheHits: r.stats.cacheHits,
    cacheMisses: r.stats.cacheMisses,
    mode: r.stats.mode,
  };
  return {
    ok: true,
    blobUrl: blobUrl(bytes, 'text/markdown;charset=utf-8'),
    filename: `lucian-handoff-${formatDate(Date.now())}.md`,
    mime: 'text/markdown',
    bytes: bytes.byteLength,
    verification,
    handoffStats: stats,
    timings,
  };
}

// ---------- export ----------

async function toPng(blob: Blob): Promise<Uint8Array | undefined> {
  try {
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(blob);
    } catch {
      const url = URL.createObjectURL(blob);
      try {
        const img = new Image();
        img.src = url;
        await img.decode();
        bitmap = await createImageBitmap(img);
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    const canvas = new OffscreenCanvas(bitmap.width || 1, bitmap.height || 1);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
    bitmap.close();
    const out = await canvas.convertToBlob({ type: 'image/png' });
    return new Uint8Array(await out.arrayBuffer());
  } catch {
    return undefined;
  }
}

async function loadAssets(req: BuildRequest, needEmbeddable: boolean): Promise<{ raw: Map<string, StoredImage>; embeddable: ImageStore }> {
  const raw = new Map<string, StoredImage>();
  const embeddable: ImageStore = new Map();
  for (const a of req.assets) {
    if (!a.ok) continue;
    const rec = await getAsset(a.key);
    if (!rec) {
      a.ok = false;
      a.error = 'cache-miss';
      continue;
    }
    const bytes = new Uint8Array(await rec.blob.arrayBuffer());
    const stored = a.kind === 'image' ? describeImage(bytes, rec.mime) : { bytes, mime: rec.mime };
    raw.set(a.key, stored);
    if (a.kind === 'image' && needEmbeddable) {
      if (EMBEDDABLE.has(stored.mime)) embeddable.set(a.key, stored);
      else {
        const png = await toPng(rec.blob);
        if (png) embeddable.set(a.key, describeImage(png, 'image/png'));
      }
    }
  }
  return { raw, embeddable };
}

async function buildExport(req: BuildRequest, conv: Conversation, t0: number): Promise<BuildResponse> {
  const format = req.format;
  if (!format || format === 'pdf') return { ok: false, error: 'unsupported format' };
  progress(req.jobId, format);
  const { raw, embeddable } = await loadAssets(req, format === 'docx' || format === 'hwpx');
  const needsMath = format === 'html' || format === 'zip';
  const renderMath = needsMath ? (await import('../export/math')).renderMathMl : undefined;
  const { runExport } = await import('../export/pipeline');
  const parser = new DOMParser();
  const out = await runExport({
    conv,
    format,
    locale: req.locale,
    embeddable,
    raw,
    assetStatus: req.assets,
    renderMath,
    parseXml: (s) => parser.parseFromString(s, 'application/xml'),
    parseHtml: (s) => parser.parseFromString(s, 'text/html'),
    appVersion: chrome.runtime.getManifest().version,
  });
  return {
    ok: true,
    blobUrl: blobUrl(out.bytes, out.mime),
    filename: out.filename,
    mime: out.mime,
    bytes: out.bytes.byteLength,
    verification: out.verification,
    timings: { processMs: performance.now() - t0 },
  };
}
