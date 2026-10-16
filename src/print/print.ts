// Print page: renders the conversation with the same HTML renderer as the HTML export and opens
// Chrome's print dialog so the user saves a PDF that is generated entirely on this computer.
// Chrome's print engine handles Korean/Japanese/Chinese fonts, MathML formulas, tables, links
// (kept clickable in the PDF) and page breaks; CSS @page adds page numbers.

import { getAsset, getConversation } from '../shared/db';
import { detectLocale, t, type Locale } from '../shared/i18n';
import type { AssetStatus } from '../shared/messages';
import { DOCUMENT_CSS, PRINT_CSS, renderConversationBody } from '../export/html';
import { collectAssetRequests } from '../export/images';
import { renderMathMl } from '../export/math';
import { buildVerification, levelOf } from '../export/verify';

const params = new URLSearchParams(location.search);
const jobId = params.get('job') ?? '';
const key = params.get('key') ?? '';
const locale: Locale = (params.get('locale') as Locale) || detectLocale();

const $ = (id: string) => document.getElementById(id)!;

async function main(): Promise<void> {
  document.documentElement.lang = locale;
  $('barTitle').textContent = t(locale, 'print.title');
  $('barDesc').textContent = t(locale, 'print.desc');
  $('printBtn').textContent = t(locale, 'print.button');
  $('loading').textContent = t(locale, 'print.loading');
  $('printBtn').addEventListener('click', () => window.print());

  const style = document.createElement('style');
  style.textContent = DOCUMENT_CSS + PRINT_CSS;
  document.head.appendChild(style);

  const conv = key ? await getConversation(key) : undefined;
  if (!conv) {
    $('loading').textContent = t(locale, 'print.missing');
    return;
  }
  // Chrome suggests the document title as the PDF file name.
  document.title = conv.title || conv.siteName;

  const t0 = performance.now();
  const srcMap = new Map<string, string>();
  const assets: AssetStatus[] = [];
  for (const r of collectAssetRequests(conv, false)) {
    const rec = await getAsset(r.key).catch(() => undefined);
    if (rec) {
      srcMap.set(r.key, URL.createObjectURL(rec.blob));
      assets.push({ key: r.key, kind: 'image', ok: true, mime: rec.mime, size: rec.size });
    } else {
      assets.push({ key: r.key, kind: 'image', ok: false, error: 'unavailable' });
    }
  }

  const body = renderConversationBody(conv, { locale, mode: 'print', renderMath: renderMathMl, imageSrc: (u) => srcMap.get(u) });
  const doc = $('doc');
  // The renderer escapes every piece of conversation text and only emits http(s)/mailto links.
  doc.innerHTML = body.html;
  doc.removeAttribute('aria-busy');

  const imgs = Array.from(doc.querySelectorAll('img'));
  await Promise.all(imgs.map((img) => img.decode().catch(() => undefined)));
  await document.fonts?.ready;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const renderMs = performance.now() - t0;

  const rendered = doc.querySelectorAll('section.msg').length;
  const broken = imgs.filter((i) => !i.naturalWidth).length;
  const verification = buildVerification(conv, 'pdf', {
    assets,
    stats: { ...body.stats, imagesMissing: body.stats.imagesMissing + broken },
    output: rendered === conv.messages.length ? { ok: true } : { ok: false, detail: `rendered ${rendered} / ${conv.messages.length}` },
    formatLabel: 'PDF',
  });
  verification.checks.unshift({ code: 'pdf.rendered', status: rendered === conv.messages.length ? 'pass' : 'fail', params: { n: rendered } });
  verification.level = levelOf(verification.checks);
  await chrome.runtime.sendMessage({ type: 'print-report', jobId, verification, renderMs }).catch(() => undefined);

  window.addEventListener('afterprint', () => void chrome.runtime.sendMessage({ type: 'print-finished', jobId }).catch(() => undefined));
  if (params.get('autoprint') !== '0') setTimeout(() => window.print(), 250);
}

void main();
