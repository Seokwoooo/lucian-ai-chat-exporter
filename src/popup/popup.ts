// Popup: two features only — one-click handoff and full export. All work runs in the service
// worker / offscreen document, so the popup can be closed at any time and reopened to see the
// state of the job for the current tab.

import { detectLocale, formatBytes, formatMs, t, type Locale, type MessageKey } from '../shared/i18n';
import { jobStorageKey } from '../shared/messages';
import { SITES, detectSite, extractConversationId } from '../shared/sites';
import type { ExportFormat, JobKind, JobState, VerificationCheck } from '../shared/types';
import { checkText } from '../export/report';

const locale: Locale = detectLocale(chrome.i18n?.getUILanguage?.() ?? navigator.language);
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const PRIMARY: ExportFormat[] = ['pdf', 'md', 'docx'];
const MORE: ExportFormat[] = ['hwpx', 'html', 'txt', 'json', 'zip'];
const BADGE: Record<ExportFormat, string> = { pdf: 'PDF', md: 'MD', docx: 'W', hwpx: '한', html: '</>', txt: 'TXT', json: '{ }', zip: 'ZIP' };
const MORE_KEY = 'lucian.moreFormats';

let tabId: number | null = null;
let enabled = false;
let current: JobState | null = null;
let showDetails = false;

function fileIcon(label: string): string {
  const size = label.length >= 4 ? 6.2 : label.length === 3 ? 7 : 8.5;
  return (
    `<svg class="fmt-icon" viewBox="0 0 26 30" aria-hidden="true">` +
    `<path d="M3.5 1.5h12.5l6.5 6.5v20.5h-19z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>` +
    `<path d="M16 1.5v6.5h6.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>` +
    `<text x="13" y="21.5" text-anchor="middle" font-size="${size}" font-weight="700" fill="currentColor" font-family="system-ui,-apple-system,'Apple SD Gothic Neo','Malgun Gothic',sans-serif">${label.replace('<', '&lt;').replace('>', '&gt;')}</text>` +
    `</svg>`
  );
}

function formatButton(f: ExportFormat): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'fmt';
  b.dataset.format = f;
  const label = t(locale, `format.${f}` as MessageKey);
  const hint = f === 'pdf' ? t(locale, 'format.hint.pdf') : f === 'zip' ? t(locale, 'format.hint.zip') : '';
  b.innerHTML = `${fileIcon(BADGE[f])}<span class="fmt-label"></span>`;
  b.querySelector('.fmt-label')!.textContent = label;
  b.setAttribute('aria-label', hint ? `${label} — ${hint}` : label);
  if (hint) b.title = hint;
  b.addEventListener('click', () => start('export', f));
  return b;
}

const ICONS = {
  spin: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-opacity=".25" stroke-width="3"/><path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>',
  ok: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="m7.5 12.5 3 3 6-6.5" fill="none" stroke="var(--bg)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  warn: '<svg viewBox="0 0 24 24"><path d="M12 2.5 22.5 21h-21z" fill="currentColor"/><path d="M12 9.5v5M12 17.6v.01" stroke="var(--bg)" stroke-width="2.4" stroke-linecap="round"/></svg>',
  err: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="m8.5 8.5 7 7m0-7-7 7" stroke="var(--bg)" stroke-width="2.4" stroke-linecap="round"/></svg>',
  print: '<svg viewBox="0 0 24 24"><path d="M7 9V3h10v6M7 17H4v-7h16v7h-3M7 14h10v7H7z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
};

function setEnabled(on: boolean): void {
  enabled = on;
  const busy = !!current && !['done', 'error', 'print'].includes(current.phase);
  for (const el of document.querySelectorAll<HTMLButtonElement>('#handoffBtn, .fmt')) el.disabled = !on || busy;
}

async function init(): Promise<void> {
  document.documentElement.lang = locale;
  for (const el of document.querySelectorAll<HTMLElement>('[data-i18n]')) el.textContent = t(locale, el.dataset.i18n as MessageKey);
  $('version').textContent = `v${chrome.runtime.getManifest().version}`;
  $('privacy').textContent = locale === 'ko' ? '브라우저 안에서만 처리' : 'Processed locally';
  requestAnimationFrame(() => requestAnimationFrame(() => (document.body.dataset.ready = '1')));

  const primary = $('primaryFormats');
  for (const f of PRIMARY) primary.appendChild(formatButton(f));
  const more = $('moreFormats');
  for (const f of MORE) more.appendChild(formatButton(f));
  let expanded = false;
  try {
    expanded = localStorage.getItem(MORE_KEY) === '1';
  } catch {
    /* storage unavailable */
  }
  const applyMore = () => {
    more.hidden = !expanded;
    $('moreBtn').setAttribute('aria-expanded', String(expanded));
    $('moreLabel').textContent = t(locale, expanded ? 'export.less' : 'export.more');
  };
  applyMore();
  $('moreBtn').addEventListener('click', () => {
    expanded = !expanded;
    applyMore();
    try {
      localStorage.setItem(MORE_KEY, expanded ? '1' : '0');
    } catch {
      /* ignore */
    }
  });
  $('handoffBtn').addEventListener('click', () => start('handoff'));
  $('detailsBtn').addEventListener('click', () => {
    showDetails = !showDetails;
    render(current);
  });
  $('openBtn').addEventListener('click', () => {
    const id = current?.result?.downloadId;
    if (id != null) void chrome.runtime.sendMessage({ type: 'show-download', downloadId: id });
  });
  $('retryBtn').addEventListener('click', () => {
    if (current) start(current.kind, current.format);
  });

  // Resolve the tab: the active tab normally; ?tabId= is used by automated tests.
  const q = new URLSearchParams(location.search).get('tabId');
  let tab: chrome.tabs.Tab | undefined;
  if (q) tab = await chrome.tabs.get(Number(q)).catch(() => undefined);
  else [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;
  const url = tab?.url ?? '';
  const site = detectSite(url);
  if (!site) {
    showNotice(t(locale, 'site.unsupported.title'), t(locale, 'site.unsupported.desc'), true);
    setEnabled(false);
  } else {
    $('site').hidden = false;
    $('siteName').textContent = SITES[site].name;
    if (!extractConversationId(site, url)) {
      showNotice(t(locale, 'site.noConversation.title'), t(locale, 'site.noConversation.desc', { site: SITES[site].name }), false);
      setEnabled(false);
    } else {
      const title = (tab?.title ?? '').replace(new RegExp(`\\s*[-|–—]\\s*${SITES[site].name}\\s*$`, 'i'), '').trim();
      if (title && title.toLowerCase() !== SITES[site].name.toLowerCase()) $('context').textContent = title;
      setEnabled(true);
    }
  }

  if (tabId != null) {
    const job = (await chrome.runtime.sendMessage({ type: 'get-job', tabId }).catch(() => null)) as JobState | null;
    render(job);
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'session' || tabId == null) return;
      const c = changes[jobStorageKey(tabId)];
      if (c) render((c.newValue as JobState | undefined) ?? null);
    });
  }
}

function showNotice(title: string, desc: string, links: boolean): void {
  $('notice').hidden = false;
  $('noticeTitle').textContent = title;
  $('noticeDesc').textContent = desc;
  const box = $('siteLinks');
  box.innerHTML = '';
  if (links) {
    for (const s of Object.values(SITES)) {
      const a = document.createElement('a');
      a.href = s.home;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = s.name;
      box.appendChild(a);
    }
  }
}

async function start(kind: JobKind, format?: ExportFormat): Promise<void> {
  if (tabId == null || !enabled) return;
  showDetails = false;
  const res = (await chrome.runtime.sendMessage({ type: 'start-job', kind, format, tabId, locale }).catch((e) => ({ ok: false, error: String(e) }))) as {
    ok: boolean;
    error?: string;
  };
  if (!res?.ok) {
    render({
      id: 'local',
      kind,
      format,
      tabId,
      phase: 'error',
      timings: {},
      startedAt: Date.now(),
      error: { code: res?.error === 'BUSY' ? 'BUSY' : res?.error ?? 'UNKNOWN' },
    });
  }
}

function formatName(job: JobState): string {
  return job.format ? t(locale, `format.${job.format}` as MessageKey) : 'Markdown';
}

function errorText(code: string): string {
  if (code === 'BUSY') return t(locale, 'busy');
  const key = `error.${code}` as MessageKey;
  const s = t(locale, key);
  return s === key ? t(locale, 'error.UNKNOWN') : s;
}

function progressText(job: JobState): string {
  const p = job.progress;
  if (!p) return '';
  if (p.label === 'pages' && p.done) return t(locale, 'progress.pages', { done: p.done });
  if (p.label === 'messages' && p.done) return t(locale, 'progress.messages', { done: p.done.toLocaleString() });
  if (p.label === 'assets' && p.total) return t(locale, 'progress.assets', { done: p.done ?? 0, total: p.total });
  return '';
}

function render(job: JobState | null): void {
  current = job;
  const box = $('status');
  if (!job) {
    box.hidden = true;
    setEnabled(enabled);
    return;
  }
  box.hidden = false;
  const icon = $('statusIcon');
  const text = $('statusText');
  const sub = $('statusSub');
  const progress = $('progress');
  const bar = $('progressBar');
  const timings = $('timings');
  const details = $('detailsBtn');
  const open = $('openBtn');
  const retry = $('retryBtn');
  const checks = $<HTMLUListElement>('checks');
  icon.className = 'status-icon';
  sub.textContent = '';
  timings.innerHTML = '';
  details.hidden = true;
  open.hidden = true;
  retry.hidden = true;
  checks.hidden = true;
  progress.hidden = true;
  box.dataset.level = '';

  const running = !['done', 'error', 'print'].includes(job.phase);
  if (running) {
    icon.classList.add('spin');
    icon.innerHTML = ICONS.spin;
    const key: MessageKey =
      job.phase === 'collecting' || job.phase === 'queued'
        ? 'phase.collecting'
        : job.phase === 'assets'
          ? 'phase.assets'
          : job.phase === 'processing'
            ? job.kind === 'handoff'
              ? 'phase.processing.handoff'
              : 'phase.processing.export'
            : 'phase.downloading';
    text.textContent = t(locale, key, { format: formatName(job) });
    sub.textContent = progressText(job);
    progress.hidden = false;
    const p = job.progress;
    if (p?.total && p.done != null) {
      progress.dataset.indeterminate = 'false';
      bar.style.width = `${Math.max(4, Math.round((p.done / p.total) * 100))}%`;
    } else {
      progress.dataset.indeterminate = 'true';
      bar.style.width = '';
    }
  } else if (job.phase === 'error') {
    box.dataset.level = 'error';
    icon.innerHTML = ICONS.err;
    text.textContent = t(locale, 'phase.error');
    sub.textContent = errorText(job.error?.code ?? 'UNKNOWN');
    retry.hidden = job.error?.code === 'NOT_SUPPORTED' || job.error?.code === 'NOT_CONVERSATION';
    retry.textContent = t(locale, 'result.retry');
  } else {
    const v = job.result?.verification;
    const level = v?.level ?? 'ok';
    box.dataset.level = job.phase === 'print' && !v ? '' : level;
    icon.innerHTML = job.phase === 'print' ? ICONS.print : level === 'ok' ? ICONS.ok : level === 'warning' ? ICONS.warn : ICONS.err;
    if (job.phase === 'print') {
      text.textContent = t(locale, 'phase.print');
    } else if (job.format === 'pdf') {
      text.textContent = t(locale, 'phase.done.print');
    } else {
      text.textContent = t(locale, job.kind === 'handoff' ? 'phase.done.handoff' : 'phase.done.export', { format: formatName(job) });
    }
    const parts: string[] = [];
    if (job.result?.filename && job.format !== 'pdf') parts.push(job.result.filename);
    if (v) parts.push(t(locale, 'result.messages', { n: v.counts.messages }));
    if (v && v.counts.images > 0 && job.kind === 'export' && ['pdf', 'html', 'docx', 'hwpx', 'zip'].includes(job.format ?? '')) {
      parts.push(t(locale, 'result.images', { ok: v.counts.images - v.counts.imagesMissing, total: v.counts.images }));
    }
    const hs = job.result?.handoffStats;
    if (hs) parts.push(t(locale, 'result.tokens', { src: hs.sourceTokens.toLocaleString(), out: hs.outputTokens.toLocaleString() }));
    if (job.result?.bytes) parts.push(formatBytes(job.result.bytes));
    sub.textContent = parts.join(' · ');
    if (v?.checks.length) {
      details.hidden = false;
      details.textContent = t(locale, showDetails ? 'result.hideDetails' : 'result.details');
      details.setAttribute('aria-expanded', String(showDetails));
      if (showDetails) {
        checks.hidden = false;
        checks.innerHTML = '';
        for (const c of v.checks) checks.appendChild(checkItem(c));
      }
    }
    if (job.result?.downloadId != null) {
      open.hidden = false;
      open.textContent = t(locale, 'result.openFile');
    }
  }

  const tm = job.timings ?? {};
  const rows: Array<[MessageKey, number | undefined]> = [
    ['timing.network', tm.networkMs],
    ['timing.collect', tm.collectMs],
    ['timing.assets', tm.assetsMs],
    ['timing.build', tm.processMs],
    ['timing.save', tm.downloadMs],
  ];
  timings.innerHTML = rows
    .filter(([, v]) => v != null)
    .map(([k, v]) => `<span title="${t(locale, `${k}.hint` as MessageKey)}">${t(locale, k)} <b>${formatMs(v)}</b></span>`)
    .join('');
  setEnabled(enabled);
}

function checkItem(c: VerificationCheck): HTMLLIElement {
  const li = document.createElement('li');
  li.dataset.s = c.status;
  const icon = document.createElement('span');
  icon.className = 'ci';
  icon.textContent = c.status === 'pass' ? '✓' : c.status === 'warn' ? '!' : c.status === 'fail' ? '✗' : '·';
  const span = document.createElement('span');
  span.textContent = checkText(locale, c);
  li.append(icon, span);
  return li;
}

void init();
