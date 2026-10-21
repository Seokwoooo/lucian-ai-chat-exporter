// Lucian Handoff engine. Turns a full conversation into an extractive handoff document that
// another AI can continue from. Every line it outputs is copied from the conversation (with a
// [#mN] reference); the algorithm only selects, orders and labels — it never invents facts.
//
// Pipeline: normalize (segment) → dedupe (hash + MinHash/LSH) → score (rule-based signals,
// recency, repetition) → track decisions / constraints / tasks → budgeted selection → render.

import type { Conversation, HandoffStats, Role } from '../shared/types';
import { cleanUrl, estimateTokens, hangulRatio, hostLabel, urlKey } from '../shared/util';
import { conversationToMarkdown, messageBodyMarkdown, replaceOutsideCode } from '../export/markdown';
import { clusterNearDuplicates, minhash } from './minhash';
import { conceptsOf, greedyCoverage, type CoverItem } from './coverage';
import { ANAPHOR_RE, CODE_ERROR_RE, F, REVERSAL_RE, balanceBold, bulletText, classify, clipText, extractCommands, extractLinks, extractPaths, extractUrls, jaccard, nameImages, replacementPairs, stripTracking, topicTokens } from './patterns';
import { segmentMarkdown, segmentMessage, type Unit } from './segment';
import { CONDENSED_FRAMES, clipHead, renderCondensedHandoff, renderHandoff, type CondensedFrame, type AttachmentItem, type CondensedMessage, type CondensedPiece, type HandoffDoc, type Item, type CodeItem, type PastItem, type RecentMessage, type RequestItem } from './render';

export interface CacheEntry {
  flags: number;
  sig?: Uint32Array;
}
export type CacheMap = Map<number, CacheEntry>;

export interface HandoffTimings {
  normalizeMs: number;
  dedupeMs: number;
  scoreMs: number;
  renderMs: number;
}

export interface HandoffResult {
  markdown: string;
  lang: 'ko' | 'en';
  stats: HandoffStats & { uncertain: number; outputChars: number };
  timings: HandoffTimings;
  cache: CacheMap;
}

export interface HandoffOptions {
  now?: number;
  cache?: CacheMap;
  onPhase?: (phase: 'normalize' | 'dedupe' | 'score' | 'render') => void;
  /** Fraction of the work done (0…1): normalize ≈ 35%, dedupe ≈ 40%, score + select ≈ 20%, render. */
  onProgress?: (fraction: number) => void;
  /** Fixed output budget in tokens instead of the default (handoffBudget). Used by the compression lab. */
  budgetTokens?: number;
  /** How the remaining budget is filled with earlier context: relevance ranking or concept coverage. */
  selection?: 'relevance' | 'coverage';
  /** Budget layout overrides (compression lab). */
  layout?: Partial<Layout>;
}

/** How the compressed-mode budget is split. Shares are fractions of the budget. */
export interface Layout {
  /** Verbatim recent transcript. */
  recentShare: number;
  recentMin: number;
  /** Per-message token caps in the recent transcript: the last two messages, older ones. */
  lastMsgCap: number;
  recentMsgCap: number;
  /** The same caps as shares of the budget, so a small budget clips harder (0 = fixed caps). */
  lastMsgShare: number;
  /** Upper bound for each of the last two messages as a share of the budget (binds below ~8k). */
  lastMsgMaxShare: number;
  recentMsgShare: number;
  /** Latest version of each code block not already in the transcript. */
  codeShare: number;
  codeMin: number;
  /** Multiplier for the shares of the list sections (requests, done, open, failures). */
  listScale: number;
  /** Share for decisions + constraints (half each at most; Infinity = never cut). */
  ruleShare: number;
  /** Units cut out of clipped transcript messages may be selected as context excerpts. */
  clippedExcerpts: boolean;
  /** Excerpts that open with a reference ("이 방식은…") get the sentence before them. */
  repair: boolean;
  /** Lines a later transcript message repeats (revised drafts) are shown once (v1.3.4). */
  collapseRepeats: boolean;
  /**
   * Share of the budget for verbatim attachment text (files and pasted text) of messages outside
   * the transcript; 0 = no attachment section (v1.3.5). The first and the latest request's
   * attachments come first.
   */
  attachShare: number;
  /** Appendix table of referenced messages (role, time, first line). */
  refIndex: boolean;
  /**
   * Budgets below this get the condensed form (the conversation with its key sentences) instead of
   * the sections (v1.3.8); 0 = always sections.
   */
  sectionsFrom: number;
  /** How much rule-based relevance raises a unit's coverage gain (0 = concepts only, 1 = up to ×2 over the least relevant). */
  relPrior: number;
  /** One listed file path per this many budget tokens (6–40 paths). */
  filesPer: number;
}

/** Budget from which the handoff has sections (see Layout.sectionsFrom). */
export const SECTIONS_FROM = 4_000;

/**
 * Chosen with the QA evaluation (docs/compression-lab.md, 3rd study): a reader AI answered
 * questions from the handoff alone, and the structured sections and the transcript had taken so
 * much of the budget that budgeted coverage of earlier context — what answered the questions —
 * got 6–28% of the document. Most of the budget now goes to coverage; the sections stay, smaller.
 */
export const DEFAULT_LAYOUT: Layout = {
  recentShare: 0.06,
  recentMin: 400,
  lastMsgCap: 2500,
  recentMsgCap: 1500,
  // The last two messages keep the v1.2 cap: on real chats (few, very long messages) a cap that
  // shrinks with the budget lost 10 points of the latest messages for 5 points of facts.
  lastMsgShare: 0,
  lastMsgMaxShare: 0.32,
  recentMsgShare: 0.06,
  codeShare: 0.06,
  codeMin: 300,
  listScale: 0.4,
  ruleShare: 0.2,
  clippedExcerpts: true,
  repair: true,
  collapseRepeats: true,
  attachShare: 0.12,
  refIndex: false,
  sectionsFrom: SECTIONS_FROM,
  relPrior: 0.5,
  filesPer: 200,
};

/** v1.2 layout, kept for comparison in the compression lab. */
export const V12_LAYOUT: Layout = {
  recentShare: 0.25,
  recentMin: 2500,
  lastMsgCap: 2500,
  recentMsgCap: 1500,
  lastMsgShare: 0,
  lastMsgMaxShare: 0.32,
  recentMsgShare: 0,
  codeShare: 0.1,
  codeMin: 600,
  listScale: 1,
  ruleShare: Infinity,
  clippedExcerpts: true,
  repair: true,
  collapseRepeats: false,
  attachShare: 0,
  refIndex: true,
  sectionsFrom: 0,
  relPrior: 0.5,
  filesPer: 200,
};

/** v1.1 layout, kept for comparison in the compression lab. */
export const V11_LAYOUT: Layout = { ...V12_LAYOUT, lastMsgCap: 6000, recentMsgCap: 4000, codeShare: 0.25, codeMin: 1500, clippedExcerpts: false, repair: false };

/** Earlier-context selection used by default (chosen with the compression lab, docs/compression-lab.md). */
export const DEFAULT_SELECTION: 'relevance' | 'coverage' = 'coverage';

/**
 * The handoff is never larger than this share of the full export of the same conversation
 * (v1.3.8). Short conversations used to be handed off whole, with the sections and the reader
 * instructions on top, so the "compressed" file was larger than the full Markdown export. 2/3 is
 * the share the shortest compressed conversations already had (8k of 12k).
 */
export const FULL_EXPORT_SHARE = 2 / 3;
/** The rendered document may exceed its budget by this factor (section estimates are rough). */
export const BUDGET_TOLERANCE = 1.02;
const MIN_BUDGET = 8_000;
const MAX_BUDGET = 32_000;

const SIG_MIN_PROSE = 120;
/** User sentences are short but repeated instructions matter, so they get signatures earlier. */
const SIG_MIN_USER = 24;
const SIG_MIN_CODE = 60;

const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Output budget for a conversation whose full export is `sourceTokens` long: 12% of it within
 * 8k–32k, and never more than FULL_EXPORT_SHARE of it.
 */
export function handoffBudget(sourceTokens: number): number {
  return Math.min(Math.round(Math.min(MAX_BUDGET, Math.max(MIN_BUDGET, sourceTokens * 0.12))), Math.floor(sourceTokens * FULL_EXPORT_SHARE));
}

/**
 * Size of the full export the handoff is measured against: the Markdown export with the shortest
 * labels (English) and images as text notes, so the handoff stays smaller than every variant of
 * it (Korean labels, image links) and than the TXT export.
 */
export function fullExportTokens(conv: Conversation, now = Date.now()): number {
  return estimateTokens(conversationToMarkdown(conv, { locale: 'en', unmappedImage: 'omit' }, now).text);
}

/**
 * The user's language: Korean when at least a third of the user's messages are mostly Hangul. Per
 * message, so one long English paste (a log, a terminal screen) does not turn a Korean user's
 * handoff into English (v1.3.8).
 */
export function detectLanguage(conv: Conversation): 'ko' | 'en' {
  let ko = 0;
  let counted = 0;
  for (const msg of conv.messages) {
    if (msg.role !== 'user') continue;
    const text = msg.contents
      .filter((c) => c.type === 'text' || c.type === 'markdown')
      .map((c) => c.content ?? '')
      .join('\n');
    if (!/[A-Za-z가-힣]/.test(text)) continue;
    counted++;
    if (hangulRatio(text) >= 0.2) ko++;
  }
  if (counted) return ko * 3 >= counted ? 'ko' : 'en';
  return hangulRatio(conv.messages.map((m) => m.contents.map((c) => c.content ?? '').join(' ')).join(' ').slice(0, 40_000)) >= 0.2 ? 'ko' : 'en';
}

interface Analysis {
  units: Unit[];
  flags: Uint32Array;
  score: Float64Array;
  /** Representative (latest occurrence) of each unit's duplicate cluster. */
  rep: Int32Array;
  /** Number of distinct messages in which the same (near-)duplicate text appears. */
  repeats: Uint16Array;
  /** Count of earlier versions superseded by this representative (code iterations). */
  versions: Uint16Array;
}

export function runHandoff(conv: Conversation, opts: HandoffOptions = {}): HandoffResult {
  const now = opts.now ?? Date.now();
  const cache: CacheMap = opts.cache ?? new Map();
  let hits = 0;
  let misses = 0;

  // ---------- 1. normalize ----------
  opts.onPhase?.('normalize');
  let t0 = clock();
  const messages = conv.messages;
  const N = messages.length;
  const units: Unit[] = [];
  const msgTokens = new Float64Array(N);
  const msgUnitStart = new Int32Array(N + 1);
  const progress = opts.onProgress;
  const step = Math.max(1, Math.floor(N / 50));
  for (let m = 0; m < N; m++) {
    if (progress && m % step === 0) progress((0.35 * m) / N);
    msgUnitStart[m] = units.length;
    segmentMessage(messages[m], m, units);
    for (const c of messages[m].contents) {
      if (c.type === 'thinking') continue;
      msgTokens[m] += estimateTokens(c.content ?? c.attachment?.extractedText ?? '');
    }
  }
  msgUnitStart[N] = units.length;
  // The source size is the full export: what the user compares the handoff with (v1.3.8). Tool
  // output is clipped there, and headers, sources and image notes count.
  const sourceTokens = fullExportTokens(conv, now);
  const lang = detectLanguage(conv);
  const timings: HandoffTimings = { normalizeMs: clock() - t0, dedupeMs: 0, scoreMs: 0, renderMs: 0 };

  // ---------- 2. dedupe ----------
  opts.onPhase?.('dedupe');
  t0 = clock();
  const U = units.length;
  const flags = new Uint32Array(U);
  const sigs: Array<Uint32Array | undefined> = new Array(U);
  const uStep = Math.max(1, Math.floor(U / 40));
  for (let i = 0; i < U; i++) {
    if (progress && i % uStep === 0) progress(0.35 + (0.3 * i) / U);
    const u = units[i];
    const entry = cache.get(u.key);
    const wantsSig = u.kind === 'code' ? u.text.length >= SIG_MIN_CODE : u.text.length >= (u.role === 'user' ? SIG_MIN_USER : SIG_MIN_PROSE);
    if (entry && (!wantsSig || entry.sig)) {
      hits++;
      flags[i] = entry.flags;
      sigs[i] = entry.sig;
      continue;
    }
    misses++;
    const f = u.kind === 'code' ? (CODE_ERROR_RE.test(u.text.slice(0, 6000)) ? F.FAILURE : 0) : classify(u.text, u.role);
    const sig = wantsSig ? minhash(u.kind === 'code' ? u.text : u.text.toLowerCase()) : undefined;
    flags[i] = f;
    sigs[i] = sig;
    cache.set(u.key, { flags: f, sig });
  }
  // Exact duplicates share a key; near duplicates share an LSH cluster. The representative is
  // the latest occurrence so the newest version of repeated code / text wins.
  progress?.(0.65);
  const near = clusterNearDuplicates(sigs, (i) => (units[i].kind === 'code' ? `c:${units[i].lang ?? ''}` : `p:${units[i].role}`), 0.72);
  // Union-find over near-duplicate clusters and exact-key duplicates.
  const parent = Int32Array.from(near);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const firstByKey = new Map<number, number>();
  for (let i = 0; i < U; i++) {
    const f = firstByKey.get(units[i].key);
    if (f == null) firstByKey.set(units[i].key, i);
    else {
      const ra = find(i);
      const rb = find(f);
      if (ra !== rb) parent[ra] = rb;
    }
  }
  const rep = new Int32Array(U).fill(-1);
  const members = new Map<number, number[]>();
  for (let i = 0; i < U; i++) {
    const g = find(i);
    const list = members.get(g);
    if (list) list.push(i);
    else members.set(g, [i]);
  }
  const repeats = new Uint16Array(U);
  const versions = new Uint16Array(U);
  for (const list of members.values()) {
    const latest = list[list.length - 1];
    const msgs = new Set(list.map((i) => units[i].m));
    for (const i of list) {
      rep[i] = latest;
      repeats[i] = Math.min(65535, msgs.size);
    }
    versions[latest] = Math.min(65535, msgs.size - 1);
  }
  timings.dedupeMs = clock() - t0;
  progress?.(0.75);

  // ---------- 3. score ----------
  opts.onPhase?.('score');
  t0 = clock();
  const score = new Float64Array(U);
  const lastIdx = Math.max(1, N - 1);
  // A short user confirmation ("좋아요, 그걸로 하죠") confirms the previous assistant proposal.
  const confirmedMsgs = new Set<number>();
  for (let m = 1; m < N; m++) {
    if (messages[m].role !== 'user') continue;
    const start = msgUnitStart[m];
    const end = msgUnitStart[m + 1];
    if (end - start <= 3 && end > start && Array.from({ length: end - start }, (_, k) => flags[start + k]).some((f) => f & F.CONFIRM)) {
      confirmedMsgs.add(m - 1);
    }
  }
  for (let i = 0; i < U; i++) {
    const u = units[i];
    const f = flags[i];
    const r = u.m / lastIdx;
    const user = u.role === 'user';
    let s = 0.2;
    if (u.kind === 'code') {
      s = 1 + r * 2.5 + (versions[i] > 0 ? 0.8 : 0) + (user ? 1 : 0);
    } else {
      if (f & F.DIRECTIVE) s += user ? (f & F.ASK ? 0.8 : 3) : 0.4;
      if (f & F.PROHIBIT) s += user ? 4.5 : 1;
      else if (f & F.CONSTRAINT) s += user ? 2 : 0.4;
      if (f & F.DECISION) s += user ? 4 : 1.5;
      if (f & F.RECOMMEND && confirmedMsgs.has(u.m)) s += 3;
      if (f & F.CHANGE) s += user ? 1.5 : 0.4;
      if (f & F.DONE && !(f & F.NOT_DONE)) s += user ? 1.2 : 2;
      if (f & F.TODO) s += 1.8;
      if (f & F.NEXT) s += 1.2;
      if (f & F.FAILURE) s += 1.4 + (f & F.CAUSE ? 1 : 0);
      if (f & F.GOAL) s += user ? 3 : 0.6;
      if (f & F.EMPHASIS) s += user ? 1.5 : 0.3;
      if (f & F.QUESTION) s += user ? 0.6 : 0;
      if (f & F.LEAD && !user) s += 1;
      if (f & F.PENDING) s += 1.2;
      if (f & F.POLITE) s -= 3;
      if (u.kind === 'heading') s += 0.5;
      if (u.kind === 'table') s += 0.8;
      const ents = extractPaths(u.text).length + extractCommands(u.text).length;
      s += Math.min(2, ents * 0.8) + Math.min(0.8, extractUrls(u.text.includes('](') ? bulletText(u.text) : u.text).length * 0.4);
      if (u.text.length < 8 && !(f & F.CONFIRM)) s -= 1;
      if (u.text.length > 600) s -= 0.5;
      if (user && repeats[i] > 1) s += Math.min(3, repeats[i] - 1);
      const sticky = f & (F.DECISION | F.PROHIBIT | F.GOAL);
      s *= sticky ? 0.9 + 0.2 * r : 0.55 + 0.9 * r;
    }
    if (rep[i] !== i) s *= 0.15; // older duplicate: the latest occurrence carries the weight
    score[i] = s;
  }

  progress?.(0.85);
  const a: Analysis = { units, flags, score, rep, repeats, versions };
  const ctx: BuildCtx = { sourceTokens, msgTokens, msgUnitStart, confirmedMsgs, lang, now, budgetTokens: opts.budgetTokens, selection: opts.selection ?? DEFAULT_SELECTION, layout: { ...DEFAULT_LAYOUT, ...opts.layout }, pastExtra: 0, recentScale: 1, squeeze: false };
  const budget0 = Math.max(1, ctx.budgetTokens ?? handoffBudget(sourceTokens));
  // A short conversation: the conversation itself, condensed to its key sentences.
  if (budget0 < ctx.layout.sectionsFrom) {
    timings.scoreMs = clock() - t0;
    progress?.(0.95);
    opts.onPhase?.('render');
    t0 = clock();
    const md = buildCondensed(conv, a, ctx, Math.floor(budget0 * BUDGET_TOLERANCE));
    timings.renderMs = clock() - t0;
    progress?.(1);
    return { markdown: md, lang, cache, timings, stats: condensedStats(md, sourceTokens, N, hits, misses) };
  }
  let doc = buildDocument(conv, a, ctx);
  timings.scoreMs = clock() - t0;

  // ---------- 4. render ----------
  progress?.(0.95);
  opts.onPhase?.('render');
  t0 = clock();
  let markdown = renderHandoff(doc);
  // Section estimates leave out formatting, so the first pass misses the budget a little either
  // way. Up to two more passes move the difference into (or out of) the earlier context, the one
  // part whose size is free; the result must stay within the budget (+2%).
  const B = doc.budget;
  const limit = Math.floor(B * BUDGET_TOLERANCE);
  let tokens = estimateTokens(markdown);
  let last = tokens;
  let extra = 0;
  let keptExtra = 0;
  for (let pass = 0; pass < 2; pass++) {
    const diff = B - last;
    if (diff >= -B * 0.02 && diff <= B * 0.04) break;
    if (diff > 0 && doc.pastExhausted) break;
    extra += Math.round(diff * (diff > 0 ? 0.92 : 1.05));
    const next = buildDocument(conv, a, { ...ctx, pastExtra: extra });
    const md2 = renderHandoff(next);
    last = estimateTokens(md2);
    // Over the limit: take the smaller one. Within it: take the fuller one.
    const better = last <= limit ? tokens > limit || last > tokens : tokens > limit && last < tokens;
    if (better) {
      doc = next;
      markdown = md2;
      tokens = last;
      keptExtra = extra;
    }
  }
  // Still over: the fixed sections alone exceed the budget (seen on a real 2-message chat whose
  // request was a 15k-token paste: there was no earlier context left to shrink). The verbatim
  // transcript is then clipped harder; its cut-out middle stays out, as for any clipped message.
  // If that is not enough, the optional sections go (squeeze) and the transcript shrinks again.
  const shrink = (base: BuildCtx) => {
    let scale = 1;
    for (let pass = 0; pass < 4 && tokens > limit; pass++) {
      const recentTok = doc.recent.reduce((s, r) => s + estimateTokens(r.body), 0);
      if (recentTok < 40) break;
      scale = Math.max(0.02, scale * (1 - (1.1 * (tokens - B)) / recentTok));
      const next = buildDocument(conv, a, { ...base, recentScale: scale });
      const md2 = renderHandoff(next);
      const t2 = estimateTokens(md2);
      if (t2 >= tokens) break;
      doc = next;
      markdown = md2;
      tokens = t2;
    }
  };
  shrink({ ...ctx, pastExtra: keptExtra });
  if (tokens > limit) {
    const squeezed = buildDocument(conv, a, { ...ctx, squeeze: true });
    const md2 = renderHandoff(squeezed);
    const t2 = estimateTokens(md2);
    if (t2 < tokens) {
      doc = squeezed;
      markdown = md2;
      tokens = t2;
    }
    shrink({ ...ctx, squeeze: true });
  }
  // Last resort (the sections do not fit at all): the condensed form, which always fits.
  if (tokens > limit) {
    const md = buildCondensed(conv, a, ctx, limit);
    timings.renderMs = clock() - t0;
    progress?.(1);
    return { markdown: md, lang, cache, timings, stats: condensedStats(md, sourceTokens, N, hits, misses) };
  }
  timings.renderMs = clock() - t0;
  progress?.(1);

  return {
    markdown,
    lang,
    cache,
    timings,
    stats: {
      sourceTokens,
      outputTokens: tokens,
      messages: N,
      decisions: doc.decisions.length,
      constraints: doc.constraints.length,
      openTasks: doc.open.length,
      cacheHits: hits,
      cacheMisses: misses,
      mode: 'compressed',
      uncertain: doc.uncertainCount,
      outputChars: markdown.length,
    },
  };
}

function condensedStats(md: string, sourceTokens: number, messages: number, cacheHits: number, cacheMisses: number): HandoffResult['stats'] {
  return { sourceTokens, outputTokens: estimateTokens(md), messages, decisions: 0, constraints: 0, openTasks: 0, cacheHits, cacheMisses, mode: 'condensed', uncertain: 0, outputChars: md.length };
}

/**
 * The condensed form (v1.3.8): every message keeps its key sentences verbatim, in order. The
 * heads of the latest message, the latest request and the first request come first; budgeted
 * concept coverage (the same selection as the sections' earlier context) fills the rest; then
 * the highest-scoring units that still fit. Attachment text competes like message text. The
 * result never exceeds `limit` tokens: units are dropped in reverse order of choice until it fits.
 */
function buildCondensed(conv: Conversation, a: Analysis, ctx: BuildCtx, limit: number): string {
  const { units, score, rep, flags } = a;
  const N = conv.messages.length;
  const all: Unit[] = [...units];
  const base = all.length;
  conv.messages.forEach((msg, m) => {
    for (const c of msg.contents) {
      if (c.type === 'attachment' && c.attachment?.extractedText?.trim()) segmentMarkdown(stripTracking(c.attachment.extractedText), m, msg.role, all);
      // Uploaded and generated images are named, never linked (their links need the user's login).
      const images = c.type === 'image' ? [{ url: c.imageUrl, alt: c.alt }] : c.type === 'image_group' ? (c.imageGroup?.images ?? []).map((x) => ({ url: x.imageUrl ?? x.thumbnailUrl, alt: x.alt })) : [];
      for (const img of images) if (img.url) all.push({ m, role: msg.role, kind: 'sentence', text: nameImages(`![${(img.alt ?? '').replace(/[[\]\n]/g, ' ')}](${img.url})`, ctx.lang), key: 0 });
    }
  });
  const byMsg: number[][] = Array.from({ length: N }, () => []);
  for (let i = 0; i < all.length; i++) byMsg[all[i].m].push(i);
  const topicCache = new Map<number, string[]>();
  const topics = (i: number) => {
    let t = topicCache.get(i);
    if (!t) topicCache.set(i, (t = topicTokens(all[i].kind === 'code' ? all[i].text.slice(0, 4000) : all[i].text)));
    return t;
  };
  const pieceOf = (i: number): CondensedPiece => {
    const u = all[i];
    const kind = u.kind;
    return { kind, text: kind === 'code' || kind === 'table' ? u.text : balanceBold(stripTracking(u.text)), lang: u.lang };
  };
  const pieceTokens = new Map<number, number>();
  const tok = (i: number) => {
    let t = pieceTokens.get(i);
    if (t == null) {
      const p = pieceOf(i);
      pieceTokens.set(i, (t = estimateTokens(p.text) + (p.kind === 'code' ? 6 : p.kind === 'sentence' ? 1 : 2)));
    }
    return t;
  };
  const headerTokens = (m: number) => estimateTokens(`### [#m${m + 1}] ${conv.messages[m].role === 'user' ? '사용자' : conv.siteName}`) + 3;
  // Older copies of repeated text and politeness carry nothing the latest copy does not.
  const eligible = (i: number) => i >= base || (rep[i] === i && !(flags[i] & F.POLITE && all[i].text.length < 40));
  // A heading alone says little: headings come only with the text after them (in a message head).
  const free = (i: number) => eligible(i) && all[i].kind !== 'heading';

  const emptyLast = N > 0 && conv.messages[N - 1].role === 'assistant' && byMsg[N - 1].length === 0;
  const selected = new Set<number>();
  const order: number[] = [];
  const mandatory = new Set<number>();
  const included = new Map<number, number>();
  const render = (frame: CondensedFrame) => {
    const msgs: CondensedMessage[] = [];
    for (let m = 0; m < N; m++) {
      if (!included.get(m)) continue;
      const pieces: Array<CondensedPiece | null> = [];
      let gap = false;
      for (const i of byMsg[m]) {
        if (selected.has(i)) {
          if (gap) pieces.push(null);
          gap = false;
          pieces.push(pieceOf(i));
        } else gap = true;
      }
      if (gap) pieces.push(null);
      msgs.push({ m, pieces });
    }
    // A last answer with nothing visible (still being written, or thinking only) is shown as such,
    // so the next AI starts from the request before it.
    if (emptyLast && !included.get(N - 1)) msgs.push({ m: N - 1, pieces: [] });
    return renderCondensedHandoff(conv, ctx.lang, msgs, { ...frame, sourceTokens: ctx.sourceTokens, now: ctx.now });
  };
  // The richest frame that leaves at least about half of the budget for the conversation.
  const frameAt = CONDENSED_FRAMES.findIndex((f) => estimateTokens(render(f)) <= limit * 0.45);
  const frames = CONDENSED_FRAMES.slice(frameAt < 0 ? CONDENSED_FRAMES.length - 1 : frameAt);
  let used = estimateTokens(render(frames[0]));
  const costOf = (i: number) => tok(i) + (included.get(all[i].m) ? 0 : headerTokens(all[i].m));
  const take = (i: number, must: boolean) => {
    used += costOf(i);
    selected.add(i);
    order.push(i);
    if (must) mandatory.add(i);
    included.set(all[i].m, (included.get(all[i].m) ?? 0) + 1);
  };
  const content = Math.max(0, limit - used);
  // Heads of the messages the next AI needs most: what fits of each, in order. The first unit may
  // take up to twice the share, so a short request slightly over it is not lost.
  const head = (ms: number[], share: number) => {
    let t = 0;
    for (const m of ms) {
      if (m < 0) continue;
      for (const i of byMsg[m]) {
        if (!eligible(i) || selected.has(i)) continue;
        const c = costOf(i);
        if (used + c > limit || t + c > (t === 0 ? share * 2 : share)) continue;
        take(i, true);
        t += c;
        if (t >= share * 0.9) return;
      }
    }
  };
  const lastUser = conv.messages.map((x) => x.role).lastIndexOf('user');
  const firstUser = conv.messages.findIndex((x) => x.role === 'user');
  head([N - 1], content * 0.3);
  if (lastUser !== N - 1) head([lastUser], content * 0.15);
  if (firstUser !== lastUser) head([firstUser], content * 0.1);
  // What the user wrote carries the most per token (requests, rules, decisions): newest first.
  const userMsgs: number[] = [];
  for (let m = N - 1; m >= 0; m--) if (conv.messages[m].role === 'user' && m !== lastUser && m !== firstUser) userMsgs.push(m);
  for (const m of userMsgs) head([m], content * 0.06);
  // Concept coverage over everything else.
  const weight = conceptWeight(units, (i) => topics(i), ctx.msgUnitStart, N);
  const covered = new Set<string>();
  for (const i of selected) for (const c of conceptsOf(topics(i))) covered.add(c);
  const items: CoverItem[] = [];
  for (let i = 0; i < all.length; i++) {
    if (selected.has(i) || !free(i)) continue;
    const u = all[i];
    items.push({ id: i, concepts: conceptsOf(topics(i)), cost: tok(i), prior: 0.75 + 0.5 * (u.m / Math.max(1, N - 1)) + (u.role === 'user' ? 0.5 : 0) });
  }
  greedyCoverage(items, weight, Math.max(0, limit - used), covered, { cost: (it) => costOf(it.id), onChoose: (it) => take(it.id, false) });
  // What is left of the budget goes to the strongest remaining units.
  const rest = items.map((it) => it.id).filter((i) => !selected.has(i)).sort((x, y) => (y < base ? score[y] : 0.2) - (x < base ? score[x] : 0.2) || y - x);
  for (const i of rest) if (used + costOf(i) <= limit) take(i, false);

  // The estimate above adds pieces one by one; drop the last chosen until the whole fits.
  const drop = (i: number) => {
    selected.delete(i);
    const n = (included.get(all[i].m) ?? 1) - 1;
    if (n) included.set(all[i].m, n);
    else included.delete(all[i].m);
  };
  for (const frame of frames) {
    let md = render(frame);
    let t = estimateTokens(md);
    while (t > limit && selected.size) {
      let removed = 0;
      // Optional units first (latest choice first), then the heads.
      const queue = [...order.filter((i) => selected.has(i) && !mandatory.has(i)), ...order.filter((i) => selected.has(i) && mandatory.has(i))];
      while (queue.length && removed < t - limit) {
        const i = queue.pop()!;
        removed += costOf(i);
        drop(i);
      }
      md = render(frame);
      t = estimateTokens(md);
    }
    if (t <= limit) {
      // Room left after dropping (an oversized unit went): the latest message gets a clipped head.
      if (!included.get(N - 1) && N > 0) {
        const room = limit - t - headerTokens(N - 1) - 4;
        const first = byMsg[N - 1].find((i) => free(i));
        if (first != null && room >= 12) {
          const clipped = clipHead(pieceOf(first).text, room, ctx.lang);
          if (clipped) {
            all[first] = { ...all[first], text: clipped, kind: all[first].kind === 'code' ? 'sentence' : all[first].kind };
            pieceTokens.delete(first);
            selected.add(first);
            included.set(N - 1, 1);
            const md2 = render(frame);
            if (estimateTokens(md2) <= limit) return md2;
            drop(first);
          }
        }
      }
      return md;
    }
  }
  return clipHead(`# ${conv.title || conv.siteName}\n`, Math.max(1, limit), ctx.lang);
}

interface BuildCtx {
  budgetTokens?: number;
  selection: 'relevance' | 'coverage';
  layout: Layout;
  /** Extra tokens for earlier context (second pass, when the first one left budget unused). */
  pastExtra: number;
  /** Shrinks the per-message transcript caps when the fixed sections alone exceed the budget. */
  recentScale: number;
  /** Leave out the optional sections (earlier context, code, files, links, lists) to fit a small budget. */
  squeeze: boolean;
  sourceTokens: number;
  msgTokens: Float64Array;
  msgUnitStart: Int32Array;
  confirmedMsgs: Set<number>;
  lang: 'ko' | 'en';
  now: number;
}

function isProse(u: Unit): boolean {
  return u.kind !== 'code' && u.kind !== 'attachment';
}

/** Units that read well as one bullet line: sentences, list items, quotes (not tables or headings). */
function isLine(u: Unit): boolean {
  return u.kind === 'sentence' || u.kind === 'item' || u.kind === 'quote';
}

/** Visible text the user typed or the answer showed (no sources, thinking or tool output). */
function messageText(msg: Conversation['messages'][number]): string {
  return msg.contents
    .filter((c) => c.type === 'text' || c.type === 'markdown')
    .map((c) => c.content ?? '')
    .join('\n')
    .trim();
}

/** Body of one message for the transcript sections: no source lists, headings demoted below ours. */
export function transcriptBody(msg: Conversation['messages'][number], lang: 'ko' | 'en'): string {
  const body = nameImages(messageBodyMarkdown({ ...msg, contents: msg.contents.filter((c) => c.type !== 'sources') }, { locale: lang }), lang);
  // Message headings ("# 결론", "## 1. …") would otherwise read as sections of the handoff itself.
  return replaceOutsideCode(body, (seg) =>
    stripTracking(seg.replace(/^( {0,3})(#{1,6})(?=\s)/gm, (_, sp: string, h: string) => `${sp}${'#'.repeat(Math.min(6, h.length + 3))}`)),
  );
}

const REQUEST_CHARS = 240;
/** Tokens of one transcript message header and the blank lines around it. */
const MSG_HEADER_TOKENS = 16;
const LEAD_CHARS = 220;

function clipLine(text: string, max: number): { text: string; clipped: boolean } {
  const t = text.replace(/\s*\n\s*/g, ' ').trim();
  const c = clipText(t, max);
  return { text: c, clipped: c !== t };
}

function buildDocument(conv: Conversation, a: Analysis, ctx: BuildCtx): HandoffDoc {
  const { units, flags, score, rep, repeats } = a;
  const N = conv.messages.length;
  const U = units.length;
  const used = new Set<number>();
  const usedKeys = new Set<number>();
  // A unit and its (near-)duplicates are shown once in the whole document.
  const usedClusters = new Set<number>();
  let uncertain = 0;
  const take = (i: number) => {
    used.add(i);
    usedKeys.add(units[i].key);
    usedClusters.add(rep[i]);
  };
  const isUsed = (i: number) => used.has(i) || usedKeys.has(units[i].key) || usedClusters.has(rep[i]);
  const item = (i: number, extra: Partial<Item> = {}): Item => ({ text: bulletText(units[i].text) || units[i].text, m: units[i].m, role: units[i].role, ...extra });
  const tokensOf = new Map<number, string[]>();
  const topics = (i: number) => {
    let t = tokensOf.get(i);
    if (!t) {
      t = topicTokens(units[i].text);
      tokensOf.set(i, t);
    }
    return t;
  };
  const unitsOf = (m: number) => Array.from({ length: ctx.msgUnitStart[m + 1] - ctx.msgUnitStart[m] }, (_, k) => ctx.msgUnitStart[m] + k);
  const all = Array.from({ length: U }, (_, i) => i);

  // Every conversation is condensed to its budget (v1.3.8: short ones used to be included whole,
  // which made the handoff larger than the full export).
  const capBudget = Math.max(1, ctx.budgetTokens ?? handoffBudget(ctx.sourceTokens));
  const squeeze = ctx.squeeze;
  // The fixed minimums below were set for budgets of 8k+; a short conversation's small budget
  // scales them down so the document still fits (k = 1 from 8k up, so long chats are unchanged).
  const k = Math.min(1, capBudget / MIN_BUDGET);
  const kMin = (n: number) => Math.max(1, Math.round(n * k));
  const cap = (per: number, min: number, max: number) => Math.round(Math.min(max, Math.max(kMin(min), capBudget / per)));
  const MAX_DONE = cap(600, 10, 40);
  const MAX_OPEN = cap(500, 12, 50);
  const MAX_FAIL = cap(1500, 6, 20);
  const MAX_REQ = cap(600, 10, 40);
  const MAX_REQUESTS = cap(400, 20, 60);
  const MAX_LINKS = squeeze ? 0 : cap(1000, 8, 40);
  const MAX_FILES = squeeze ? 0 : cap(ctx.layout.filesPer, 6, 40);
  const MAX_COMMANDS = squeeze ? 0 : cap(700, 8, 25);
  const MAX_NEXT = squeeze ? 2 : Math.max(2, Math.round(15 * k));
  /** The latest requests are kept even when the request list is over its share. */
  const LATEST_REQUESTS = kMin(12);
  const requestChars = Math.round(Math.max(80, Math.min(REQUEST_CHARS, capBudget * 0.03)));
  /** One long answer must not flood a section: at most this many items per assistant message. */
  const PER_MESSAGE = 4;
  // Token shares of the budget per section (compressed mode). Each section is filled by priority
  // until its share is used, so the whole document stays near the budget instead of growing with
  // every extra signal. Decisions and constraints are never cut by these shares.
  const share = (f: number) => (squeeze ? 0 : capBudget * f * ctx.layout.listScale);
  // Transcript caps per message shrink with the budget (the cut-out middle stays selectable).
  const scaledCap = (cap: number, s: number, floor: number) => (s > 0 ? Math.round(Math.min(cap, Math.max(floor, capBudget * s))) : cap);
  // The last two messages may take up to ~1/3 of the budget each (2,500 tokens from 8k up).
  const lastFloor = Math.round(400 * k);
  const recentFloor = Math.round(250 * k);
  const lastCap0 = Math.min(ctx.layout.lastMsgCap, Math.round(capBudget * ctx.layout.lastMsgMaxShare));
  const lastMsgCap = Math.max(lastFloor * ctx.recentScale, Math.round(scaledCap(lastCap0, ctx.layout.lastMsgShare, lastFloor) * ctx.recentScale));
  const recentMsgCap = Math.max(recentFloor * ctx.recentScale, Math.round(scaledCap(ctx.layout.recentMsgCap, ctx.layout.recentMsgShare, recentFloor) * ctx.recentScale));
  const lineTokens = (text: string, max = 220) => estimateTokens(text.length > max ? text.slice(0, max) : text) + 8;
  /** Keeps the highest-priority indices (given in priority order) within maxTok; returns them in document order. */
  const fit = (byPriority: number[], maxTok: number, max = 220) => {
    let usedTok = 0;
    const kept: number[] = [];
    for (const i of byPriority) {
      const t = lineTokens(units[i].text, max);
      if (usedTok + t > maxTok) continue;
      usedTok += t;
      kept.push(i);
    }
    return kept.sort((x, y) => x - y);
  };

  // Recent window (verbatim transcript) is decided first: the request flow adds the AI's lead
  // sentence only for turns that are not already in the transcript.
  let recentFrom = N;
  {
    const { recentShare, recentMin } = ctx.layout;
    const recentBudget = Math.max(recentMin * k, capBudget * recentShare) * ctx.recentScale;
    let usedTok = 0;
    for (let m = N - 1; m >= 0; m--) {
      // Each message also costs its header line ("### [#m12] 사용자 · 2026-10-21 14:44").
      const tok = ctx.msgTokens[m] + MSG_HEADER_TOKENS;
      const mustKeep = N - m <= 2;
      if (!mustKeep && usedTok + Math.min(tok, recentMsgCap) > recentBudget) break;
      usedTok += Math.min(tok, mustKeep ? lastMsgCap : recentMsgCap);
      recentFrom = m;
    }
  }

  // ---------- goal: first request ----------
  const goal: Item[] = [];
  const firstUser = conv.messages.findIndex((m) => m.role === 'user');
  if (firstUser >= 0) {
    const firstUnits = unitsOf(firstUser).filter((i) => isProse(units[i]));
    const firstText = firstUnits.map((i) => units[i].text).join(' ');
    const goalMax = Math.max(60, Math.min(350, capBudget * 0.12));
    const top = [...firstUnits].sort((x, y) => score[y] - score[x]).slice(0, 5);
    // A small budget keeps the strongest sentences of a long first request that fit its share.
    const fitted = k < 1 ? fit(top, goalMax, 600) : top.sort((x, y) => x - y);
    const picks = estimateTokens(firstText) <= goalMax ? firstUnits : fitted.length ? fitted : top.slice(0, 1);
    for (const i of picks) {
      goal.push(item(i));
      take(i);
    }
  }

  // ---------- request flow: every later user request, one line each ----------
  // User turns carry the most information per token in a conversation, so they are listed in
  // order. Long conversations keep the strongest requests plus the latest ones.
  // Near-identical requests ("조금 더 설명해 주세요 (66)", "(67)"…) collapse into their latest
  // occurrence with a count; the key is the duplicate cluster of the message's longest unit.
  const userMsgs: number[] = [];
  const similar = new Map<number, number>();
  {
    const latestByCluster = new Map<number, number>();
    const clusterOf = new Map<number, number>();
    for (let m = 0; m < N; m++) {
      if (conv.messages[m].role !== 'user' || m === firstUser || !messageText(conv.messages[m])) continue;
      const prose = unitsOf(m).filter((i) => isProse(units[i]));
      if (!prose.length) continue;
      const longest = prose.reduce((x, y) => (units[y].text.length > units[x].text.length ? y : x));
      const key = prose.length <= 2 ? rep[longest] : -1 - m;
      clusterOf.set(m, key);
      latestByCluster.set(key, m);
    }
    const countByCluster = new Map<number, number>();
    for (const key of clusterOf.values()) countByCluster.set(key, (countByCluster.get(key) ?? 0) + 1);
    for (const [m, key] of clusterOf) {
      if (latestByCluster.get(key) !== m) continue;
      userMsgs.push(m);
      const n = countByCluster.get(key) ?? 1;
      if (n > 1) similar.set(m, n);
    }
    userMsgs.sort((x, y) => x - y);
  }
  let keptReq = userMsgs;
  if (userMsgs.length > MAX_REQUESTS) {
    const latest = new Set(userMsgs.slice(-LATEST_REQUESTS));
    const msgScore0 = (m: number) => Math.max(0, ...unitsOf(m).map((i) => score[i]));
    const rest = userMsgs.filter((m) => !latest.has(m)).sort((x, y) => msgScore0(y) - msgScore0(x)).slice(0, MAX_REQUESTS - latest.size);
    const keep = new Set([...rest, ...latest]);
    keptReq = userMsgs.filter((m) => keep.has(m));
  }
  const msgScore = (m: number) => Math.max(0, ...unitsOf(m).map((i) => score[i]));
  let reqs0 = keptReq.map((m) => {
    const { text, clipped } = clipLine(bulletText(messageText(conv.messages[m])), requestChars);
    // The lead sentence of the answer gives the next AI the outcome of each turn in one line.
    let leadIdx = -1;
    const reply = m + 1 < N && conv.messages[m + 1].role === 'assistant' ? m + 1 : -1;
    if (reply >= 0 && reply < recentFrom && !squeeze) {
      const cand = unitsOf(reply).filter((i) => isLine(units[i]) && !(flags[i] & F.POLITE) && units[i].text.length >= 15);
      leadIdx = cand.slice(0, 8).find((i) => flags[i] & F.LEAD) ?? cand[0] ?? -1;
    }
    return { m, text, clipped, leadIdx, reply };
  });
  {
    const cost = (r: (typeof reqs0)[number]) => estimateTokens(r.text) + 8 + (r.leadIdx >= 0 ? lineTokens(units[r.leadIdx].text, LEAD_CHARS) : 0);
    const limit = share(0.15);
    let total = reqs0.reduce((a2, r) => a2 + cost(r), 0);
    // Over the share: drop answer summaries of the oldest turns first, then the weakest requests.
    for (const r of reqs0) {
      if (total <= limit) break;
      if (r.leadIdx >= 0) {
        total -= lineTokens(units[r.leadIdx].text, LEAD_CHARS);
        r.leadIdx = -1;
      }
    }
    if (total > limit) {
      const latest = new Set(reqs0.slice(-LATEST_REQUESTS).map((r) => r.m));
      const drop = new Set<number>();
      for (const r of [...reqs0].filter((x) => !latest.has(x.m)).sort((x, y) => msgScore(x.m) - msgScore(y.m))) {
        if (total <= limit) break;
        total -= cost(r);
        drop.add(r.m);
      }
      reqs0 = reqs0.filter((r) => !drop.has(r.m));
    }
  }
  const coveredMsgs = new Set<number>(firstUser >= 0 ? [firstUser] : []);
  const requests: RequestItem[] = reqs0.map((r) => {
    if (!r.clipped) coveredMsgs.add(r.m);
    const repeatsN = similar.get(r.m);
    if (r.leadIdx < 0) return { m: r.m, text: r.text, repeats: repeatsN };
    take(r.leadIdx);
    return { m: r.m, text: r.text, repeats: repeatsN, lead: { m: r.reply, text: clipLine(bulletText(units[r.leadIdx].text), LEAD_CHARS).text } };
  });
  const requestsOmitted = userMsgs.length - requests.length;
  const laterGoals = all
    .filter((i) => units[i].role === 'user' && !coveredMsgs.has(units[i].m) && flags[i] & F.GOAL && !(flags[i] & (F.PROHIBIT | F.CONSTRAINT)) && rep[i] === i && isLine(units[i]))
    .slice(-4);
  for (const i of laterGoals) if (!isUsed(i)) {
    goal.push(item(i));
    take(i);
  }

  // ---------- decisions ----------
  interface Dec {
    i: number;
    status: 'active' | 'superseded';
    by?: number;
    uncertainBy?: number;
    confirmed?: boolean;
  }
  const decs: Dec[] = [];
  for (let i = 0; i < U; i++) {
    const u = units[i];
    if (!isProse(u) || u.kind === 'table' || rep[i] !== i) continue;
    const f = flags[i];
    if (f & F.POLITE || f & F.QUESTION) continue;
    // A bare confirmation ("좋아요, 그걸로 하죠") is not itself a decision; the assistant
    // proposal it confirms is recorded instead.
    if (u.role === 'user' && f & F.CONFIRM && topics(i).length <= 1) continue;
    // "Redis는 쓰지 않기로 해요" decides something, but it is a rule to follow: it goes to constraints.
    if (f & F.PROHIBIT) continue;
    // A change request counts only when it replaces an earlier choice ("A 말고 B로", "instead of");
    // "버튼 문구 좀 바꿔 주세요" is an edit request, not a decision.
    const userDecision = u.role === 'user' && (f & F.DECISION || (f & F.CHANGE && f & F.DIRECTIVE && (REVERSAL_RE.test(u.text) || replacementPairs(u.text).length > 0)));
    const confirmedProposal = u.role === 'assistant' && ctx.confirmedMsgs.has(u.m) && f & (F.RECOMMEND | F.DECISION);
    if (userDecision || confirmedProposal) decs.push({ i, status: 'active', confirmed: !!confirmedProposal });
  }
  // Supersession: explicit "A instead of B" pairs are certain; otherwise a later change on the
  // same topic supersedes only with strong overlap, and weaker overlap is flagged as uncertain.
  const tokenIndex = new Map<string, number[]>();
  for (let d = 0; d < decs.length; d++) {
    const cur = decs[d];
    const ui = cur.i;
    const f = flags[ui];
    const ct = topics(ui);
    const pairs = replacementPairs(units[ui].text);
    const candidates = new Set<number>();
    for (const t of ct) for (const prev of tokenIndex.get(t) ?? []) candidates.add(prev);
    for (const p of pairs) for (const t of p.old) for (const prev of tokenIndex.get(t) ?? []) candidates.add(prev);
    for (const prevD of candidates) {
      const prev = decs[prevD];
      if (prev.status !== 'active') continue;
      const pt = topics(prev.i);
      const explicit = pairs.some((p) => p.old.some((t) => pt.includes(t)) && !p.neu.some((t) => pt.includes(t)));
      if (explicit) {
        prev.status = 'superseded';
        prev.by = ui;
        continue;
      }
      if (f & F.CHANGE && units[ui].role === 'user') {
        const sim = jaccard(pt, ct);
        if (sim >= 0.5) {
          prev.status = 'superseded';
          prev.by = ui;
        } else if (sim >= 0.25 && prev.uncertainBy == null) {
          prev.uncertainBy = ui;
        }
      }
    }
    for (const t of ct) {
      const list = tokenIndex.get(t);
      if (list) list.push(d);
      else tokenIndex.set(t, [d]);
    }
  }
  // Decisions and constraints share ruleShare of the budget: decisions may use half of it, and
  // constraints get the rest, so a long list of decisions never pushes prohibitions out.
  const MAX_DECISIONS = 60;
  const ruleBudget = capBudget * ctx.layout.ruleShare;
  const ruleCost = (i: number) => lineTokens(units[i].text, 600) + 6;
  let decLeft = ruleBudget / 2;
  const keptDecs: Dec[] = [];
  for (const d of decs.filter((x) => x.status === 'active').sort((x, y) => score[y.i] - score[x.i]).slice(0, MAX_DECISIONS)) {
    const c = ruleCost(d.i);
    if (c > decLeft) continue;
    decLeft -= c;
    keptDecs.push(d);
  }
  keptDecs.sort((x, y) => x.i - y.i);
  const keptSuperseded: Dec[] = [];
  for (const d of squeeze ? [] : decs.filter((x) => x.status === 'superseded').slice(-30).reverse()) {
    const c = ruleCost(d.i) + 10;
    if (c > decLeft) continue;
    decLeft -= c;
    keptSuperseded.unshift(d);
  }
  const decisions: Item[] = keptDecs.map((d) => {
    take(d.i);
    if (d.uncertainBy != null) uncertain++;
    return item(d.i, {
      uncertain: d.uncertainBy != null ? { m: units[d.uncertainBy].m, kind: 'maybe-changed' } : undefined,
      confirmed: d.confirmed ? units[d.i].m + 1 : undefined,
    });
  });
  const superseded: Item[] = keptSuperseded.map((d) => {
    take(d.i);
    return item(d.i, { supersededBy: units[d.by!].m });
  });

  // ---------- constraints ----------
  const cons: number[] = [];
  for (let i = 0; i < U; i++) {
    const u = units[i];
    if (u.role !== 'user' || !isProse(u) || u.kind === 'table' || rep[i] !== i || isUsed(i)) continue;
    const f = flags[i];
    if (f & F.QUESTION && !(f & F.PROHIBIT)) continue;
    if (f & F.PROHIBIT || (f & F.CONSTRAINT && (f & (F.EMPHASIS | F.DIRECTIVE)) !== 0) || (f & F.EMPHASIS && f & F.DIRECTIVE)) cons.push(i);
  }
  // Later permission on the same topic ("이제 React 써도 돼") marks a prohibition as uncertain.
  const permits = all.filter((i) => units[i].role === 'user' && flags[i] & F.PERMIT);
  // The same rule restated in different words ("절대 jQuery 쓰지 마" … "다시 말하지만 jQuery 금지")
  // is merged: the latest wording is shown with every place it was stated.
  const consGroups: number[][] = [];
  for (const i of cons) {
    const ti = topics(i);
    const g = consGroups.find((grp) => jaccard(topics(grp[grp.length - 1]), ti) >= 0.5 || (ti.length > 0 && grp.some((j) => sameRule(topics(j), ti))));
    if (g) g.push(i);
    else consGroups.push([i]);
  }
  const MAX_CONSTRAINTS = 60;
  const groupScore = (g: number[]) => Math.max(...g.map((i) => score[i])) + g.length;
  let consLeft = ruleBudget / 2 + decLeft;
  const keptGroups: number[][] = [];
  for (const g of [...consGroups].sort((x, y) => groupScore(y) - groupScore(x)).slice(0, MAX_CONSTRAINTS)) {
    const c = ruleCost(g[g.length - 1]) + 6 * (g.length - 1);
    if (c > consLeft) continue;
    consLeft -= c;
    keptGroups.push(g);
  }
  keptGroups.sort((x, y) => x[0] - y[0]);
  const constraints: Item[] = keptGroups.map((g) => {
    for (const i of g) take(i);
    const latest = g[g.length - 1];
    const later = permits.find((p) => p > latest && jaccard(topics(p), topics(latest)) >= 0.25);
    if (later != null) uncertain++;
    const msgsStated = new Set(g.map((i) => units[i].m));
    const reps = Math.max(msgsStated.size, repeats[latest]);
    return item(latest, {
      repeats: reps > 1 ? reps : undefined,
      alsoAt: [...msgsStated].filter((m) => m !== units[latest].m),
      uncertain: later != null ? { m: units[later].m, kind: 'maybe-lifted' } : undefined,
    });
  });
  // Other user instructions matter too, but those already quoted in full in the request flow are
  // not repeated: only directives from long (clipped) or omitted requests are listed here.
  const reqs = fit(
    all
      .filter((i) => units[i].role === 'user' && isLine(units[i]) && rep[i] === i && !isUsed(i) && !coveredMsgs.has(units[i].m) && flags[i] & F.DIRECTIVE && !(flags[i] & (F.QUESTION | F.ASK)))
      .sort((x, y) => score[y] - score[x])
      .slice(0, MAX_REQ),
    consLeft,
    600,
  );
  const requirements: Item[] = reqs.map((i) => {
    take(i);
    return item(i, { repeats: repeats[i] > 1 ? repeats[i] : undefined });
  });

  // ---------- tasks ----------
  let lastUser = -1;
  for (let m = N - 1; m >= 0; m--) if (conv.messages[m].role === 'user') {
    lastUser = m;
    break;
  }
  const lastAssistant = N - 1 >= 0 && conv.messages[N - 1].role === 'assistant' ? N - 1 : -1;
  const assistantMsgs: number[] = [];
  for (let m = 0; m < N; m++) if (conv.messages[m].role === 'assistant') assistantMsgs.push(m);
  const recentAssistant = new Set(assistantMsgs.slice(-2));
  const lastAssistantMsg = assistantMsgs[assistantMsgs.length - 1] ?? -1;
  // "~해야 합니다" in an answer is usually advice, not pending work: assistant text counts as open
  // only with explicit cues. Older answers count as completed work only with a strong verb
  // (descriptions of other projects — "테마 12개를 만들었습니다" — are not the user's progress).
  const ASSIST_TODO = /(남은|아직|추후|나중에|미완료|미구현|진행\s?중|할\s?일|예정|\bTODO\b|remaining|pending|not yet|still need|follow[- ]?up|later)/i;
  const STRONG_DONE = /(완료|구현(했|함|하였|되었)|수정(했|함|하였|되었)|해결(했|됨|함|되었)|반영(했|함|하였|되었)|적용(했|함|하였|되었)|배포(했|함|하였)|고쳤|통과(했|함|하였)|\b(fixed|implemented|completed|deployed|resolved|merged|passed|shipped)\b|✅)/i;
  const isLabel = (i: number) => units[i].text.length <= 60 && /[:：]\s*$/.test(units[i].text);
  // Assistant text mentions "bug"/"error" or "should check…" in general explanations all the
  // time; only keep it when it is concrete (code, identifiers, a stated cause) or recent.
  const concrete = (i: number) => /`[^`]+`|\w+(Error|Exception)\b|[A-Za-z_]+\(|\d{3}\b/.test(units[i].text) || (flags[i] & F.CAUSE) !== 0;
  const perMessage = (list: number[], limit: number) => {
    const count = new Map<number, number>();
    return [...list]
      .sort((x, y) => score[y] - score[x])
      .filter((i) => {
        if (units[i].role === 'user') return true;
        const n = count.get(units[i].m) ?? 0;
        count.set(units[i].m, n + 1);
        return n < limit;
      })
      .sort((x, y) => x - y);
  };

  // Next steps first: "남은 핵심은 …" in the latest answers belongs here rather than in open issues.
  const next: Item[] = [];
  const nextFrom = Math.max(0, N - 6);
  for (let i = ctx.msgUnitStart[nextFrom]; i < U; i++) {
    const u = units[i];
    if (!isLine(u) || u.role !== 'assistant' || isUsed(i) || isLabel(i)) continue;
    const f = flags[i];
    if ((u.underNext && u.kind === 'item') || (f & F.NEXT && !(f & F.QUESTION)) || (u.kind === 'item' && u.checked === false)) {
      if (!next.some((n) => n.text === bulletText(u.text))) next.push(item(i));
    }
  }
  const nextTrim = next.slice(-MAX_NEXT);
  for (const it of nextTrim) {
    const i = ctx.msgUnitStart[it.m] + unitsOf(it.m).findIndex((k) => bulletText(units[k].text) === it.text);
    if (i >= 0) take(i);
  }

  const doneIdx = perMessage(
    all.filter((i) => {
      const f = flags[i];
      if (!(isLine(units[i]) && rep[i] === i && !isUsed(i) && f & F.DONE && !(f & F.NOT_DONE) && !(f & F.QUESTION) && !(f & F.POLITE) && units[i].checked !== false)) return false;
      return units[i].role === 'user' || units[i].m === lastAssistantMsg || STRONG_DONE.test(units[i].text) || units[i].checked === true;
    }),
    PER_MESSAGE,
  );
  const openIdx = perMessage(
    all.filter((i) => {
      const u = units[i];
      const f = flags[i];
      if (!isLine(u) || rep[i] !== i || isUsed(i) || f & F.POLITE || isLabel(i)) return false;
      if (u.checked === false) return true;
      if (u.checked === true) return false;
      const pendingish = (f & (F.TODO | F.NOT_DONE | F.PENDING)) !== 0 && !(f & F.DONE && !(f & (F.NOT_DONE | F.PENDING)));
      if (!pendingish) return false;
      if (u.role === 'user') return !(f & F.QUESTION);
      if (f & F.LEAD) return false; // a conclusion belongs to "current state"
      if (!(f & (F.NOT_DONE | F.PENDING)) && !ASSIST_TODO.test(u.text)) return false;
      return recentAssistant.has(u.m) || !!u.underNext || (f & F.PENDING) !== 0 || concrete(i);
    }),
    PER_MESSAGE,
  );
  const failMsgs = new Set<number>();
  for (let i = 0; i < U; i++) if (flags[i] & F.FAILURE && isLine(units[i]) && units[i].role === 'user') failMsgs.add(units[i].m);
  const failIdx = all.filter((i) => {
    if (rep[i] !== i) return false;
    const u = units[i];
    if (u.kind === 'code') return (flags[i] & F.FAILURE) !== 0;
    if (!isLine(u)) return false;
    const f = flags[i];
    if (u.role === 'user') return (f & F.FAILURE) !== 0 || ((f & F.CAUSE) !== 0 && failMsgs.has(u.m));
    return (f & F.FAILURE) !== 0 && (concrete(i) || failMsgs.has(u.m - 1));
  });
  const resolvedBy = (i: number): number | undefined => {
    const tt = topics(i);
    if (!tt.length) return undefined;
    for (const d of doneIdx) if (d > i && jaccard(topics(d), tt) >= 0.34) return d;
    return undefined;
  };
  const done: Item[] = fit([...doneIdx].sort((x, y) => score[y] - score[x]).slice(0, MAX_DONE), share(0.08))
    .map((i) => {
      take(i);
      return item(i);
    });
  const open: Item[] = [];
  for (const i of fit([...openIdx].sort((x, y) => score[y] - score[x] || y - x), share(0.1))) {
    if (isUsed(i)) continue;
    const r = resolvedBy(i);
    if (r != null && jaccard(topics(r), topics(i)) >= 0.5) continue; // clearly completed later
    take(i);
    if (r != null) uncertain++;
    open.push(item(i, { uncertain: r != null ? { m: units[r].m, kind: 'maybe-done' } : undefined }));
  }
  const openTrim = open.length > MAX_OPEN ? open.slice(-MAX_OPEN) : open;
  const failures: Item[] = fit(
    perMessage(
      failIdx.filter((i) => !isUsed(i) && (units[i].kind !== 'code' || units[i].m >= N * 0.5)),
      PER_MESSAGE,
    )
      .sort((x, y) => score[y] - score[x])
      .slice(0, MAX_FAIL),
    share(0.05),
    600,
  ).map((i) => {
      take(i);
      const r = resolvedBy(i);
      const text = units[i].kind === 'code' ? units[i].text.split('\n').filter((l) => l.trim()).slice(-12).join('\n') : bulletText(units[i].text);
      return { text, m: units[i].m, role: units[i].role, code: units[i].kind === 'code', resolved: r != null ? units[r].m : undefined };
    });

  // ---------- current state: key sentences of the last answer not shown elsewhere ----------
  const lastAssistantKey: Item[] = [];
  if (lastAssistant >= 0) {
    const idx = unitsOf(lastAssistant).filter((i) => isLine(units[i]) && !(flags[i] & F.POLITE) && !isUsed(i) && !isLabel(i));
    const weight = (i: number) => score[i] + (flags[i] & F.LEAD ? 2 : 0) + (/\*\*[^*]+\*\*/.test(units[i].text) ? 0.6 : 0);
    // The last answer is in the transcript below; unless it is clipped there, two key sentences
    // are enough here (more would only repeat it).
    const shownWhole = ctx.msgTokens[lastAssistant] <= lastMsgCap;
    const picked = [...idx].sort((x, y) => weight(y) - weight(x)).slice(0, shownWhole || squeeze ? 2 : kMin(6)).sort((x, y) => x - y);
    for (const i of picked) {
      take(i);
      lastAssistantKey.push(item(i));
    }
  }

  // ---------- files, commands, links ----------
  const pathCount = new Map<string, { n: number; m: number }>();
  const cmdSet = new Map<string, number>();
  interface LinkAgg {
    url: string;
    title?: string;
    w: number;
    m: number;
    msgs: Set<number>;
  }
  const linkMap = new Map<string, LinkAgg>();
  const addLink = (url: string, title: string | undefined, m: number, weight: number) => {
    const key = urlKey(url);
    let e = linkMap.get(key);
    if (!e) {
      e = { url: cleanUrl(url), title, w: 0, m, msgs: new Set() };
      linkMap.set(key, e);
    }
    // A descriptive title beats a bare host name ("shop.example" from a citation chip).
    const weak = (t?: string) => !t || t === hostLabel(url) || /^[\w.-]+\.[a-z]{2,}$/i.test(t);
    if (title && weak(e.title) && !weak(title)) e.title = title;
    else if (!e.title && title) e.title = title;
    e.m = Math.max(e.m, m);
    if (!e.msgs.has(m)) {
      e.msgs.add(m);
      e.w += weight;
    }
  };
  for (let i = 0; i < U; i++) {
    const u = units[i];
    const text = u.kind === 'code' ? u.text.slice(0, 20_000) : u.text;
    if (u.kind !== 'code' || (u.lang && /^(sh|bash|zsh|shell|console|powershell|ps1|cmd|terminal)$/i.test(u.lang))) {
      for (const c of extractCommands(text)) cmdSet.set(c, u.m);
    }
    // Fetched web pages and search results mention other people's paths, not the user's files.
    const webTool = u.kind === 'code' && /^tool:.*(?:web|fetch|search|brows)/i.test(u.title ?? '');
    if (!webTool) for (const p of extractPaths(u.kind === 'code' ? text.slice(0, 2000) : text)) {
      const e = pathCount.get(p);
      pathCount.set(p, { n: (e?.n ?? 0) + 1, m: u.m });
    }
    // Links the user gave are the most reliable references; links in answers count once per message.
    if (u.kind !== 'code') for (const l of extractLinks(text)) addLink(l.url, l.title, u.m, u.role === 'user' ? 3 : 1);
    if (u.title && /[\w-]+\.[a-z0-9]{1,6}$/i.test(u.title)) {
      const e = pathCount.get(u.title);
      pathCount.set(u.title, { n: (e?.n ?? 0) + 1, m: u.m });
    }
  }
  // Cited sources (not the uncited search results) — documents list the same ones.
  conv.messages.forEach((msg, m) => {
    for (const c of msg.contents) if (c.type === 'sources') for (const s of c.sources ?? []) addLink(s.url, s.title, m, 1);
  });
  const files = [...pathCount.entries()]
    .sort((x, y) => y[1].n - x[1].n || y[1].m - x[1].m)
    .slice(0, MAX_FILES)
    .map(([path, v]) => ({ text: path, m: v.m, count: v.n }));
  const commands = [...cmdSet.entries()].slice(-MAX_COMMANDS).map(([cmd, m]) => ({ text: cmd, m }));
  const rankedLinks = [...linkMap.values()].sort((x, y) => y.w + y.m / Math.max(1, N) - (x.w + x.m / Math.max(1, N)));
  const links = rankedLinks.slice(0, MAX_LINKS).map((l) => ({ text: l.url, m: l.m, title: l.title, count: l.msgs.size }));
  const linksOmitted = Math.max(0, rankedLinks.length - links.length);

  // ---------- budgeted sections ----------
  const budget = capBudget;

  // Recent raw messages (verbatim).
  const recent: RecentMessage[] = [];
  const recentClipped = new Set<number>();
  const hiddenInRecent = new Set<number>();
  for (let m = recentFrom; m < N; m++) {
    const msg = conv.messages[m];
    let body = transcriptBody(msg, ctx.lang);
    const limit = N - m <= 2 ? lastMsgCap : recentMsgCap;
    let clipped = false;
    if (estimateTokens(body) > limit) {
      body = clipMarkdown(body, limit, ctx.lang);
      clipped = true;
    }
    recent.push({ m, role: msg.role, time: msg.created_at, body, clipped });
    if (clipped) {
      recentClipped.add(m);
      if (!ctx.layout.clippedExcerpts) continue;
      // Units cut out of a clipped message compete for the context budget like earlier units, so
      // the middle of a very long message is not simply lost.
      // Units appear in order, so each one is searched after the previous match: a sentence
      // repeated in the visible head does not make its copy in the cut-out middle "visible".
      let cursor = 0;
      for (const i of unitsOf(m)) {
        const probe = units[i].text.split('\n')[0].slice(0, 60).trim();
        const at = probe ? body.indexOf(probe, cursor) : -1;
        if (at < 0) hiddenInRecent.add(i);
        else cursor = at + probe.length;
      }
    }
  }
  // A revised draft repeats most of the earlier one: show each line once, in its latest form.
  if (ctx.layout.collapseRepeats) collapseRepeats(recent, ctx.lang);

  // ---------- attachments: files and pasted text ----------
  // A request like "아래 글 어떻게 생각해?" is about its attachment, which used to be left out
  // whenever the message was older than the transcript. Text the record has is shown verbatim
  // (the first and the latest request's attachments first, then newest first); files without text
  // (PDFs, images) are listed so the next AI can ask for them.
  const attachments: AttachmentItem[] = [];
  let attachmentsMore = 0;
  if (ctx.layout.attachShare > 0 && !squeeze) {
    const found: AttachmentItem[] = [];
    conv.messages.forEach((msg, m) => {
      for (const c of msg.contents) {
        if (c.type === 'attachment' && c.attachment) {
          const text = c.attachment.extractedText?.trim();
          found.push({ m, role: msg.role, name: c.attachment.name?.trim() ?? '', mime: c.attachment.mime_type, tokens: text ? estimateTokens(text) : 0, text: text || undefined });
        } else if (c.type === 'image' && msg.role === 'user' && c.alt?.trim()) {
          // Uploaded images are listed by name; unnamed ones (ChatGPT) already read "이미지" in the
          // request and the transcript, so a nameless entry would add nothing.
          found.push({ m, role: msg.role, name: c.alt.trim(), image: true, tokens: 0 });
        }
      }
    });
    const lastUserMsg = conv.messages.map((x) => x.role).lastIndexOf('user');
    const rank = (a: AttachmentItem) => (a.m === firstUser ? 0 : a.m === lastUserMsg ? 1 : 2);
    const order = [...found].sort((x, y) => rank(x) - rank(y) || y.m - x.m);
    let left = Math.max(400 * k, capBudget * ctx.layout.attachShare);
    for (const a of order) {
      const text = a.text;
      a.text = undefined;
      if (!text) continue;
      if (a.m >= recentFrom) {
        a.inTranscript = true;
        continue;
      }
      const body = stripTracking(text);
      if (a.tokens + 30 <= left) {
        a.text = body;
      } else if (left >= Math.max(60, 300 * k)) {
        a.text = clipMarkdown(body, left - 30, ctx.lang);
        a.clipped = true;
      } else {
        a.omitted = true;
        continue;
      }
      const tok = estimateTokens(a.text) + 30;
      left -= tok;
    }
    const MAX_ATTACH = 30;
    // Listed in conversation order; beyond the cap, the ones with text shown here are kept.
    const listed = found.length <= MAX_ATTACH ? found : [...found].sort((x, y) => Number(!!y.text) - Number(!!x.text) || y.m - x.m).slice(0, MAX_ATTACH);
    attachmentsMore = found.length - listed.length;
    attachments.push(...[...listed].sort((x, y) => x.m - y.m));
  }


  // Code: latest version of each code cluster, highest scoring first, within ~30% of budget.
  const code: CodeItem[] = [];
  const codeInRecent = new Set<number>();
  if (!squeeze) {
    const codeBudget = Math.max(ctx.layout.codeMin * k, budget * ctx.layout.codeShare);
    // A shell block whose every line is already in the command list adds nothing.
    const listed = new Set(commands.map((c) => c.text));
    const onlyListed = (u: Unit) =>
      !!u.lang && /^(sh|bash|zsh|shell|console|terminal)$/i.test(u.lang) && u.text.split('\n').map((l) => l.replace(/^\s*[$>]\s+/, '').trim()).filter(Boolean).every((l) => listed.has(l));
    const codeIdx = all.filter((i) => units[i].kind === 'code' && rep[i] === i && !(units[i].title ?? '').startsWith('tool:') && !onlyListed(units[i]));
    let usedTok = 0;
    for (const i of [...codeIdx].sort((x, y) => score[y] - score[x])) {
      const u = units[i];
      // The latest version already appears verbatim in the recent transcript: point to it instead.
      if (u.m >= recentFrom && !recentClipped.has(u.m)) {
        codeInRecent.add(u.m);
        continue;
      }
      const lines = u.text.split('\n');
      const truncated = lines.length > 220;
      const note = ctx.lang === 'ko' ? `… (${lines.length - 200}줄 생략 — 전체는 [#m${u.m + 1}])` : `… (${lines.length - 200} lines omitted — see [#m${u.m + 1}])`;
      const body = truncated ? [...lines.slice(0, 170), note, ...lines.slice(-30)].join('\n') : u.text;
      const tok = estimateTokens(body);
      if (usedTok + tok > codeBudget) continue;
      usedTok += tok;
      code.push({ text: body, m: u.m, role: u.role, lang: u.lang, title: u.title, versions: a.versions[i], truncated });
    }
    code.sort((x, y) => x.m - y.m);
  }

  const makeDoc = (pastItems: PastItem[]): HandoffDoc => ({
    lang: ctx.lang,
    refIndex: ctx.layout.refIndex,
    conv,
    now: ctx.now,
    sourceTokens: ctx.sourceTokens,
    budget,
    quoteChars: Math.round(Math.max(60, Math.min(400, budget * 0.05))),
    lineChars: Math.round(Math.max(120, Math.min(600, budget * 0.08))),
    goal,
    requests,
    requestsOmitted,
    decisions,
    superseded,
    constraints,
    requirements,
    done,
    open: openTrim,
    next: nextTrim,
    failures,
    lastUser,
    lastAssistant,
    lastAssistantKey,
    lastAssistantEmpty: lastAssistant >= 0 && !conv.messages[lastAssistant].contents.some((c) => c.type !== 'thinking' && c.type !== 'sources' && c.type !== 'tool' && (c.content?.trim() || c.imageUrl || c.imageGroup?.images.length || c.attachment)),
    files,
    commands,
    links,
    linksOmitted,
    code,
    codeInRecent: [...codeInRecent].sort((x, y) => x - y),
    past: pastItems,
    recent,
    attachments,
    attachmentsMore,
    uncertainCount: uncertain,
  });

  // Important past context: remaining budget filled with the best unused units before the recent
  // window. Selection is relevance-ranked and redundancy-aware (MMR-style): a candidate whose topic
  // words are already covered by what was selected adds little and is skipped.
  const past: PastItem[] = [];
  let pastExhausted = false;
  if (!squeeze) {
    // Everything but the excerpts is decided: render it to know what is left (rendering takes a
    // few ms). Section estimates missed the markup — "- … [#m12]" on every line, headers, link and
    // file lists — and the first pass overshot by ~10% once tokens were counted at their real cost
    // (v1.3.8); the render passes in runHandoff then rebuilt the document twice.
    const base = estimateTokens(renderHandoff(makeDoc([])));
    let remaining = budget - base - 12 - (ctx.layout.refIndex ? 800 : 0) + ctx.pastExtra;
    const pastItem = (k: number): PastItem => ({ text: units[k].kind === 'table' ? units[k].text : bulletText(units[k].text), m: units[k].m, u: k, role: units[k].role, table: units[k].kind === 'table' });
    // Referential completeness: an excerpt that opens with "이 방식은…", "그래서…" or "This…" is
    // hard to read without the sentence before it ("referential dangling"; in the compression lab
    // about half of such excerpts had lost it). Such a unit is selected together with its
    // antecedent (up to two steps back in the same message) as one item with their joint cost.
    const chainOf = (i: number): number[] => {
      const chain = [i];
      if (!ctx.layout.repair) return chain;
      let j = i;
      for (let step = 0; step < 2 && ANAPHOR_RE.test(units[j].text); step++) {
        const prev = j - 1;
        const p = units[prev];
        if (!p || p.m !== units[j].m || !isProse(p) || p.kind === 'heading') break;
        // Already in the document as this exact sentence, or visible in the transcript.
        if (used.has(prev) || usedKeys.has(p.key) || (p.m >= recentFrom && !hiddenInRecent.has(prev))) break;
        chain.unshift(prev);
        j = prev;
      }
      return chain;
    };
    // What an excerpt costs as rendered: its line (clipped like the renderer clips it), and the
    // "- **ChatGPT** [#m12]" line of its message the first time that message gets an excerpt.
    const pastChars = Math.round(makeDoc([]).lineChars * 1.34);
    const lineCost = new Map<number, number>();
    const costOf = (k: number) => {
      let c = lineCost.get(k);
      if (c == null) {
        const u = units[k];
        c = u.kind === 'table' ? estimateTokens(u.text.replace(/^/gm, '  ')) + 4 : estimateTokens(`  - ${clipText(bulletText(u.text).replace(/\s*\n\s*/g, ' ').trim(), pastChars)}`) + 2;
        lineCost.set(k, c);
      }
      return c;
    };
    const pastMsgs = new Set<number>();
    const groupCost = (m: number) => estimateTokens(`- **${conv.messages[m].role === 'user' ? '사용자' : conv.siteName}** [#m${m + 1}]`) + 2;
    const chainCost = (ch: number[]) => {
      let c = 0;
      const msgs = new Set<number>();
      for (const k of ch) {
        if (used.has(k)) continue;
        c += costOf(k);
        if (!pastMsgs.has(units[k].m)) msgs.add(units[k].m);
      }
      for (const m of msgs) c += groupCost(m);
      return c;
    };
    const takeChain = (ch: number[]) => {
      remaining -= chainCost(ch);
      for (const k of ch) {
        if (used.has(k)) continue;
        take(k);
        pastMsgs.add(units[k].m);
        past.push(pastItem(k));
      }
    };
    // "Current focus" = what the latest requests, open tasks, next steps and decisions talk about.
    // Older text that shares those topics is relevant past context even without strong signals.
    const focus = new Set<string>();
    const addFocus = (text: string) => topicTokens(text).forEach((t) => focus.add(t));
    for (let m = Math.max(0, N - 6); m < N; m++) if (conv.messages[m].role === 'user') {
      for (const i of unitsOf(m)) addFocus(units[i].text);
    }
    for (const it of [...openTrim, ...nextTrim, ...decisions, ...goal]) addFocus(it.text);
    const rel = new Map<number, number>();
    const cand: number[] = [];
    for (let i = 0; i < U; i++) {
      const u = units[i];
      if ((u.m >= recentFrom && !hiddenInRecent.has(i)) || !isProse(u) || u.kind === 'heading' || rep[i] !== i || isUsed(i) || flags[i] & F.POLITE || u.text.length < 12) continue;
      let r = 0;
      if (focus.size) {
        const tt = topics(i);
        let hit = 0;
        for (const t of tt) if (focus.has(t)) hit++;
        r = Math.min(2.5, (hit / Math.sqrt(tt.length + 1)) * 1.5);
      }
      // Coverage weighs concepts itself, so it considers every eligible unit.
      if (ctx.selection === 'coverage' || score[i] + r > 0.9) {
        rel.set(i, Math.max(0, score[i] + r));
        cand.push(i);
      }
    }
    if (ctx.selection === 'coverage') {
      // Document-level coverage: concepts the handoff already shows (decisions, requests, recent
      // transcript…) count as covered, so earlier context adds what is still missing.
      const weight = conceptWeight(units, topics, ctx.msgUnitStart, N);
      const covered = new Set<string>();
      for (const i of used) for (const c of conceptsOf(topics(i))) covered.add(c);
      for (let m = recentFrom; m < N; m++) for (const i of unitsOf(m)) if (isProse(units[i]) && !hiddenInRecent.has(i)) for (const c of conceptsOf(topics(i))) covered.add(c);
      const maxRel = Math.max(1, ...cand.map((i) => rel.get(i)!));
      const chains = new Map(cand.map((i) => [i, chainOf(i)]));
      const items: CoverItem[] = cand.map((i) => {
        const ch = chains.get(i)!;
        return {
          id: i,
          concepts: ch.length === 1 ? conceptsOf(topics(i)) : [...new Set(ch.flatMap((k) => conceptsOf(topics(k))))],
          cost: chainCost(ch),
          prior: 1 - ctx.layout.relPrior + ctx.layout.relPrior * (rel.get(i)! / maxRel),
        };
      });
      // Costs are re-read on every pick: once a chain's antecedent is in, the chain costs less.
      greedyCoverage(items, weight, Math.max(0, remaining), covered, { cost: (it) => chainCost(chains.get(it.id)!), onChoose: (it) => takeChain(chains.get(it.id)!) });
      // Once every concept is covered, the rest of the budget goes to the most relevant units left.
      let w = 0;
      for (const i of cand) if (!isUsed(i)) cand[w++] = i;
      cand.length = w;
    }
    cand.sort((x, y) => rel.get(y)! - rel.get(x)!);
    const covered = new Map<string, number>();
    for (const i of cand) {
      if (remaining <= 0) break;
      const tt = topics(i);
      if (tt.length >= 4) {
        let seen = 0;
        for (const t of tt) if ((covered.get(t) ?? 0) >= 2) seen++;
        if (seen / tt.length > 0.7) continue;
      }
      const ch = chainOf(i);
      if (chainCost(ch) > remaining) continue;
      takeChain(ch);
      for (const t of tt) covered.set(t, (covered.get(t) ?? 0) + 1);
    }
    past.sort((x, y) => x.u - y.u);
    // Nothing left that fits a larger budget: the render passes need not try one.
    pastExhausted = remaining > 0 && cand.every((i) => isUsed(i) || chainCost(chainOf(i)) > remaining + 64);
  }

  return { ...makeDoc(past), pastExhausted };
}

/** Concept weight for coverage: IDF over messages × log frequency, ×1.5 for words the user used. */
function conceptWeight(units: Unit[], topics: (i: number) => string[], msgUnitStart: Int32Array, N: number): (c: string) => number {
  const df = new Map<string, number>();
  const tfAll = new Map<string, number>();
  const byUser = new Set<string>();
  for (let m = 0; m < N; m++) {
    const seen = new Set<string>();
    for (let i = msgUnitStart[m]; i < msgUnitStart[m + 1]; i++) {
      if (!isProse(units[i])) continue;
      for (const t of topics(i)) {
        seen.add(t);
        tfAll.set(t, (tfAll.get(t) ?? 0) + 1);
        if (units[i].role === 'user') byUser.add(t);
      }
    }
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const idf = (t: string) => Math.log((N + 1) / ((df.get(t) ?? 0) + 1)) + 1;
  return (c: string) => {
    const parts = c.split(' ');
    const base = parts.length === 1 ? idf(c) : 0.5 * (idf(parts[0]) + idf(parts[1]));
    return base * (1 + Math.log(tfAll.get(parts[0]) ?? 1)) * (byUser.has(parts[0]) ? 1.5 : 1);
  };
}

/** Two prohibitions about the same distinctive term (e.g. both mention "jquery"). */
function sameRule(a: string[], b: string[]): boolean {
  const distinctive = (t: string) => /[a-z0-9]/.test(t) && t.length >= 3;
  return a.some((t) => distinctive(t) && b.includes(t));
}

/** Normalized text of a transcript line for "same line" checks (markup and spacing ignored). */
function lineKey(line: string): string {
  return line
    .replace(/^\s*(?:[-*+>]|\d+[.)]|#{1,6})\s+/, '')
    .replace(/[*_`~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const REPEAT_MIN = 24;
/** Above this many near-match comparisons only exact repeats are collapsed (very long transcripts). */
const REPEAT_COMPARISONS = 2_000_000;

/** The note that replaces a run of lines repeated in a later transcript message. */
export function repeatNote(n: number, ms: number[], lang: 'ko' | 'en'): string {
  const refs = [...new Set(ms)].sort((a, b) => a - b).map((m) => `[#m${m + 1}]`).join(', ');
  return lang === 'ko'
    ? `_(… ${n}줄 생략 — 같거나 거의 같은 내용이 아래 ${refs}에 있습니다)_`
    : `_(… ${n} ${n === 1 ? 'line' : 'lines'} omitted — the same or nearly the same text is in ${refs} below)_`;
}

/**
 * Lines a later transcript message repeats (a revised draft: "rewrite it" → the whole draft again
 * with a few edits) are shown once, in the latest message. In the earlier message each run of
 * such lines becomes one note pointing to the later one; lines that changed stay. Fenced code is
 * compared as one block. A line counts as repeated when it is the same after normalization, or
 * nearly the same (≥ 85% of its words shared with a later line of similar length). Short lines
 * (headings, labels, "가격: 3만원") are never matched loosely: inside a run they are dropped only
 * when a later message has the same line, otherwise they end the run and stay. Table rows are
 * never dropped (a table without its header row is no table), and a run stays as it was when the
 * note would be longer than the lines it replaces (v1.3.8).
 */
export function collapseRepeats(recent: Array<{ m: number; role: string; body: string }>, lang: 'ko' | 'en'): void {
  // A user's line only collapses into a later user message (their own revised paste), so what the
  // user said is never shown only as the AI's words. An AI line may point to either.
  interface Index {
    exact: Map<string, number>;
    short: Set<string>;
    words: Array<{ words: Set<string>; len: number; m: number }>;
  }
  const all: Index = { exact: new Map(), short: new Set(), words: [] };
  const users: Index = { exact: new Map(), short: new Set(), words: [] };
  let comparisons = 0;
  const wordsOf = (key: string) => new Set(key.split(' ').filter((w) => w.length > 1));
  const match = (ix: Index, key: string): number | undefined => {
    const exact = ix.exact.get(key);
    if (exact != null) return exact;
    const w = wordsOf(key);
    if (w.size < 5 || comparisons > REPEAT_COMPARISONS) return undefined;
    for (const c of ix.words) {
      if (c.len < key.length * 0.75 || c.len > key.length * 1.33) continue;
      comparisons++;
      let inter = 0;
      for (const x of w) if (c.words.has(x)) inter++;
      if (inter / (w.size + c.words.size - inter) >= 0.85) return c.m;
    }
    return undefined;
  };
  for (let k = recent.length - 1; k >= 0; k--) {
    const r = recent[k];
    const ix = r.role === 'user' ? users : all;
    // Blocks: single lines, or a whole fenced code block.
    const blocks: string[] = [];
    let fence: string[] | null = null;
    for (const line of r.body.split('\n')) {
      if (/^\s{0,3}(`{3,}|~{3,})/.test(line)) {
        if (fence) {
          fence.push(line);
          blocks.push(fence.join('\n'));
          fence = null;
        } else fence = [line];
      } else if (fence) fence.push(line);
      else blocks.push(line);
    }
    if (fence) blocks.push(fence.join('\n'));
    const out: string[] = [];
    const own: string[] = [];
    const short: string[] = [];
    let run = 0;
    let runM: number[] = [];
    let runLines: string[] = [];
    let pending: string[] = [];
    let collapsed = false;
    const flush = () => {
      if (run) {
        const note = repeatNote(run, runM, lang);
        if (estimateTokens(note) < estimateTokens(runLines.join('\n'))) {
          out.push(note);
          collapsed = true;
        } else out.push(...runLines);
      }
      run = 0;
      runM = [];
      runLines = [];
      out.push(...pending);
      pending = [];
    };
    for (const b of blocks) {
      const key = lineKey(b);
      if (/^\s{0,3}\|/.test(b)) {
        flush();
        out.push(b);
        if (key.length >= REPEAT_MIN) own.push(key);
        continue;
      }
      if (key.length < REPEAT_MIN) {
        if (key) short.push(key);
        // Blank lines and short lines a later message also has belong to a run around them.
        if (!key || ix.short.has(key)) {
          if (run) pending.push(b);
          else out.push(b);
          continue;
        }
        flush();
        out.push(b);
        continue;
      }
      const m = match(ix, key);
      if (m != null) {
        // One note per run, even when its lines are repeated in different later messages.
        run += b.split('\n').length + pending.filter((x) => x.trim()).length;
        runLines.push(...pending, b);
        pending = [];
        runM.push(m);
        continue;
      }
      flush();
      out.push(b);
      own.push(key);
    }
    flush();
    if (collapsed) r.body = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    for (const target of r.role === 'user' ? [all, users] : [all]) {
      for (const key of own) {
        if (!target.exact.has(key)) target.exact.set(key, r.m);
        target.words.push({ words: wordsOf(key), len: key.length, m: r.m });
      }
      for (const key of short) target.short.add(key);
    }
  }
}

/** Keeps the head and tail of a long Markdown body and keeps code fences balanced. */
export function clipMarkdown(body: string, maxTokens: number, lang: 'ko' | 'en' = 'en'): string {
  const lines = body.split('\n');
  const tokens = lines.map((l) => estimateTokens(l) + 1);
  const headBudget = maxTokens * 0.6;
  const tailBudget = maxTokens * 0.4;
  let h = 0;
  let acc = 0;
  while (h < lines.length && acc + tokens[h] <= headBudget) acc += tokens[h++];
  let t = lines.length;
  acc = 0;
  while (t > h && acc + tokens[t - 1] <= tailBudget) acc += tokens[--t];
  if (t <= h) return body;
  const head = lines.slice(0, h);
  const tail = lines.slice(t);
  const fenceCount = (ls: string[]) => ls.filter((l) => /^\s{0,3}(`{3,}|~{3,})/.test(l)).length;
  const omitted = lines.slice(h, t);
  const omittedTokens = Math.round(omitted.reduce((s, l) => s + estimateTokens(l), 0));
  const out = [...head];
  if (fenceCount(head) % 2 === 1) out.push('```');
  out.push('', lang === 'ko' ? `… [약 ${omittedTokens.toLocaleString('en-US')}토큰 생략] …` : `… [omitted ~${omittedTokens} tokens] …`, '');
  if ((fenceCount(head) + fenceCount(omitted)) % 2 === 1) out.push('```');
  out.push(...tail);
  return out.join('\n');
}

export type { Role };
