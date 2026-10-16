// Splits each message into units: sentences, list items, headings, code blocks and tables.
// Line-based and regex-only so it stays fast on million-token conversations.

import type { ExportMessage, Role } from '../shared/types';
import { fnv1a } from '../shared/util';

export type UnitKind = 'sentence' | 'item' | 'heading' | 'code' | 'table' | 'quote' | 'attachment';

export interface Unit {
  /** Message index (0-based) in the conversation. */
  m: number;
  role: Role;
  kind: UnitKind;
  text: string;
  /** 53-bit hash of the normalized text (two FNV-1a passes). */
  key: number;
  lang?: string;
  title?: string;
  checked?: boolean;
  /** Nesting under a heading that looked like "next steps" in the same message. */
  underNext?: boolean;
}

export function normalizeForHash(text: string, code: boolean): string {
  if (code) return text.replace(/[ \t]+$/gm, '').trim();
  return text
    .toLowerCase()
    .replace(/[*_`#>~]+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—:;,.!?]+|[\s\-–—:;,.!?]+$/g, '')
    .trim();
}

export function unitKey(norm: string): number {
  return fnv1a(norm) * 2097152 + (fnv1a(norm, 0x01000193) & 0x1fffff);
}

const NEXT_HEADING = /(다음\s?(단계|작업|할\s?일)|남은\s?작업|todo|to-do|next\s?steps?|next up|remaining|follow[- ]?ups?|action items|할\s?일)/i;

/** Splits a paragraph into sentences without breaking URLs, paths, decimals or abbreviations. */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  const n = text.length;
  const emit = (end: number) => {
    const s = text.slice(start, end).trim();
    // Keep very short fragments ("e.g.", "1.", "v2.") attached to the following text.
    if (s.length >= 4 || (s && end >= n)) {
      out.push(s);
      start = end;
    }
  };
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c === 10) {
      emit(i + 1);
      continue;
    }
    // . ! ? 。 ！ ？ followed by whitespace or the end of text ends a sentence.
    if (c === 46 || c === 33 || c === 63 || c === 0x3002 || c === 0xff01 || c === 0xff1f) {
      let j = i + 1;
      while (j < n && (text.charCodeAt(j) === 46 || text.charCodeAt(j) === 33 || text.charCodeAt(j) === 63)) j++;
      const next = j < n ? text.charCodeAt(j) : 32;
      if (next === 32 || next === 10 || next === 9 || next === 13 || c >= 0x3000) {
        emit(j);
        i = j - 1;
      }
    }
  }
  const rest = text.slice(start).trim();
  if (rest) {
    if (out.length && rest.length < 4) out[out.length - 1] += ` ${rest}`;
    else out.push(rest);
  }
  return out;
}

function pushUnit(units: Unit[], m: number, role: Role, kind: UnitKind, text: string, extra: Partial<Unit> = {}): void {
  const t = text.trim();
  if (!t) return;
  const norm = normalizeForHash(t, kind === 'code');
  if (!norm) return;
  units.push({ m, role, kind, text: t, key: unitKey(`${kind === 'code' ? 'c' : 'p'}:${norm}`), ...extra });
}

/** Segments Markdown text (fenced code, tables, headings, lists, quotes, paragraphs). */
export function segmentMarkdown(md: string, m: number, role: Role, units: Unit[]): void {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  let para: string[] = [];
  let underNext = false;
  const flushPara = (kind: UnitKind = 'sentence') => {
    if (!para.length) return;
    const text = para.join('\n');
    para = [];
    const sentences = splitSentences(text);
    for (const s of sentences) pushUnit(units, m, role, kind, s, { underNext });
    // A short label such as "Next steps:" / "다음 단계:" introduces the list that follows.
    const last = sentences[sentences.length - 1] ?? '';
    if (last.length <= 60 && /[:：]\s*$/.test(last)) underNext = NEXT_HEADING.test(last);
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/);
    if (fence) {
      flushPara();
      const marker = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(marker)) body.push(lines[i++]);
      pushUnit(units, m, role, 'code', body.join('\n'), { lang: fence[2] || undefined });
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushPara();
      const rows: string[] = [line];
      while (i + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[i + 1])) rows.push(lines[++i]);
      pushUnit(units, m, role, 'table', rows.join('\n'));
      continue;
    }
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.*)$/);
    if (heading) {
      flushPara();
      underNext = NEXT_HEADING.test(heading[1]);
      pushUnit(units, m, role, 'heading', heading[1]);
      continue;
    }
    const item = line.match(/^(\s*)(?:[-*+•]|\d+[.)])\s+(\[[ xX]\]\s+)?(.*)$/);
    if (item) {
      flushPara();
      let text = item[3];
      while (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1]) && !/^\s*(?:[-*+•]|\d+[.)])\s+/.test(lines[i + 1]) && !/^\s*(`{3,}|~{3,})/.test(lines[i + 1])) {
        text += ` ${lines[++i].trim()}`;
      }
      const checked = item[2] ? /x/i.test(item[2]) : undefined;
      pushUnit(units, m, role, 'item', checked === undefined ? text : `${checked ? '[x]' : '[ ]'} ${text}`, { checked, underNext });
      continue;
    }
    if (/^\s*>/.test(line)) {
      flushPara();
      pushUnit(units, m, role, 'quote', line.replace(/^\s*>\s?/, ''));
      continue;
    }
    if (!line.trim()) {
      flushPara();
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushPara();
      continue;
    }
    para.push(line);
  }
  flushPara();
}

/** Turns one message into units. Thinking blocks are excluded; tool output is kept as code. */
export function segmentMessage(msg: ExportMessage, m: number, units: Unit[]): void {
  const role = msg.role;
  for (const c of msg.contents) {
    switch (c.type) {
      case 'text':
        // User text is plain text: treat every line as its own paragraph line but keep fences.
        segmentMarkdown(c.content ?? '', m, role, units);
        break;
      case 'markdown':
        segmentMarkdown(c.content ?? '', m, role, units);
        break;
      case 'code':
      case 'artifact':
      case 'html_widget':
        pushUnit(units, m, role, 'code', c.content ?? '', { lang: c.type === 'html_widget' ? 'html' : c.language, title: c.title });
        break;
      case 'tool':
        pushUnit(units, m, role, 'code', c.content ?? '', { lang: c.language ?? 'text', title: `tool:${c.title ?? ''}` });
        break;
      case 'attachment':
        if (c.attachment?.name) pushUnit(units, m, role, 'attachment', c.attachment.name);
        break;
      default:
        break;
    }
  }
}
