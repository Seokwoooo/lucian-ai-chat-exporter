// Conversation → Markdown serializer (tech doc §25.1 fm/Ax). The Markdown string is also the
// intermediate representation used by the TXT, HTML/PDF, DOCX and HWPX exporters.

import { attachmentName, t, formatBytes, type Locale } from '../shared/i18n';
import { sourceDomain } from '../shared/sites';
import type { Conversation, ExportContent, ExportMessage } from '../shared/types';
import { formatDateTime } from '../shared/util';

export interface MdOptions {
  locale: Locale;
  includeThinking?: boolean;
  /** Rewrites an image URL (e.g. to images/image-001.png in a ZIP). */
  imageHref?: (url: string) => string | undefined;
  /** Link target for an attachment saved alongside the document. */
  attachmentHref?: (key: string) => string | undefined;
  /**
   * Images imageHref does not map: keep the service URL ('link', which needs the user's login), or
   * write a text note — '[이미지: …]' when images are left out by choice ('omit'), or "could not be
   * fetched" when they were meant to be saved ('missing'). v1.3.6
   */
  unmappedImage?: 'link' | 'omit' | 'missing';
}

export interface MdResult {
  text: string;
  /** Exact header line emitted for every message, in order (used by output verification). */
  headers: string[];
}

export function codeFence(code: string): string {
  let max = 2;
  for (const m of code.match(/`{3,}/g) ?? []) max = Math.max(max, m.length);
  return '`'.repeat(max + 1);
}

export function roleLabel(conv: Pick<Conversation, 'siteName'>, msg: ExportMessage, locale: Locale): string {
  return msg.role === 'user' ? t(locale, 'doc.user') : conv.siteName;
}

/** "ChatGPT · 2026-10-21 09:30". Model names are left out (v1.3.8); JSON keeps them. */
export function messageHeaderText(conv: Pick<Conversation, 'siteName'>, msg: ExportMessage, locale: Locale): string {
  const parts = [roleLabel(conv, msg, locale)];
  if (msg.created_at) parts.push(formatDateTime(msg.created_at));
  return parts.join(' · ');
}

/** Applies fn to the parts of a Markdown string that are not fenced or inline code. */
export function replaceOutsideCode(md: string, fn: (segment: string) => string): string {
  const out: string[] = [];
  const re = /(^|\n)( {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n {0,3}\3[^\n]*(?=\n|$)|$)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md))) {
    out.push(replaceOutsideInlineCode(md.slice(last, m.index), fn));
    out.push(m[0]);
    last = m.index + m[0].length;
  }
  out.push(replaceOutsideInlineCode(md.slice(last), fn));
  return out.join('');
}

function replaceOutsideInlineCode(text: string, fn: (s: string) => string): string {
  const parts = text.split(/(`+[^`\n]*?`+)/g);
  return parts.map((p, i) => (i % 2 === 1 ? p : fn(p))).join('');
}

export function rewriteInlineImages(md: string, imageHref?: (url: string) => string | undefined, unmapped?: (alt: string) => string | undefined): string {
  if ((!imageHref && !unmapped) || !md.includes('![')) return md;
  return replaceOutsideCode(md, (seg) =>
    seg.replace(/!\[([^\]]*)\]\((\S+?)(\s+"[^"]*")?\)/g, (all, alt: string, url: string, title?: string) => {
      const next = imageHref?.(url);
      if (next) return `![${alt}](${next}${title ?? ''})`;
      return unmapped?.(alt) ?? all;
    }),
  );
}

/** One image as Markdown: a local copy, the service URL, or a text note (see MdOptions.unmappedImage). */
function imageMarkdown(url: string, alt: string | undefined, opts: MdOptions): string {
  const L = opts.locale;
  const label = (alt ?? t(L, 'doc.image')).replace(/[[\]\n]/g, ' ');
  const href = opts.imageHref?.(url);
  if (href) return `![${label}](${href})`;
  return unmappedNote(alt, opts) ?? `![${label}](${url})`;
}

function unmappedNote(alt: string | undefined, opts: MdOptions): string | undefined {
  const L = opts.locale;
  const a = (alt ?? '').replace(/[[\]\n*_]/g, ' ').replace(/\s+/g, ' ').trim();
  const short = a.length > 80 ? `${a.slice(0, 79)}…` : a;
  if (opts.unmappedImage === 'omit') return `*[${t(L, 'doc.image')}${short ? `: ${short}` : ''}]*`;
  if (opts.unmappedImage === 'missing') return `*[${t(L, 'doc.imageMissing')}${short ? `: ${short}` : ''}]*`;
  return undefined;
}

function sizeLabel(n?: number): string {
  return typeof n === 'number' && n > 0 ? formatBytes(n) : '';
}

export function contentToMarkdown(c: ExportContent, opts: MdOptions): string {
  const L = opts.locale;
  switch (c.type) {
    case 'text':
    case 'markdown':
      return rewriteInlineImages(c.content ?? '', opts.imageHref, opts.unmappedImage && opts.unmappedImage !== 'link' ? (alt) => unmappedNote(alt || undefined, opts) : undefined);
    case 'thinking': {
      if (!opts.includeThinking) return '';
      return `<details>\n<summary>${t(L, 'doc.thinking')}</summary>\n\n${c.content ?? ''}\n\n</details>`;
    }
    case 'code': {
      const code = c.content ?? '';
      const f = codeFence(code);
      const title = c.title ? `**${c.title}**\n\n` : '';
      return `${title}${f}${c.language ?? ''}\n${code.replace(/\n$/, '')}\n${f}`;
    }
    case 'tool': {
      const code = toolDocText(c.content ?? '', L);
      const f = codeFence(code);
      return `**${t(L, 'doc.tool')} · ${c.title ?? ''}**\n\n${f}${c.language ?? ''}\n${code.replace(/\n$/, '')}\n${f}`;
    }
    case 'artifact':
    case 'html_widget': {
      const code = c.content ?? '';
      const f = codeFence(code);
      const lang = c.type === 'html_widget' ? 'html' : c.language ?? '';
      return `**${t(L, 'doc.artifact')} · ${c.title ?? ''}**\n\n${f}${lang}\n${code.replace(/\n$/, '')}\n${f}`;
    }
    case 'image':
      return c.imageUrl ? imageMarkdown(c.imageUrl, c.alt, opts) : '';
    case 'image_group':
      return (c.imageGroup?.images ?? [])
        .map((img) => {
          const url = img.imageUrl ?? img.thumbnailUrl;
          return url ? imageMarkdown(url, img.alt, opts) : '';
        })
        .filter(Boolean)
        .join('\n\n');
    case 'attachment': {
      const a = c.attachment ?? {};
      const key = a.url ?? (a.fileId ? `file:${a.fileId}` : undefined);
      const local = key ? opts.attachmentHref?.(key) : undefined;
      const name = attachmentName(a, L);
      const meta = [a.mime_type, sizeLabel(a.size)].filter(Boolean).join(', ');
      const label = local ? `[${name}](${local})` : `**${name}**`;
      let s = `> ${t(L, 'doc.attachment')}: ${label}${meta ? ` (${meta})` : ''}`;
      if (a.extractedText) {
        const f = codeFence(a.extractedText);
        s += `\n\n${t(L, 'doc.extractedText')} — ${name}\n\n${f}text\n${a.extractedText.replace(/\n$/, '')}\n${f}`;
      }
      return s;
    }
    case 'sources': {
      const list = c.sources ?? [];
      if (!list.length) return '';
      const items = list.map((s, i) => `${i + 1}. [${(s.title || s.url).replace(/[[\]]/g, '')}](${s.url})`);
      return `**${t(L, 'doc.sources')}**\n\n${items.join('\n')}`;
    }
  }
  return '';
}

/** Tool output longer than this is shortened in documents; the JSON/ZIP backups keep it whole. */
export const TOOL_DOC_LIMIT = 2_000;

export function toolDocText(content: string, locale: Locale): string {
  if (content.length <= TOOL_DOC_LIMIT) return content;
  const nl = content.lastIndexOf('\n', TOOL_DOC_LIMIT);
  const end = nl > TOOL_DOC_LIMIT * 0.6 ? nl : TOOL_DOC_LIMIT;
  return `${content.slice(0, end).replace(/\s+$/, '')}\n… ${t(locale, 'doc.toolClipped', { n: (content.length - end).toLocaleString('en-US') })}`;
}

export function messageBodyMarkdown(msg: ExportMessage, opts: MdOptions): string {
  const parts = msg.contents.map((c) => contentToMarkdown(c, opts)).filter((s) => s.trim().length > 0);
  if (msg.truncated) parts.push(`> ${t(opts.locale, 'doc.truncated')}`);
  return parts.join('\n\n');
}

export function conversationHeaderMarkdown(conv: Conversation, locale: Locale, exportedAt = Date.now()): string {
  const lines = [`# ${conv.title || conv.siteName}`, ''];
  lines.push(`- ${t(locale, 'doc.source')}: [${sourceDomain(conv)}](${conv.fromUrl})`);
  lines.push(`- ${t(locale, 'doc.exportedAt')}: ${formatDateTime(exportedAt)}`);
  lines.push(`- ${t(locale, 'doc.messages')}: ${conv.messages.length}`);
  return lines.join('\n');
}

export function conversationToMarkdown(conv: Conversation, opts: MdOptions, exportedAt = Date.now()): MdResult {
  const headers: string[] = [];
  const chunks: string[] = [conversationHeaderMarkdown(conv, opts.locale, exportedAt)];
  conv.messages.forEach((msg) => {
    const header = `### ${messageHeaderText(conv, msg, opts.locale)}`;
    headers.push(header);
    chunks.push(`${header}\n\n${messageBodyMarkdown(msg, opts)}`);
  });
  return { text: `${chunks.join('\n\n---\n\n')}\n`, headers };
}
