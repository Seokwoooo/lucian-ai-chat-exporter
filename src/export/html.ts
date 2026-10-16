// Markdown tokens → self-contained HTML. Used for the HTML export, the ZIP backup and the
// print page that produces PDFs locally. Raw HTML inside messages is always escaped so the
// output shows exactly what the chat showed and never executes page content.

import { t, formatBytes, type Locale } from '../shared/i18n';
import type { Conversation, ExportContent, ExportMessage } from '../shared/types';
import { escapeHtml, formatDateTime } from '../shared/util';
import { messageHeaderText, roleLabel, toolDocText } from './markdown';
import { lex, type Token, type Tokens } from './md-parse';

export interface HtmlEnv {
  locale: Locale;
  mode: 'file' | 'print';
  includeThinking?: boolean;
  /** Returns MathML/HTML for a formula or null when rendering failed. */
  renderMath?: (tex: string, display: boolean) => string | null;
  /** Resolves an image URL to a displayable src (data URL, relative path, object URL). */
  imageSrc: (url: string) => string | undefined;
  attachmentHref?: (key: string) => string | undefined;
}

export interface HtmlStats {
  messages: number;
  math: number;
  mathFailed: number;
  tables: number;
  codeBlocks: number;
  images: number;
  imagesMissing: number;
}

interface Ctx {
  env: HtmlEnv;
  stats: HtmlStats;
}

const SAFE_URL = /^(https?:|mailto:|#)/i;

function attr(v: string): string {
  return escapeHtml(v);
}

function renderImage(url: string, alt: string, ctx: Ctx): string {
  ctx.stats.images++;
  const src = ctx.env.imageSrc(url);
  if (src) return `<img src="${attr(src)}" alt="${attr(alt)}" loading="eager">`;
  ctx.stats.imagesMissing++;
  const link = /^https?:/i.test(url) ? ` · <a href="${attr(url)}">${escapeHtml(shorten(url))}</a>` : '';
  return `<span class="img-missing">${escapeHtml(t(ctx.env.locale, 'doc.imageMissing'))}${link}</span>`;
}

function shorten(url: string): string {
  return url.length > 60 ? `${url.slice(0, 57)}…` : url;
}

function renderMath(tex: string, display: boolean, ctx: Ctx): string {
  ctx.stats.math++;
  const out = ctx.env.renderMath?.(tex, display) ?? null;
  if (out) return display ? `<div class="math-display">${out}</div>` : `<span class="math-inline">${out}</span>`;
  ctx.stats.mathFailed++;
  const raw = display ? `$$${tex}$$` : `$${tex}$`;
  return display ? `<pre class="math-src">${escapeHtml(raw)}</pre>` : `<code class="math-src">${escapeHtml(raw)}</code>`;
}

function inline(tokens: Token[] | undefined, ctx: Ctx): string {
  if (!tokens) return '';
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'text': {
        const tt = tok as Tokens.Text;
        out += tt.tokens ? inline(tt.tokens, ctx) : escapeHtml(tt.text);
        break;
      }
      case 'escape':
        out += escapeHtml((tok as Tokens.Escape).text);
        break;
      case 'strong':
        out += `<strong>${inline((tok as Tokens.Strong).tokens, ctx)}</strong>`;
        break;
      case 'em':
        out += `<em>${inline((tok as Tokens.Em).tokens, ctx)}</em>`;
        break;
      case 'del':
        out += `<del>${inline((tok as Tokens.Del).tokens, ctx)}</del>`;
        break;
      case 'codespan':
        out += `<code>${escapeHtml((tok as Tokens.Codespan).text)}</code>`;
        break;
      case 'br':
        out += '<br>';
        break;
      case 'link': {
        const l = tok as Tokens.Link;
        const body = inline(l.tokens, ctx);
        out += SAFE_URL.test(l.href) ? `<a href="${attr(l.href)}">${body}</a>` : body;
        break;
      }
      case 'image': {
        const im = tok as Tokens.Image;
        out += renderImage(im.href, im.text, ctx);
        break;
      }
      case 'html':
        out += escapeHtml((tok as Tokens.HTML).text);
        break;
      case 'mathInline':
        out += renderMath((tok as unknown as { text: string }).text, false, ctx);
        break;
      case 'mathBlock':
        out += renderMath((tok as unknown as { text: string }).text, true, ctx);
        break;
      default:
        out += escapeHtml((tok as { raw?: string }).raw ?? '');
    }
  }
  return out;
}

function block(tokens: Token[], ctx: Ctx): string {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'space':
        break;
      case 'paragraph':
        out += `<p>${inline((tok as Tokens.Paragraph).tokens, ctx)}</p>\n`;
        break;
      case 'text': {
        const tt = tok as Tokens.Text;
        out += tt.tokens ? inline(tt.tokens, ctx) : escapeHtml(tt.text);
        break;
      }
      case 'heading': {
        const h = tok as Tokens.Heading;
        const level = Math.min(6, h.depth + 2);
        out += `<h${level}>${inline(h.tokens, ctx)}</h${level}>\n`;
        break;
      }
      case 'code': {
        const c = tok as Tokens.Code;
        ctx.stats.codeBlocks++;
        out += codeFigure(c.text, c.lang?.trim().split(/\s+/)[0], undefined);
        break;
      }
      case 'blockquote':
        out += `<blockquote>${block((tok as Tokens.Blockquote).tokens, ctx)}</blockquote>\n`;
        break;
      case 'list': {
        const l = tok as Tokens.List;
        const tag = l.ordered ? 'ol' : 'ul';
        const start = l.ordered && l.start !== '' && l.start !== 1 ? ` start="${Number(l.start)}"` : '';
        out += `<${tag}${start}>`;
        for (const item of l.items) {
          const check = item.task ? `<input type="checkbox" disabled${item.checked ? ' checked' : ''}> ` : '';
          out += `<li${item.task ? ' class="task"' : ''}>${check}${block(item.tokens, ctx)}</li>`;
        }
        out += `</${tag}>\n`;
        break;
      }
      case 'table': {
        const tb = tok as Tokens.Table;
        ctx.stats.tables++;
        const al = (i: number) => (tb.align[i] ? ` style="text-align:${tb.align[i]}"` : '');
        const head = tb.header.map((h, i) => `<th${al(i)}>${inline(h.tokens, ctx)}</th>`).join('');
        const rows = tb.rows.map((r) => `<tr>${r.map((c, i) => `<td${al(i)}>${inline(c.tokens, ctx)}</td>`).join('')}</tr>`).join('');
        const cls = tb.rows.length <= 20 ? ' class="keep"' : '';
        out += `<div class="table-wrap"><table${cls}><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>\n`;
        break;
      }
      case 'hr':
        out += '<hr>\n';
        break;
      case 'html':
        out += `<p>${escapeHtml((tok as Tokens.HTML).text)}</p>\n`;
        break;
      case 'mathBlock':
        out += renderMath((tok as unknown as { text: string }).text, true, ctx);
        break;
      default: {
        const anyTok = tok as Tokens.Generic;
        out += anyTok.tokens ? `<p>${inline(anyTok.tokens as Token[], ctx)}</p>` : `<p>${escapeHtml(anyTok.raw ?? '')}</p>`;
      }
    }
  }
  return out;
}

function codeFigure(code: string, lang: string | undefined, title: string | undefined): string {
  const lines = code.split('\n').length;
  const caption = [title, lang].filter(Boolean).join(' · ');
  return (
    `<figure class="code${lines <= 40 ? ' keep' : ''}">` +
    (caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : '') +
    `<pre><code${lang ? ` class="language-${attr(lang)}"` : ''}>${escapeHtml(code.replace(/\n$/, ''))}</code></pre></figure>\n`
  );
}

function renderContent(c: ExportContent, ctx: Ctx): string {
  const L = ctx.env.locale;
  switch (c.type) {
    case 'text':
    case 'markdown':
      return block(lex(c.content ?? '', { breaks: c.type === 'text' }), ctx);
    case 'thinking':
      if (!ctx.env.includeThinking) return '';
      return `<details class="thinking" open><summary>${escapeHtml(t(L, 'doc.thinking'))}</summary>${block(lex(c.content ?? ''), ctx)}</details>`;
    case 'code':
      ctx.stats.codeBlocks++;
      return codeFigure(c.content ?? '', c.language, c.title);
    case 'tool':
      ctx.stats.codeBlocks++;
      return `<div class="tool">${codeFigure(toolDocText(c.content ?? '', L), c.language, `${t(L, 'doc.tool')} · ${c.title ?? ''}`)}</div>`;
    case 'artifact':
    case 'html_widget':
      ctx.stats.codeBlocks++;
      return codeFigure(c.content ?? '', c.type === 'html_widget' ? 'html' : c.language, `${t(L, 'doc.artifact')} · ${c.title ?? ''}`);
    case 'image':
      return c.imageUrl ? `<figure class="image">${renderImage(c.imageUrl, c.alt ?? '', ctx)}</figure>` : '';
    case 'image_group':
      return (c.imageGroup?.images ?? [])
        .map((img) => {
          const url = img.imageUrl ?? img.thumbnailUrl;
          return url ? `<figure class="image">${renderImage(url, img.alt ?? '', ctx)}</figure>` : '';
        })
        .join('');
    case 'attachment': {
      const a = c.attachment ?? {};
      const key = a.url ?? (a.fileId ? `file:${a.fileId}` : undefined);
      const href = key ? ctx.env.attachmentHref?.(key) : undefined;
      const name = escapeHtml(a.name ?? 'file');
      const meta = [a.mime_type, a.size ? formatBytes(a.size) : ''].filter(Boolean).join(' · ');
      let s = `<div class="attachment"><span class="label">${escapeHtml(t(L, 'doc.attachment'))}</span> ${href ? `<a href="${attr(href)}">${name}</a>` : `<strong>${name}</strong>`}${meta ? ` <span class="meta">${escapeHtml(meta)}</span>` : ''}</div>`;
      if (a.extractedText) {
        s += `<details class="extracted" open><summary>${escapeHtml(t(L, 'doc.extractedText'))}</summary><pre>${escapeHtml(a.extractedText)}</pre></details>`;
      }
      return s;
    }
    case 'sources': {
      const list = c.sources ?? [];
      if (!list.length) return '';
      const items = list
        .map((s) => {
          let host = '';
          try {
            host = new URL(s.url).hostname.replace(/^www\./, '');
          } catch {
            /* ignore */
          }
          return SAFE_URL.test(s.url) ? `<li><a href="${attr(s.url)}">${escapeHtml(s.title || s.url)}</a>${host ? ` <span class="host">${escapeHtml(host)}</span>` : ''}</li>` : '';
        })
        .join('');
      return `<div class="sources"><div class="label">${escapeHtml(t(L, 'doc.sources'))}</div><ol>${items}</ol></div>`;
    }
  }
  return '';
}

export function renderMessageHtml(conv: Conversation, msg: ExportMessage, index: number, ctx: Ctx): string {
  const label = roleLabel(conv, msg, ctx.env.locale);
  const meta = messageHeaderText(conv, msg, ctx.env.locale).slice(label.length).replace(/^ · /, '');
  const body = msg.contents.map((c) => renderContent(c, ctx)).join('');
  const truncated = msg.truncated ? `<p class="note">${escapeHtml(t(ctx.env.locale, 'doc.truncated'))}</p>` : '';
  return (
    `<section class="msg ${msg.role}" id="m-${index + 1}" data-msg-id="${attr(msg.id)}">` +
    `<div class="msg-head"><span class="role">${escapeHtml(label)}</span>${meta ? `<span class="meta">${escapeHtml(meta)}</span>` : ''}</div>` +
    `<div class="msg-body">${body}${truncated}</div></section>\n`
  );
}

export const DOCUMENT_CSS = `
:root{--fg:#1d1d1f;--muted:#6e6e73;--line:#e3e3e8;--bg:#fff;--soft:#f5f5f7;--code:#f6f7f9;--accent:#3a3ad6}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.72 system-ui,-apple-system,"Segoe UI","Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR","Hiragino Sans","Yu Gothic","Noto Sans JP",sans-serif;-webkit-font-smoothing:antialiased;word-break:keep-all;overflow-wrap:anywhere}
main{max-width:840px;margin:0 auto;padding:48px 28px 96px}
.doc-head{padding-bottom:20px;margin-bottom:8px;border-bottom:1px solid var(--line)}
.doc-head h1{font-size:26px;line-height:1.3;margin:0 0 10px;letter-spacing:-.01em}
.doc-meta{display:flex;flex-wrap:wrap;gap:4px 16px;color:var(--muted);font-size:13px}
.doc-meta a{color:inherit}
.msg{padding:22px 0;border-bottom:1px solid var(--line)}
.msg-head{display:flex;gap:10px;align-items:baseline;margin-bottom:10px;font-size:13px;color:var(--muted)}
.msg-head .role{font-weight:650;color:var(--fg);font-size:14px}
.msg.user .msg-body{background:var(--soft);border-radius:14px;padding:14px 18px}
.msg-body>:first-child{margin-top:0}.msg-body>:last-child{margin-bottom:0}
p{margin:0 0 12px}
h3,h4,h5,h6{line-height:1.35;margin:20px 0 8px}
h3{font-size:19px}h4{font-size:17px}h5,h6{font-size:15px}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
ul,ol{padding-left:24px;margin:0 0 12px}li{margin:2px 0}li>p{margin:0 0 6px}li.task{list-style:none;margin-left:-20px}
blockquote{margin:0 0 12px;padding:2px 14px;border-left:3px solid var(--line);color:var(--muted)}
code{font:13px/1.5 ui-monospace,"SF Mono",Menlo,Consolas,"D2Coding","Noto Sans Mono CJK KR",monospace;background:var(--code);border-radius:4px;padding:1px 5px}
figure{margin:0 0 14px}
figure.code{border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--code)}
figure.code figcaption{font-size:12px;color:var(--muted);padding:6px 14px;border-bottom:1px solid var(--line);font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
pre{margin:0;padding:12px 14px;overflow-x:auto;tab-size:4;white-space:pre}
pre code{background:none;padding:0;border-radius:0;font-size:13px;white-space:inherit}
.tool figure.code{background:transparent}
.table-wrap{overflow-x:auto;margin:0 0 14px}
table{border-collapse:collapse;font-size:14px;min-width:40%}
th,td{border:1px solid var(--line);padding:6px 10px;vertical-align:top;text-align:left}
th{background:var(--soft);font-weight:600}
img{max-width:100%;height:auto;border-radius:8px;display:block}
figure.image{margin:6px 0 14px}
.img-missing{display:inline-block;font-size:13px;color:var(--muted);border:1px dashed var(--line);border-radius:8px;padding:8px 12px}
.math-display{overflow-x:auto;margin:6px 0 14px;text-align:center}
math{font-size:1.06em}
.math-src{white-space:pre-wrap}
.attachment{font-size:14px;padding:8px 12px;border:1px solid var(--line);border-radius:10px;margin:0 0 10px}
.attachment .label{color:var(--muted);margin-right:4px}.attachment .meta{color:var(--muted);font-size:12px}
details{margin:0 0 12px}summary{cursor:pointer;color:var(--muted);font-size:13px}
details pre{background:var(--code);border-radius:8px;white-space:pre-wrap}
.sources{font-size:13px;margin:8px 0 0}.sources .label{color:var(--muted);font-weight:600;margin-bottom:2px}
.sources ol{margin:0;padding-left:20px}.sources .host{color:var(--muted)}
.note{font-size:13px;color:var(--muted)}
.doc-foot{margin-top:28px;color:var(--muted);font-size:12px}
`;

export const FILE_DARK_CSS = `
@media (prefers-color-scheme:dark){:root{--fg:#ececf1;--muted:#a1a1aa;--line:#2e2e33;--bg:#151517;--soft:#1f1f23;--code:#1b1b1f;--accent:#9b9bff}}
`;

export const PRINT_CSS = `
@page{size:A4;margin:16mm 14mm 18mm;@bottom-right{content:counter(page) " / " counter(pages);font:9pt system-ui,sans-serif;color:#888}}
@media print{
  body{font-size:10.5pt;line-height:1.6}
  main{max-width:none;padding:0}
  .msg{padding:14px 0}
  .msg-head,h3,h4,h5,h6,figcaption{break-after:avoid}
  .keep,figure.image,.math-display,blockquote,.attachment{break-inside:avoid}
  pre{white-space:pre-wrap;overflow-wrap:anywhere;overflow:visible}
  .table-wrap{overflow:visible}
  table{width:100%}thead{display:table-header-group}tr{break-inside:avoid}
  a{color:inherit;text-decoration:underline;text-decoration-color:#bbb}
  .no-print{display:none!important}
  *{-webkit-print-color-adjust:exact;print-color-adjust:exact}
}
`;

export function renderConversationBody(conv: Conversation, env: HtmlEnv, exportedAt = Date.now()): { html: string; stats: HtmlStats } {
  const stats: HtmlStats = { messages: 0, math: 0, mathFailed: 0, tables: 0, codeBlocks: 0, images: 0, imagesMissing: 0 };
  const ctx: Ctx = { env, stats };
  const L = env.locale;
  const meta = [
    `<span>${escapeHtml(t(L, 'doc.source'))}: <a href="${attr(conv.fromUrl)}">${escapeHtml(conv.siteName)}</a></span>`,
    `<span>${escapeHtml(t(L, 'doc.exportedAt'))}: ${escapeHtml(formatDateTime(exportedAt))}</span>`,
    `<span>${escapeHtml(t(L, 'doc.messages'))}: ${conv.messages.length}</span>`,
    conv.model ? `<span>${escapeHtml(t(L, 'doc.model'))}: ${escapeHtml(conv.model)}</span>` : '',
  ].join('');
  let html = `<header class="doc-head"><h1>${escapeHtml(conv.title || conv.siteName)}</h1><div class="doc-meta">${meta}</div></header>\n`;
  conv.messages.forEach((m, i) => {
    html += renderMessageHtml(conv, m, i, ctx);
    stats.messages++;
  });
  html += `<footer class="doc-foot">${escapeHtml(t(L, 'doc.generatedBy'))}</footer>`;
  return { html, stats };
}

export function wrapHtmlDocument(title: string, body: string, locale: Locale, mode: 'file' | 'print', extraHead = ''): string {
  const css = DOCUMENT_CSS + (mode === 'file' ? FILE_DARK_CSS : '') + PRINT_CSS;
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Lucian AI Chat Exporter">
<title>${escapeHtml(title)}</title>
<style>${css}</style>
${extraHead}
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}
