// TXT export (tech doc §23): the same Markdown intermediate representation, flattened to plain
// text. Code is kept verbatim, tables become pipe-separated rows, links keep their URL.

import { t, type Locale } from '../shared/i18n';
import { sourceDomain } from '../shared/sites';
import type { Conversation } from '../shared/types';
import { formatDateTime } from '../shared/util';
import { messageBodyMarkdown, messageHeaderText } from './markdown';
import { lex, type Token, type Tokens } from './md-parse';

function inlineText(tokens: Token[] | undefined): string {
  if (!tokens) return '';
  return tokens
    .map((tok) => {
      switch (tok.type) {
        case 'text': {
          const tt = tok as Tokens.Text;
          return tt.tokens ? inlineText(tt.tokens) : tt.text;
        }
        case 'strong':
        case 'em':
        case 'del':
          return inlineText((tok as Tokens.Strong).tokens);
        case 'codespan':
          return (tok as Tokens.Codespan).text;
        case 'escape':
          return (tok as Tokens.Escape).text;
        case 'br':
          return '\n';
        case 'link': {
          const l = tok as Tokens.Link;
          const text = inlineText(l.tokens);
          return text && text !== l.href ? `${text} (${l.href})` : l.href;
        }
        case 'image': {
          const im = tok as Tokens.Image;
          return `[${im.text || 'image'}: ${im.href}]`;
        }
        case 'mathInline':
          return `$${(tok as unknown as { text: string }).text}$`;
        case 'mathBlock':
          return `$$${(tok as unknown as { text: string }).text}$$`;
        default:
          return (tok as { raw?: string }).raw ?? '';
      }
    })
    .join('');
}

function blockText(tokens: Token[], depth = 0): string {
  const out: string[] = [];
  const pad = '  '.repeat(depth);
  for (const tok of tokens) {
    switch (tok.type) {
      case 'space':
        break;
      case 'paragraph':
      case 'text':
        out.push(pad + inlineText((tok as Tokens.Paragraph).tokens ?? [{ type: 'text', raw: (tok as Tokens.Text).text, text: (tok as Tokens.Text).text } as Token]).replace(/\n/g, `\n${pad}`));
        break;
      case 'heading':
        out.push(inlineText((tok as Tokens.Heading).tokens));
        break;
      case 'code': {
        const c = tok as Tokens.Code;
        out.push(`${c.lang ? `[${c.lang}]\n` : ''}${c.text}`);
        break;
      }
      case 'blockquote':
        out.push(
          blockText((tok as Tokens.Blockquote).tokens, 0)
            .split('\n')
            .map((l) => `${pad}> ${l}`)
            .join('\n'),
        );
        break;
      case 'list': {
        const l = tok as Tokens.List;
        let n = Number(l.start || 1);
        const items = l.items.map((item) => {
          const marker = l.ordered ? `${n++}.` : '-';
          const task = item.task ? (item.checked ? '[x] ' : '[ ] ') : '';
          const body = blockText(item.tokens, 0).split('\n');
          return `${pad}${marker} ${task}${body[0] ?? ''}${body.slice(1).map((b) => `\n${pad}   ${b}`).join('')}`;
        });
        out.push(items.join('\n'));
        break;
      }
      case 'table': {
        const tb = tok as Tokens.Table;
        const head = tb.header.map((h) => inlineText(h.tokens)).join(' | ');
        const rows = tb.rows.map((r) => r.map((c) => inlineText(c.tokens)).join(' | '));
        out.push([head, head.replace(/[^|]/g, '-'), ...rows].join('\n'));
        break;
      }
      case 'hr':
        out.push('----');
        break;
      case 'mathBlock':
        out.push(`$$${(tok as unknown as { text: string }).text}$$`);
        break;
      default:
        out.push((tok as { raw?: string }).raw ?? '');
    }
  }
  return out.join('\n\n');
}

export function markdownToTxt(markdown: string, breaks = false): string {
  return blockText(lex(markdown, { breaks }));
}

export function conversationToTxt(conv: Conversation, locale: Locale, exportedAt = Date.now()): { text: string; headers: string[] } {
  const headers: string[] = [];
  const lines: string[] = [
    conv.title || conv.siteName,
    `${t(locale, 'doc.source')}: ${sourceDomain(conv)} (${conv.fromUrl})`,
    `${t(locale, 'doc.exportedAt')}: ${formatDateTime(exportedAt)}`,
    `${t(locale, 'doc.messages')}: ${conv.messages.length}`,
  ];
  const sep = '='.repeat(60);
  const blocks = [lines.join('\n')];
  for (const m of conv.messages) {
    const header = `[${messageHeaderText(conv, m, locale)}]`;
    headers.push(header);
    // User text keeps every newline; assistant Markdown is flattened.
    const md = messageBodyMarkdown(m, { locale });
    blocks.push(`${header}\n\n${markdownToTxt(md, m.role === 'user')}`);
  }
  return { text: `${blocks.join(`\n\n${sep}\n\n`)}\n`, headers };
}
