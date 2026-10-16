// Conversation → Markdown serializer (tech doc §25.1 fm/Ax). The Markdown string is also the
// intermediate representation used by the TXT, HTML/PDF, DOCX and HWPX exporters.

import { t, formatBytes, type Locale } from '../shared/i18n';
import type { Conversation, ExportContent, ExportMessage } from '../shared/types';
import { formatDateTime } from '../shared/util';

export interface MdOptions {
  locale: Locale;
  includeThinking?: boolean;
  /** Rewrites an image URL (e.g. to images/image-001.png in a ZIP). */
  imageHref?: (url: string) => string | undefined;
  /** Link target for an attachment saved alongside the document. */
  attachmentHref?: (key: string) => string | undefined;
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

export function messageHeaderText(conv: Pick<Conversation, 'siteName'>, msg: ExportMessage, locale: Locale): string {
  const parts = [roleLabel(conv, msg, locale)];
  if (msg.role === 'assistant' && msg.model) parts.push(msg.model);
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

export function rewriteInlineImages(md: string, imageHref?: (url: string) => string | undefined): string {
  if (!imageHref) return md;
  return replaceOutsideCode(md, (seg) =>
    seg.replace(/!\[([^\]]*)\]\((\S+?)(\s+"[^"]*")?\)/g, (all, alt: string, url: string, title?: string) => {
      const next = imageHref(url);
      return next ? `![${alt}](${next}${title ?? ''})` : all;
    }),
  );
}

function sizeLabel(n?: number): string {
  return typeof n === 'number' && n > 0 ? formatBytes(n) : '';
}

export function contentToMarkdown(c: ExportContent, opts: MdOptions): string {
  const L = opts.locale;
  switch (c.type) {
    case 'text':
    case 'markdown':
      return rewriteInlineImages(c.content ?? '', opts.imageHref);
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
    case 'image': {
      if (!c.imageUrl) return '';
      const href = opts.imageHref?.(c.imageUrl) ?? c.imageUrl;
      return `![${(c.alt ?? t(L, 'doc.image')).replace(/[[\]\n]/g, ' ')}](${href})`;
    }
    case 'image_group':
      return (c.imageGroup?.images ?? [])
        .map((img) => {
          const url = img.imageUrl ?? img.thumbnailUrl;
          if (!url) return '';
          return `![${(img.alt ?? t(L, 'doc.image')).replace(/[[\]\n]/g, ' ')}](${opts.imageHref?.(url) ?? url})`;
        })
        .filter(Boolean)
        .join('\n\n');
    case 'attachment': {
      const a = c.attachment ?? {};
      const key = a.url ?? (a.fileId ? `file:${a.fileId}` : undefined);
      const local = key ? opts.attachmentHref?.(key) : undefined;
      const name = a.name ?? 'file';
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
  lines.push(`- ${t(locale, 'doc.source')}: [${conv.siteName}](${conv.fromUrl})`);
  lines.push(`- ${t(locale, 'doc.exportedAt')}: ${formatDateTime(exportedAt)}`);
  lines.push(`- ${t(locale, 'doc.messages')}: ${conv.messages.length}`);
  if (conv.model) lines.push(`- ${t(locale, 'doc.model')}: ${conv.model}`);
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
