// Compares handoff files with full extractions (JSON exports) of the same real conversations.
//
// Put each conversation's JSON export and handoff .md (both made with the extension) in one folder
// OUTSIDE the repository; files are paired by the conversation link inside them. Then:
//   npm run check:real -- <folder>
// Only aggregate numbers are printed; `report.txt` with per-conversation details (it quotes the
// conversations) is written into that folder. Never commit those files.
//
// Checks: message count, structure, budget, size against the full export (v1.3.8: never larger;
// by the engine's estimate and by o200k), same result as a fresh local run (worker cache), every
// excerpt traceable to the message it cites, links that exist in the conversation, file list
// entries that look broken, and retention (compression-lab metrics).
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encode as o200k } from 'gpt-tokenizer/encoding/o200k_base';
import { fullExportTokens, handoffBudget, runHandoff } from '../../src/handoff/engine';
import { verifyHandoffMarkdown } from '../../src/handoff/render';
import { estimateTokens, urlKey } from '../../src/shared/util';
import { conversationToMarkdown, messageBodyMarkdown } from '../../src/export/markdown';
import type { Conversation } from '../../src/shared/types';
import { ALGORITHMS } from '../compression-lab/algorithms';
import { buildGold, score } from '../compression-lab/metrics';
import { corpusIdf, prepare } from '../compression-lab/prepare';

const DIR = process.argv[2];
if (!DIR || !existsSync(DIR)) {
  console.error('usage: npm run check:real -- <folder with JSON exports and handoff .md files>');
  process.exit(2);
}

/** Text normalized for "is this excerpt in the source": links become their text, markup goes. */
const norm = (s: string) =>
  s
    .normalize('NFC')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[*_`>#~|\\]/g, ' ')
    .replace(/[“”"]/g, '"')
    .replace(/[‘’']/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/** Fixed wording the renderer adds around excerpts (both languages). */
const TEMPLATE_BITS = [
  /\(\d+회 반복 강조\)|\(repeated \d+ times?\)/gi,
  /\(이후 \[#m\d+\]에서 해결된 것으로 보임\)|\(later [^)]*resolved[^)]*\)/gi,
  /\(전체는 아래 대화 원문[^)]*\)|\(full text in the transcript below[^)]*\)/g,
  /\(이어지는 내용은 아래 대화 원문[^)]*\)|\(continued in the transcript below[^)]*\)/g,
  /\(사용자가 \[#m\d+\]에서 승인\)|\(approved by the user[^)]*\)/gi,
  /→ \[#m\d+\]에서 변경됨[^\n]*|→ changed in[^\n]*/g,
  /→ (?:답변 요지|answer in short):/gi,
  /\(비슷한 요청 \d+회\)|\(\d+ similar requests?\)/g,
  /최근 대화 원문에 있는 코드는 그곳에만 둡니다[^\n]*|Code that is in the recent transcript[^\n]*/g,
  /\(길어서 가운데 일부 생략\)|\(middle omitted[^)]*\)/g,
  /_\(… \d+줄 생략 — 같거나 거의 같은 내용이 아래[^)]*\)_|_\(… \d+ lines omitted — the same or nearly the same text[^)]*\)_/g,
  /마지막 AI 응답 \[#m\d+\]: 아래 대화 원문에 전체가 있습니다\.|The last AI reply \[#m\d+\] is in the transcript below in full\./g,
  /\(첨부 \d+개: .*? — (?:「첨부 자료」|아래 대화 원문 \[#m\d+\])\)|\(\d+ attachments: .*? — (?:see “Attachments”|in the transcript below, \[#m\d+\])\)/g,
  /⚠️[^\n]*/g,
  /\s×\d+\b/g,
];
const REPEAT_NOTE_RE = /^_\(… \d+(?:줄 생략|\s+lines omitted) — [^\n]*\)_$/;
const LABEL_RE = /^\s*\*\*[^*]+\*\*\s*(?:\[#m\d+\])?\s*$/;
const FOOTER_RE = /Lucian AI Chat Exporter · /;
const TRANSCRIPT_RE = /원문$|verbatim|Recent conversation|Full conversation|핵심 문장만/i;
/** The condensed form of a short conversation (v1.3.8). */
const CONDENSED_RE = /^## (?:대화 원문 \(핵심 문장만\)|Conversation \(key sentences verbatim\))$/m;

function msgSource(conv: Conversation, m: number): string {
  const msg = conv.messages[m];
  if (!msg) return '';
  const parts = [messageBodyMarkdown({ ...msg, contents: msg.contents.filter((c) => c.type !== 'sources' && c.type !== 'thinking') }, { locale: 'ko' })];
  for (const c of msg.contents) {
    if (c.content && c.type !== 'thinking') parts.push(c.content);
    if (c.attachment?.name) parts.push(c.attachment.name);
    if (c.attachment?.extractedText) parts.push(c.attachment.extractedText);
    for (const s of c.sources ?? []) parts.push(`${s.title ?? ''} ${s.url}`);
  }
  return parts.join('\n');
}

function sections(md: string): Array<{ title: string; lines: string[] }> {
  const out: Array<{ title: string; lines: string[] }> = [];
  for (const line of md.split('\n')) {
    if (/^## /.test(line)) out.push({ title: line.slice(3).trim(), lines: [] });
    else out[out.length - 1]?.lines.push(line);
  }
  return out;
}

interface Trace {
  total: number;
  cited: number;
  elsewhere: number;
  missing: number;
  examples: string[];
}

function trace(lines: string[], srcNorm: string[], allNorm: string, allRaw: string, t: Trace): void {
  let code: string[] | null = null;
  let codeRefs: number[] = [];
  for (const raw of lines) {
    if (/^\s*(```|~~~)/.test(raw)) {
      if (code) {
        const body = norm(code.join('\n'));
        if (body.length >= 12) {
          t.total++;
          const probe = body.slice(0, 200);
          if (codeRefs.some((m) => srcNorm[m]?.includes(probe))) t.cited++;
          else if (allNorm.includes(probe)) t.elsewhere++;
          // A command list gathers lines from several messages.
          else if (code.map(norm).filter((l) => l.length >= 8).every((l) => allNorm.includes(l))) t.cited++;
          else {
            t.missing++;
            t.examples.push(`[code] ${probe.slice(0, 100)}`);
          }
        }
        code = null;
      } else {
        code = [];
      }
      continue;
    }
    if (code) {
      code.push(raw);
      continue;
    }
    const refs = [...raw.matchAll(/#m(\d+)/g)].map((x) => Number(x[1]) - 1);
    if (refs.length) codeRefs = refs;
    if (!refs.length || /^#{2,6}\s/.test(raw) || LABEL_RE.test(raw) || FOOTER_RE.test(raw)) continue;
    let text = raw;
    for (const re of TEMPLATE_BITS) text = text.replace(re, ' ');
    text = text.replace(/\[#m\d+[^\]]*\]/g, ' ').replace(/^\s*(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s+)?/, '');
    const tick = raw.match(/`([^`]{4,})`/)?.[1];
    for (const frag of text.split(/…|\.\.\./)) {
      const f = norm(frag).replace(/^[\s:,.;-]+|[\s:,.;-]+$/g, '');
      if (f.length < 12) continue;
      t.total++;
      // File and command entries are compared raw: a path can sit in a link target.
      if ((tick && allRaw.includes(tick)) || refs.some((m) => srcNorm[m]?.includes(f))) t.cited++;
      else if (allNorm.includes(f)) t.elsewhere++;
      else {
        t.missing++;
        t.examples.push(f.slice(0, 120));
      }
    }
  }
}

// ---------- pair files by the conversation link ----------
const files = readdirSync(DIR);
const exports = new Map<string, Conversation>();
for (const f of files.filter((x) => x.endsWith('.json'))) {
  try {
    const data = JSON.parse(readFileSync(join(DIR, f), 'utf8')) as { schema?: string; conversation?: Conversation };
    if (data.schema === 'lucian.conversation/v1' && data.conversation) exports.set(urlKey(data.conversation.fromUrl), data.conversation);
  } catch {
    /* not an export */
  }
}
const pairs: Array<{ name: string; conv: Conversation; md: string }> = [];
for (const f of files.filter((x) => x.endsWith('.md'))) {
  const md = readFileSync(join(DIR, f), 'utf8');
  const link = md.match(/^\| (?:원본 링크|URL) \| (\S+) \|/m)?.[1] ?? md.match(/\]\((https:\/\/[^)]+)\)/)?.[1];
  const conv = link ? exports.get(urlKey(link)) : undefined;
  if (conv) pairs.push({ name: f, conv, md });
}
if (!pairs.length) {
  console.error('no pairs found: each handoff .md needs the JSON export of the same conversation in the folder');
  process.exit(1);
}

const agg = {
  conversations: pairs.length,
  condensed: 0,
  messageCountMismatch: 0,
  structureFail: 0,
  overBudget: 0,
  /** Handoffs not smaller than the full Markdown export of the same chat (must be 0). */
  notSmallerThanFullExport: 0,
  notSmallerThanFullExportO200k: 0,
  /** Largest handoff / full export ratio (o200k). */
  maxShareOfFullExportO200k: 0,
  differsFromFreshRun: 0,
  brokenFileEntries: 0,
  signedOrImageLinks: 0,
  excerpts: { total: 0, cited: 0, elsewhere: 0, missing: 0 },
  links: { total: 0, ok: 0 },
  transcriptLines: { total: 0, ok: 0 },
  /** Runs of lines shown once because a later message repeats them (revised drafts). */
  repeatNotes: 0,
  /** Handoffs with an attachments section, and listed entries without text (files, images). */
  attachmentSections: 0,
  attachmentEntries: 0,
};
const report: string[] = [];

for (const { name, conv, md } of pairs) {
  const notes: string[] = [];
  const N = conv.messages.length;
  const condensed = CONDENSED_RE.test(md);
  if (condensed) agg.condensed++;
  // The condensed form names the count in its source line, which a very small budget leaves out.
  const count = md.match(/\| (?:메시지 수|Messages) \| (\d+)/)?.[1] ?? md.match(/· (?:메시지 (\d+)개|(\d+) messages?) ·/)?.slice(1).find(Boolean);
  if (count != null && Number(count) !== N) {
    agg.messageCountMismatch++;
    notes.push('message count differs from the export');
  }
  const lang = /^## (?:0\. 기본 정보|대화 원문 \(핵심 문장만\))/m.test(md) ? 'ko' : 'en';
  if (!verifyHandoffMarkdown(md, lang).ok) {
    agg.structureFail++;
    notes.push('structure check failed');
  }
  // Handoffs made before v1.3.8 included short chats whole ("전체 대화 원문").
  const full = /전체 대화 원문|Full conversation/.test(md);
  const tokens = estimateTokens(md);
  const R = fullExportTokens(conv);
  const budget = handoffBudget(R);
  if (tokens > budget * 1.02) {
    agg.overBudget++;
    notes.push(`over budget: ${tokens} > ${budget}`);
  }
  if (tokens >= R) {
    agg.notSmallerThanFullExport++;
    notes.push(`not smaller than the full export: ${tokens} ≥ ${R}`);
  }
  const fullMd = conversationToMarkdown(conv, { locale: lang }).text;
  const share = o200k(md).length / o200k(fullMd).length;
  agg.maxShareOfFullExportO200k = Math.max(agg.maxShareOfFullExportO200k, +share.toFixed(3));
  if (share >= 1) {
    agg.notSmallerThanFullExportO200k++;
    notes.push(`not smaller than the full export by o200k: ${(100 * share).toFixed(0)}%`);
  }
  const strip = (s: string) => s.replace(/^\| (?:추출 시각|Extracted) \|.*$/m, '').replace(/ · (?:추출|extracted) \d{4}-\d\d-\d\d \d\d:\d\d$/m, '');
  if (strip(runHandoff(conv, {}).markdown) !== strip(md)) {
    agg.differsFromFreshRun++;
    notes.push('differs from a fresh run of this engine (other version, or a stale cache)');
  }
  const filesSec = md.match(/### (?:파일 · 경로|Files)\n([\s\S]*?)(?=\n###|\n## |$)/)?.[1] ?? '';
  const broken = [...filesSec.matchAll(/^- `([^`]+)`/gm)].map((x) => x[1]).filter((e) => /^[A-Za-z]:\/(?:mnt|workspace|home)\b/.test(e) || /_$/.test(e) || /(^|\.)(?:com|net|org|io|kr)$/i.test(e));
  if (broken.length) {
    agg.brokenFileEntries += broken.length;
    notes.push(`file entries that look broken: ${broken.length}`);
  }
  if (/!\[[^\]]*\]\(|[?&](?:sig|token|signature|X-Amz-Signature)=/i.test(md.replace(/```[\s\S]*?```/g, ''))) {
    agg.signedOrImageLinks++;
    notes.push('image link or signed URL');
  }
  const srcRaw = conv.messages.map((_, m) => msgSource(conv, m));
  const srcNorm = srcRaw.map(norm);
  const allNorm = srcNorm.join('\n');
  const allRaw = srcRaw.join('\n');
  const urlKeys = new Set<string>();
  for (const u of allRaw.match(/https?:\/\/[^\s)<>\]"'`]+/g) ?? []) urlKeys.add(urlKey(u.replace(/[.,;:!?]+$/, '')));
  const t: Trace = { total: 0, cited: 0, elsewhere: 0, missing: 0, examples: [] };
  for (const sec of sections(md)) {
    if (/^\d+\. (?:기본 정보|Source|Basic)/.test(sec.title)) continue;
    if (TRANSCRIPT_RE.test(sec.title)) {
      let cur = -1;
      let inCode = false;
      for (const line of sec.lines) {
        const h = line.match(/^### \[#m(\d+)\]/);
        if (h) {
          cur = Number(h[1]) - 1;
          continue;
        }
        if (/^\s*(```|~~~)/.test(line)) {
          inCode = !inCode;
          continue;
        }
        if (REPEAT_NOTE_RE.test(line.trim())) {
          agg.repeatNotes++;
          continue;
        }
        // The condensed form shows list items with "- " whatever their marker was ("1.").
        let f = norm(line.replace(/\[(?:이미지|image|첨부|Attachment)(?::[^\]]*)?\]/g, ' ').replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ''));
        for (const re of TEMPLATE_BITS) f = f.replace(re, ' ');
        if (f.length < 12 || cur < 0 || FOOTER_RE.test(line) || /^… \[(?:omitted|약)/.test(line.trim()) || /^(첨부파일|attachment|추출된 텍스트|extracted text)/.test(f)) continue;
        agg.transcriptLines.total++;
        if (srcNorm[cur]?.includes(f) || (inCode && srcNorm[cur]?.includes(f.slice(0, 40)))) agg.transcriptLines.ok++;
        else t.examples.push(`[transcript #m${cur + 1}] ${f.slice(0, 100)}`);
      }
      continue;
    }
    if (/참고 링크|Links/.test(sec.title)) {
      for (const line of sec.lines) {
        for (const u of line.match(/https?:\/\/[^\s)<>\]]+/g) ?? []) {
          agg.links.total++;
          if (urlKeys.has(urlKey(u))) agg.links.ok++;
          else t.examples.push(`[link not in conversation] ${u.slice(0, 90)}`);
        }
      }
      continue;
    }
    if (/첨부 자료|Attachments/.test(sec.title)) {
      // Verbatim attachment text (fenced, under a heading with its [#mN]) is traced like code;
      // names, sizes and notes around it are the renderer's own words.
      let inFence = false;
      const kept: string[] = [];
      for (const line of sec.lines) {
        const isFence = /^\s*(```|~~~)/.test(line);
        if (isFence) inFence = !inFence;
        if (isFence || inFence || /^#{2,6}\s/.test(line)) kept.push(line);
        else if (/\[#m\d+\]/.test(line)) agg.attachmentEntries++;
      }
      trace(kept, srcNorm, allNorm, allRaw, t);
      agg.attachmentSections++;
      continue;
    }
    trace(sec.lines, srcNorm, allNorm, allRaw, t);
  }
  agg.excerpts.total += t.total;
  agg.excerpts.cited += t.cited;
  agg.excerpts.elsewhere += t.elsewhere;
  agg.excerpts.missing += t.missing;
  if (t.missing || t.elsewhere) notes.push(`excerpts: ${t.cited}/${t.total} in the cited message, ${t.elsewhere} elsewhere, ${t.missing} not found`);
  if (notes.length || t.examples.length) report.push(`${name} (${N} messages, ${full ? 'full (before v1.3.8)' : condensed ? 'condensed' : 'compressed'}):\n  - ${notes.join('\n  - ')}${t.examples.length ? `\n  examples:\n    ${t.examples.slice(0, 8).join('\n    ')}` : ''}`);
}

// Retention of the handoffs, with the compression lab's metrics (and plain coverage at the same
// budget for reference).
const P = pairs.map((x) => prepare(x.conv));
const idf = corpusIdf(P);
const keys = ['fact', 'keyTerms', 'user', 'entities', 'recent', 'composite'] as const;
const sum = { lucian: Object.fromEntries(keys.map((k) => [k, 0])), coverage: Object.fromEntries(keys.map((k) => [k, 0])) } as Record<'lucian' | 'coverage', Record<string, number>>;
let n = 0;
pairs.forEach((x, k) => {
  if (/전체 대화 원문|Full conversation/.test(x.md)) return;
  n++;
  const gold = buildGold(P[k], idf);
  const a = score(x.md, gold);
  const b = score(ALGORITHMS.coverage(P[k], handoffBudget(fullExportTokens(x.conv)), idf), gold);
  for (const key of keys) {
    sum.lucian[key] += a[key];
    sum.coverage[key] += b[key];
  }
});
const pct = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, +((100 * v) / Math.max(1, n)).toFixed(1)]));
const summary = { ...agg, retention: { n, handoff: pct(sum.lucian), coverage: pct(sum.coverage) } };
writeFileSync(join(DIR, 'report.txt'), `${JSON.stringify(summary, null, 2)}\n\n${report.join('\n\n')}\n`);
console.log(JSON.stringify(summary, null, 2));
console.log(`\nDetails (quote the conversations, keep them out of the repo): ${join(DIR, 'report.txt')}`);
