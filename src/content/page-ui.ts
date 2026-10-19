// In-page entry point: a small Lucian button in the action toolbar under each finished assistant
// answer (next to copy / retry). It opens a panel with the same two features as the popup —
// handoff and full export — and shows the job's progress and result. Everything lives in shadow
// roots so the site's styles and ours never mix, and the button is re-added if the site re-renders
// its toolbar. The page's own controls are never moved or changed.

import { checkText } from '../export/report';
import { detectLocale, formatBytes, t, type Locale, type MessageKey } from '../shared/i18n';
import type { ExportFormat, JobKind, JobState, MdImageMode } from '../shared/types';
import { HANDOFF_VISUAL_CSS, handoffVisualHtml } from '../shared/handoff-visual';
import { FORMAT_LOGOS, IMAGE_ICON, MD_CHOICE_CSS, mdChoiceDarkCss, mdChoiceHtml } from '../shared/ui-icons';
import type { SiteAdapter } from './adapters/types';

const HOST_ATTR = 'data-lucian-action';
// Same order as the popup (v1.3.7): Markdown first, Word under "more formats".
const PRIMARY: ExportFormat[] = ['md', 'pdf', 'txt'];
const MORE: ExportFormat[] = ['docx', 'hwpx', 'html', 'json', 'zip'];
// 'choose': a Markdown export of a chat with images waits for the user's choice (v1.3.6).
const TERMINAL = ['done', 'error', 'print', 'choose'];

// The mark is drawn with a violet → cyan gradient (the same family as the illustration's arc).
const LOGO =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c5cff"/><stop offset=".55" stop-color="#4f7cff"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs><rect x="3.25" y="3.25" width="17.5" height="17.5" rx="5" fill="none" stroke="url(#lg)" stroke-width="1.8"/><path d="M9.6 8v8.2h5.2" fill="none" stroke="url(#lg)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON = {
  spin: '<svg viewBox="0 0 24 24" class="spin" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-opacity=".25" stroke-width="3"/><path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>',
  ok: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="m7.5 12.5 3 3 6-6.5" fill="none" stroke="var(--bg)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  warn: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5 22.5 21h-21z" fill="currentColor"/><path d="M12 9.5v5M12 17.6v.01" stroke="var(--bg)" stroke-width="2.4" stroke-linecap="round"/></svg>',
  err: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="m8.5 8.5 7 7m0-7-7 7" stroke="var(--bg)" stroke-width="2.4" stroke-linecap="round"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  image: IMAGE_ICON,
};

// Toolbar button: the site's own icons are flat, so Lucian's is marked by a soft neon ring
// (rotating violet/cyan gradient, low opacity) and a slow "breathing" glow — visible, not loud.
const BUTTON_CSS = `
:host { all: initial; display: inline-flex; vertical-align: middle; color: inherit; }
button {
  all: unset; box-sizing: border-box; position: relative; isolation: isolate; display: inline-flex; align-items: center; justify-content: center;
  width: var(--size, 32px); height: var(--size, 32px); border-radius: 10px; cursor: pointer; color: inherit;
  transition: transform .18s ease;
}
.halo { position: absolute; inset: 2px; z-index: -2; border-radius: 10px; pointer-events: none;
  background: radial-gradient(closest-side, rgba(124, 92, 255, .42), rgba(34, 211, 238, .16) 65%, transparent);
  filter: blur(3px); opacity: .5; animation: breathe 3.6s ease-in-out infinite; }
.ring { position: absolute; inset: 3px; z-index: -1; border-radius: 9px; padding: 1.3px; overflow: hidden; pointer-events: none; opacity: .62;
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor;
  mask: linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0); transition: opacity .18s ease; }
.ring::before { content: ''; position: absolute; inset: -60%; background: conic-gradient(#7c5cff, #22d3ee, #a855f7, #4f7cff, #7c5cff); animation: spin 7s linear infinite; }
button:hover, button[aria-expanded="true"] { transform: scale(1.06); }
button:hover .ring, button[aria-expanded="true"] .ring { opacity: 1; }
button:hover .halo, button[aria-expanded="true"] .halo { opacity: .95; animation-duration: 2.2s; }
button:active { transform: scale(.96); }
button[data-busy="true"] .ring::before { animation-duration: 1.6s; }
button:focus-visible { outline: 2px solid #7c5cff; outline-offset: 1px; }
svg { width: 18px; height: 18px; filter: drop-shadow(0 0 2.5px rgba(124, 92, 255, .55)); }
/* The icon wrapper turns (compositor animation), so the spinner keeps turning while the page is busy. */
.icon.spinning { animation: spin .9s linear infinite; will-change: transform; }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes breathe { 0%, 100% { opacity: .38; transform: scale(.94); } 50% { opacity: .72; transform: scale(1.04); } }
@media (prefers-reduced-motion: reduce) { .halo, .ring::before, .icon.spinning { animation: none; } button { transition: none; } }
`;

const PANEL_CSS = `
:host { all: initial; }
.panel {
  --bg: #ffffff; --surface: #f6f6f7; --surface-hover: #ececef; --border: #e4e4e8; --text: #17171a;
  --muted: #6b6b73; --primary: #17171a; --primary-ink: #ffffff; --ok: #15803d; --warn: #b45309; --err: #c2410c;
  position: fixed; z-index: 2147483646; width: 304px; max-height: min(560px, calc(100vh - 16px)); overflow: auto;
  box-sizing: border-box; padding: 12px; border-radius: 14px; background: var(--bg); color: var(--text);
  border: 1px solid var(--border); box-shadow: 0 12px 32px rgba(0,0,0,.16), 0 2px 6px rgba(0,0,0,.08);
  font: 13px/1.5 system-ui, -apple-system, "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", sans-serif;
  word-break: keep-all; overflow-wrap: anywhere; -webkit-font-smoothing: antialiased;
  opacity: 0; transform: translateY(4px); transition: opacity .14s ease, transform .14s ease;
}
.panel.dark {
  --bg: #1b1b1e; --surface: #242428; --surface-hover: #2e2e33; --border: #34343a; --text: #f2f2f4;
  --muted: #a0a0a8; --primary: #f2f2f4; --primary-ink: #131315; --ok: #4ade80; --warn: #fbbf24; --err: #fb923c;
  box-shadow: 0 12px 32px rgba(0,0,0,.5);
}
.panel.open { opacity: 1; transform: none; }
@media (prefers-reduced-motion: reduce) { .panel { transition: none; } }
* { box-sizing: border-box; }
button { font: inherit; color: inherit; cursor: pointer; }
button:focus-visible { outline: 2px solid #6366f1; outline-offset: 2px; }
[hidden] { display: none !important; }
.top { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.top svg { width: 20px; height: 20px; flex: none; }
.top b { font-weight: 650; font-size: 13.5px; flex: 1; }
.x { all: unset; display: inline-flex; width: 26px; height: 26px; align-items: center; justify-content: center; border-radius: 7px; color: var(--muted); cursor: pointer; }
.x:hover { background: var(--surface); color: var(--text); }
.x svg { width: 16px; height: 16px; }
.card { padding: 10px; border-radius: 11px; background: var(--surface); }
.card + .card { margin-top: 8px; }
.card h3 { margin: 0; font-size: 13px; font-weight: 650; }
.card p { margin: 2px 0 8px; color: var(--muted); font-size: 12px; }
.primary { width: 100%; padding: 8px 10px; border: 0; border-radius: 9px; background: var(--primary); color: var(--primary-ink); font-weight: 600; }
.primary:hover { opacity: .9; }
.grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.fmt { display: inline-flex; align-items: center; justify-content: center; min-width: 0; padding: 7px 4px; border-radius: 9px; border: 1px solid var(--border); background: var(--bg); font-size: 12px; font-weight: 550; text-align: center; }
/* Main formats: the format's logo above its name (a row would wrap "Markdown" at this width). */
.fmt:has(.fmt-logo) { flex-direction: column; gap: 4px; padding: 9px 4px 7px; }
.fmt .fmt-logo { width: 22px; height: 22px; flex: none; color: var(--text); }
.fmt:hover { background: var(--surface-hover); }
.more { all: unset; display: inline-flex; align-items: center; gap: 2px; margin-top: 8px; color: var(--muted); font-size: 12px; cursor: pointer; border-radius: 6px; }
.more:hover { color: var(--text); }
.more svg { width: 14px; height: 14px; transition: transform .15s; }
.more[aria-expanded="true"] svg { transform: rotate(180deg); }
.grid.extra { margin-top: 6px; }
button:disabled { opacity: .45; cursor: default; }
.status { margin-top: 10px; padding: 10px; border-radius: 11px; border: 1px solid var(--border); display: flex; gap: 8px; align-items: flex-start; }
.status .ic { width: 18px; height: 18px; flex: none; margin-top: 1px; color: var(--muted); }
.status[data-level="ok"] .ic { color: var(--ok); }
.status[data-level="warning"] .ic { color: var(--warn); }
.status[data-level="error"] .ic { color: var(--err); }
.status .ic svg { width: 18px; height: 18px; }
.status .body { min-width: 0; flex: 1; }
.status .title { font-weight: 600; }
.status .sub { color: var(--muted); font-size: 12px; }
.status ul { margin: 6px 0 0; padding-left: 16px; color: var(--muted); font-size: 12px; }
.status .actions { margin-top: 6px; display: flex; gap: 6px; }
.status .choices { margin-top: 8px; display: flex; flex-direction: column; gap: 6px; }
.status[data-level="choose"] .ic { color: var(--text); }
${MD_CHOICE_CSS}
${mdChoiceDarkCss('.panel.dark')}
.status .bar { margin-top: 7px; height: 4px; border-radius: 999px; background: var(--surface-hover); overflow: hidden; }
.status .bar i { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #7c5cff, #22d3ee); transition: width .25s ease; }
.link { all: unset; color: var(--text); font-size: 12px; font-weight: 600; text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
.status .ic.spinning { animation: r 0.9s linear infinite; will-change: transform; }
@keyframes r { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .status .ic.spinning { animation: none; } }
.toast {
  position: fixed; z-index: 2147483646; right: 16px; bottom: 16px; max-width: 320px; padding: 10px 12px;
  display: flex; gap: 8px; align-items: center; border-radius: 12px; background: var(--bg); color: var(--text);
  border: 1px solid var(--border); box-shadow: 0 8px 24px rgba(0,0,0,.18); cursor: pointer;
}
.toast .ic svg { width: 18px; height: 18px; display: block; }
${HANDOFF_VISUAL_CSS}
`;

function isDarkPage(): boolean {
  const lum = (el: Element | null): number | null => {
    if (!el) return null;
    const m = getComputedStyle(el).backgroundColor.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
    if (!m || (m[4] != null && Number(m[4]) < 0.5)) return null;
    return (0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3])) / 255;
  };
  const l = lum(document.body) ?? lum(document.documentElement);
  return l != null ? l < 0.45 : matchMedia('(prefers-color-scheme: dark)').matches;
}

export function initPageUi(adapter: SiteAdapter): void {
  const locale: Locale = detectLocale(chrome.i18n?.getUILanguage?.() ?? navigator.language);
  const tr = (k: MessageKey, p?: Record<string, string | number>) => t(locale, k, p);
  const triggers = new Set<HTMLButtonElement>();
  let anchor: HTMLButtonElement | null = null;
  let job: JobState | null = null;
  let polling: ReturnType<typeof setTimeout> | null = null;
  let moreOpen = false;

  // ---------- panel (one per page, created on first use) ----------
  let panelHost: HTMLElement | null = null;
  let panel: HTMLDivElement | null = null;
  let root: ShadowRoot | null = null;

  const ensurePanel = () => {
    if (panelHost?.isConnected && panel && root) return;
    panelHost = document.createElement('div');
    panelHost.setAttribute('data-lucian-panel', '');
    root = panelHost.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = PANEL_CSS;
    panel = document.createElement('div');
    panel.className = 'panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', tr('app.name'));
    panel.hidden = true;
    root.append(style, panel);
    root.addEventListener('click', onPanelClick);
    // Keys and clicks inside the panel belong to it, not to the site's shortcuts.
    for (const type of ['keydown', 'keyup', 'keypress', 'pointerdown', 'mousedown', 'click']) {
      panelHost.addEventListener(type, (e) => {
        if (type === 'keydown' && (e as KeyboardEvent).key === 'Escape') closePanel(true);
        e.stopPropagation();
      });
    }
    document.documentElement.appendChild(panelHost);
  };

  // Logos only in the main row; the extra formats stay one-line text buttons.
  const fmtButton = (f: ExportFormat, logo = false) =>
    `<button type="button" class="fmt" data-format="${f}">${logo ? (FORMAT_LOGOS[f] ?? '') : ''}<span>${escapeText(tr(`format.${f}` as MessageKey))}</span></button>`;

  const renderPanel = () => {
    if (!panel) return;
    panel.innerHTML = `
      <div class="top">${LOGO}<b>Lucian</b><button type="button" class="x" data-act="close" aria-label="${escapeText(tr('page.close'))}">${ICON.close}</button></div>
      <section class="card">
        <h3>${escapeText(tr('handoff.title'))}</h3>
        <p>${escapeText(tr('handoff.desc'))}</p>
        ${handoffVisualHtml(adapter.site, (s) => chrome.runtime.getURL(`providers/${s}.svg`), locale, 'light')}
        <button type="button" class="primary" data-act="handoff">${escapeText(tr('handoff.button'))}</button>
      </section>
      <section class="card">
        <h3>${escapeText(tr('export.title'))}</h3>
        <p>${escapeText(tr('export.desc'))}</p>
        <div class="grid">${PRIMARY.map((f) => fmtButton(f, true)).join('')}</div>
        <button type="button" class="more" data-act="more" aria-expanded="${moreOpen}">${escapeText(tr(moreOpen ? 'export.less' : 'export.more'))} ${ICON.chevron}</button>
        <div class="grid extra" ${moreOpen ? '' : 'hidden'}>${MORE.map((f) => fmtButton(f)).join('')}</div>
      </section>
      <div class="status" role="status" aria-live="polite" hidden></div>`;
    updatePanel();
  };

  /** Job updates touch only the buttons' state and the status box, so focus stays where it is. */
  const updatePanel = () => {
    if (!panel) return;
    const busy = !!job && !TERMINAL.includes(job.phase);
    for (const b of panel.querySelectorAll<HTMLButtonElement>('.primary, .fmt')) b.disabled = busy;
    renderStatus();
  };

  const renderStatus = () => {
    const box = panel?.querySelector<HTMLDivElement>('.status');
    if (!box) return;
    if (!job) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const fmtName = job.format ? tr(`format.${job.format}` as MessageKey) : 'Markdown';
    let icon = ICON.spin;
    let iconKind = 'spin';
    let title: string;
    let sub = '';
    let extra = '';
    let pct: number | null = null;
    box.dataset.level = '';
    if (!TERMINAL.includes(job.phase)) {
      const key: MessageKey =
        job.phase === 'assets'
          ? 'phase.assets'
          : job.phase === 'processing'
            ? job.kind === 'handoff'
              ? 'phase.processing.handoff'
              : 'phase.processing.export'
            : job.phase === 'downloading'
              ? 'phase.downloading'
              : 'phase.collecting';
      title = tr(key, { format: fmtName });
      const p = job.progress;
      if (p?.label === 'messages' && p.done) sub = tr('progress.messages', { done: p.done.toLocaleString() });
      else if (p?.label === 'assets' && p.total) sub = `${tr('progress.assets', { done: p.done ?? 0, total: p.total })} ${tr('progress.percent', { n: Math.floor(((p.done ?? 0) / p.total) * 100) })}`;
      else if (p?.label === 'percent' && p.total) sub = tr('progress.percent', { n: p.done ?? 0 });
      if (p?.total && p.done != null) {
        pct = Math.round((p.done / p.total) * 100);
        extra += '<div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100"><i></i></div>';
      }
    } else if (job.phase === 'choose') {
      // A Markdown file cannot hold images: the user picks ZIP, a folder next to it, or none.
      // A question, not a problem: a neutral picture icon instead of a warning.
      box.dataset.level = 'choose';
      icon = ICON.image;
      iconKind = 'image';
      title = tr('choose.md.title', { n: job.choice?.images ?? 0 });
      sub = tr('choose.md.desc');
      extra += `<div class="choices" role="group">${(['zip', 'folder', 'none'] as const)
        .map((m) => `<button type="button" class="choice" data-md="${m}">${mdChoiceHtml(m, tr(`choose.md.${m}`), tr(`choose.md.${m}Desc`), m === 'zip' ? tr('choose.md.recommended') : undefined)}</button>`)
        .join('')}</div>`;
    } else if (job.phase === 'error') {
      box.dataset.level = 'error';
      icon = ICON.err;
      iconKind = 'err';
      title = tr('phase.error');
      const k = `error.${job.error?.code ?? 'UNKNOWN'}` as MessageKey;
      sub = tr(k) === k ? tr('error.UNKNOWN') : tr(k);
    } else {
      const v = job.result?.verification;
      const level = v?.level ?? 'ok';
      box.dataset.level = job.phase === 'print' && !v ? '' : level;
      icon = job.phase === 'print' && !v ? ICON.spin.replace('class="spin"', '') : level === 'ok' ? ICON.ok : level === 'warning' ? ICON.warn : ICON.err;
      iconKind = job.phase === 'print' && !v ? 'print' : level;
      if (job.phase === 'print') title = tr('phase.print');
      else if (job.format === 'pdf') title = tr('phase.done.print');
      else title = tr(job.kind === 'handoff' ? 'phase.done.handoff' : 'phase.done.export', { format: fmtName });
      const parts: string[] = [];
      if (job.result?.filename && job.format !== 'pdf') parts.push(job.result.filename);
      const hs = job.result?.handoffStats;
      if (hs) parts.push(tr('result.tokens', { src: hs.sourceTokens.toLocaleString(), out: hs.outputTokens.toLocaleString() }));
      else if (job.result?.bytes) parts.push(formatBytes(job.result.bytes));
      sub = parts.join(' · ');
      const issues = (v?.checks ?? []).filter((c) => c.status === 'warn' || c.status === 'fail').slice(0, 4);
      if (issues.length) extra += `<ul>${issues.map((c) => `<li>${escapeText(checkText(locale, c))}</li>`).join('')}</ul>`;
      if (job.result?.downloadId != null) extra += `<div class="actions"><button type="button" class="link" data-act="show">${escapeText(tr('result.openFile'))}</button></div>`;
    }
    if (job.phase === 'error' && job.error?.code !== 'NOT_SUPPORTED' && job.error?.code !== 'NOT_CONVERSATION') {
      extra += `<div class="actions"><button type="button" class="link" data-act="retry">${escapeText(tr('result.retry'))}</button></div>`;
    }
    // Polls arrive every ~0.45 s: keep the icon element (re-creating the spinner restarted its
    // rotation, so it stuttered) and move the progress bar in place so its width transition runs.
    let ic = box.querySelector<HTMLElement>(':scope > .ic');
    let body = box.querySelector<HTMLElement>(':scope > .body');
    if (!ic || !body) {
      box.innerHTML = '<span class="ic"></span><div class="body"></div>';
      ic = box.querySelector<HTMLElement>(':scope > .ic')!;
      body = box.querySelector<HTMLElement>(':scope > .body')!;
    }
    if (ic.dataset.kind !== iconKind) {
      ic.dataset.kind = iconKind;
      ic.classList.toggle('spinning', iconKind === 'spin');
      ic.innerHTML = icon;
    }
    const html = `<div class="title">${escapeText(title)}</div>${sub ? `<div class="sub">${escapeText(sub)}</div>` : ''}${extra}`;
    if (body.dataset.html !== html) {
      body.dataset.html = html;
      body.innerHTML = html;
    }
    // The choice sits at the bottom of a tall panel: bring it into view once per job.
    if (job.phase === 'choose' && box.dataset.shown !== job.id) {
      box.dataset.shown = job.id;
      requestAnimationFrame(() => box.scrollIntoView({ block: 'nearest' }));
    }
    const bar = body.querySelector<HTMLElement>('.bar');
    if (bar && pct != null) {
      bar.setAttribute('aria-valuenow', String(pct));
      (bar.firstElementChild as HTMLElement).style.width = `${Math.max(3, pct)}%`;
    }
  };

  const position = () => {
    if (!panel || !anchor?.isConnected) return;
    const r = anchor.getBoundingClientRect();
    const w = panel.offsetWidth || 304;
    const h = panel.offsetHeight || 360;
    const left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
    // Prefer opening above the toolbar: the composer usually sits right below the last answer.
    const top = r.top - h - 6 >= 8 ? r.top - h - 6 : Math.min(r.bottom + 6, window.innerHeight - h - 8);
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(Math.max(8, top))}px`;
  };

  const onOutside = (e: Event) => {
    const path = e.composedPath();
    if (panelHost && path.includes(panelHost)) return;
    if (anchor && path.some((n) => n instanceof Element && n.hasAttribute(HOST_ATTR))) return;
    closePanel(false);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closePanel(true);
  };

  const openPanel = (from: HTMLButtonElement) => {
    ensurePanel();
    anchor = from;
    for (const b of triggers) b.setAttribute('aria-expanded', String(b === from));
    panel!.classList.toggle('dark', isDarkPage());
    renderPanel();
    panel!.hidden = false;
    position();
    requestAnimationFrame(() => panel?.classList.add('open'));
    panel!.querySelector<HTMLButtonElement>('.primary')?.focus({ preventScroll: true });
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    void refreshJob();
  };

  function closePanel(restoreFocus: boolean): void {
    if (!panel || panel.hidden) return;
    panel.classList.remove('open');
    panel.hidden = true;
    for (const b of triggers) b.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', position);
    window.removeEventListener('scroll', position, true);
    if (restoreFocus) anchor?.focus({ preventScroll: true });
  }

  const panelOpen = () => !!panel && !panel.hidden;

  // ---------- jobs ----------

  // Only on a change: re-inserting the spinner on every poll restarted its rotation.
  const setBusy = (busy: boolean) => {
    for (const b of triggers) {
      if (b.dataset.busy === String(busy)) continue;
      const icon = b.querySelector('.icon');
      if (icon) {
        icon.innerHTML = busy ? ICON.spin : LOGO;
        icon.classList.toggle('spinning', busy);
      }
      b.dataset.busy = String(busy);
    }
  };

  const applyJob = (next: JobState | null, announce: boolean) => {
    const wasRunning = !!job && !TERMINAL.includes(job.phase);
    job = next;
    const running = !!job && !TERMINAL.includes(job.phase);
    setBusy(running);
    if (panelOpen()) {
      updatePanel();
      position();
    } else if (announce && wasRunning && !running && job?.phase === 'choose') {
      // The export cannot go on without an answer: show the choice where the user clicked.
      const at = anchor?.isConnected ? anchor : [...triggers].find((b) => b.isConnected);
      if (at) openPanel(at);
    } else if (announce && wasRunning && !running && job) {
      toast(job);
    }
    if (running) schedulePoll();
  };

  const refreshJob = async () => {
    const j = (await chrome.runtime.sendMessage({ type: 'get-job' }).catch(() => null)) as JobState | null;
    // Only show results that belong to this visit: a job still running or finished moments ago.
    const recent = j && (!TERMINAL.includes(j.phase) || Date.now() - (j.finishedAt ?? j.startedAt) < 120_000);
    applyJob(recent ? j : null, true);
  };

  function schedulePoll(): void {
    if (polling) return;
    polling = setTimeout(() => {
      polling = null;
      void refreshJob();
    }, 450);
  }

  const start = async (kind: JobKind, format?: ExportFormat, mdImages?: MdImageMode) => {
    const res = (await chrome.runtime.sendMessage({ type: 'start-job', kind, format, locale, mdImages }).catch(() => ({ ok: false, error: 'CONTENT_UNAVAILABLE' }))) as {
      ok: boolean;
      error?: string;
    };
    if (!res?.ok) {
      applyJob({ id: 'local', kind, format, tabId: -1, phase: 'error', timings: {}, startedAt: Date.now(), error: { code: res?.error ?? 'UNKNOWN' } }, false);
      return;
    }
    applyJob({ id: 'pending', kind, format, tabId: -1, phase: 'collecting', timings: {}, startedAt: Date.now() }, false);
  };

  let lastAction: { kind: JobKind; format?: ExportFormat; mdImages?: MdImageMode } | null = null;
  const onPanelClick = (e: Event) => {
    const el = (e.target as Element).closest<HTMLElement>('[data-act], [data-format], [data-md]');
    if (!el || (el as HTMLButtonElement).disabled) return;
    const act = el.dataset.act;
    if (el.dataset.md) {
      lastAction = { kind: 'export', format: 'md', mdImages: el.dataset.md as MdImageMode };
      void start('export', 'md', lastAction.mdImages);
    } else if (el.dataset.format) {
      lastAction = { kind: 'export', format: el.dataset.format as ExportFormat };
      void start('export', lastAction.format);
    } else if (act === 'handoff') {
      lastAction = { kind: 'handoff' };
      void start('handoff');
    } else if (act === 'more') {
      moreOpen = !moreOpen;
      renderPanel();
      position();
      panel?.querySelector<HTMLButtonElement>('.more')?.focus({ preventScroll: true });
    } else if (act === 'close') {
      closePanel(true);
    } else if (act === 'show' && job?.result?.downloadId != null) {
      void chrome.runtime.sendMessage({ type: 'show-download', downloadId: job.result.downloadId });
    } else if (act === 'retry' && lastAction) {
      void start(lastAction.kind, lastAction.format, lastAction.mdImages);
    }
  };

  // ---------- toast (result while the panel is closed) ----------

  let toastHost: HTMLElement | null = null;
  function toast(j: JobState): void {
    toastHost?.remove();
    toastHost = document.createElement('div');
    toastHost.setAttribute('data-lucian-panel', '');
    const r = toastHost.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = PANEL_CSS;
    const box = document.createElement('div');
    box.className = `toast panel open${isDarkPage() ? ' dark' : ''}`;
    box.style.cssText = 'left:auto;top:auto;width:auto;padding:10px 12px';
    const level = j.phase === 'error' ? 'error' : j.result?.verification.level ?? 'ok';
    const icon = level === 'ok' ? ICON.ok : level === 'warning' ? ICON.warn : ICON.err;
    const fmtName = j.format ? tr(`format.${j.format}` as MessageKey) : 'Markdown';
    const text =
      j.phase === 'error'
        ? tr('phase.error')
        : j.phase === 'print'
          ? tr('phase.print')
          : tr(j.kind === 'handoff' ? 'phase.done.handoff' : 'phase.done.export', { format: fmtName });
    box.innerHTML = `<span class="ic" style="color:var(--${level === 'ok' ? 'ok' : level === 'warning' ? 'warn' : 'err'})">${icon}</span><span>${escapeText(text)}</span>`;
    box.setAttribute('role', 'status');
    box.addEventListener('click', () => {
      toastHost?.remove();
      const first = [...triggers].find((b) => b.isConnected);
      if (first) openPanel(first);
    });
    r.append(style, box);
    document.documentElement.appendChild(toastHost);
    const h = toastHost;
    setTimeout(() => h.remove(), 6000);
  }

  // ---------- trigger buttons in the site's toolbars ----------

  const mount = (bar: Element) => {
    if (bar.querySelector(`:scope > [${HOST_ATTR}]`)) return;
    // Only toolbars that show buttons (Claude keeps an empty placeholder on older answers).
    const ref = [...bar.querySelectorAll('button')].find((b) => !b.classList.contains('sr-only'));
    if (!ref) return;
    const host = document.createElement('span');
    host.setAttribute(HOST_ATTR, '');
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = BUTTON_CSS;
    const btn = document.createElement('button');
    btn.type = 'button';
    const busy = !!job && !TERMINAL.includes(job.phase);
    btn.innerHTML = `<span class="halo"></span><span class="ring"></span><span class="icon${busy ? ' spinning' : ''}" style="display:inline-flex">${busy ? ICON.spin : LOGO}</span>`;
    btn.dataset.busy = String(busy);
    btn.title = tr('page.button');
    btn.setAttribute('aria-label', tr('page.button'));
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.setAttribute('aria-expanded', 'false');
    const size = ref.offsetHeight > 0 ? Math.round(Math.min(40, Math.max(24, ref.offsetHeight))) : 32;
    host.style.setProperty('--size', `${size}px`);
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (panelOpen() && anchor === btn) closePanel(false);
      else openPanel(btn);
    });
    for (const type of ['pointerdown', 'mousedown', 'keydown']) host.addEventListener(type, (e) => e.stopPropagation());
    shadow.append(style, btn);
    triggers.add(btn);
    bar.appendChild(host);
  };

  let scheduled: ReturnType<typeof setTimeout> | null = null;
  const scan = () => {
    scheduled = null;
    // After the extension is reloaded or updated this script is orphaned: remove its buttons
    // instead of leaving controls that can no longer reach the extension.
    if (!chrome.runtime?.id) {
      observer.disconnect();
      for (const el of document.querySelectorAll(`[${HOST_ATTR}], [data-lucian-panel]`)) el.remove();
      return;
    }
    // Some toolbars show their buttons only while hovered (Claude, older answers); when the site
    // removes them again, our button goes too instead of standing alone.
    for (const host of document.querySelectorAll(`[${HOST_ATTR}]`)) {
      const bar = host.parentElement;
      if (!bar || ![...bar.querySelectorAll('button')].some((b) => !b.classList.contains('sr-only'))) host.remove();
    }
    for (const b of triggers) if (!b.isConnected) triggers.delete(b);
    let bars: Element[];
    try {
      bars = adapter.actionBars();
    } catch {
      return;
    }
    for (const bar of bars) mount(bar);
  };
  const observer = new MutationObserver(() => {
    if (!scheduled) scheduled = setTimeout(scan, 300);
  });
  const begin = () => {
    observer.observe(document.body, { childList: true, subtree: true });
    scan();
  };
  if (document.body) begin();
  else document.addEventListener('DOMContentLoaded', begin, { once: true });

}

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
