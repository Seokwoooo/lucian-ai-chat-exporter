// Lucian Handoff engine. Turns a full conversation into an extractive handoff document that
// another AI can continue from. Every line it outputs is copied from the conversation (with a
// [#mN] reference); the algorithm only selects, orders and labels — it never invents facts.
//
// Pipeline: normalize (segment) → dedupe (hash + MinHash/LSH) → score (rule-based signals,
// recency, repetition) → track decisions / constraints / tasks → budgeted selection → render.

import type { Conversation, HandoffStats, Role } from '../shared/types';
import { cleanUrl, estimateTokens, hangulRatio, hostLabel, urlKey } from '../shared/util';
import { messageBodyMarkdown, replaceOutsideCode } from '../export/markdown';
import { clusterNearDuplicates, minhash } from './minhash';
import { conceptsOf, greedyCoverage, type CoverItem } from './coverage';
import { ANAPHOR_RE, CODE_ERROR_RE, F, REVERSAL_RE, bulletText, classify, extractCommands, extractLinks, extractPaths, extractUrls, jaccard, replacementPairs, stripTracking, topicTokens } from './patterns';
import { segmentMessage, type Unit } from './segment';
import { renderHandoff, type HandoffDoc, type Item, type CodeItem, type PastItem, type RecentMessage, type RequestItem } from './render';

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
  /** Fixed output budget in tokens instead of the default (12% of the source, 8k–32k). Used by the compression lab. */
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
  /** Appendix table of referenced messages (role, time, first line). */
  refIndex: boolean;
  /** How much rule-based relevance raises a unit's coverage gain (0 = concepts only, 1 = up to ×2 over the least relevant). */
  relPrior: number;
  /** One listed file path per this many budget tokens (6–40 paths). */
  filesPer: number;
}

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
  recentMsgShare: 0.06,
  codeShare: 0.06,
  codeMin: 300,
  listScale: 0.4,
  ruleShare: 0.2,
  clippedExcerpts: true,
  repair: true,
  refIndex: false,
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
  recentMsgShare: 0,
  codeShare: 0.1,
  codeMin: 600,
  listScale: 1,
  ruleShare: Infinity,
  clippedExcerpts: true,
  repair: true,
  refIndex: true,
  relPrior: 0.5,
  filesPer: 200,
};

/** v1.1 layout, kept for comparison in the compression lab. */
export const V11_LAYOUT: Layout = { ...V12_LAYOUT, lastMsgCap: 6000, recentMsgCap: 4000, codeShare: 0.25, codeMin: 1500, clippedExcerpts: false, repair: false };

/** Earlier-context selection used by default (chosen with the compression lab, docs/compression-lab.md). */
export const DEFAULT_SELECTION: 'relevance' | 'coverage' = 'coverage';

/** Conversations up to this size are handed off in full: nothing needs to be dropped. */
export const FULL_MODE_TOKENS = 12_000;
const MIN_BUDGET = 8_000;
const MAX_BUDGET = 32_000;
const SIG_MIN_PROSE = 120;
/** User sentences are short but repeated instructions matter, so they get signatures earlier. */
const SIG_MIN_USER = 24;
const SIG_MIN_CODE = 60;

const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function handoffBudget(sourceTokens: number): number {
  return Math.round(Math.min(MAX_BUDGET, Math.max(MIN_BUDGET, sourceTokens * 0.12)));
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
  let userText = '';
  const progress = opts.onProgress;
  const step = Math.max(1, Math.floor(N / 50));
  for (let m = 0; m < N; m++) {
    if (progress && m % step === 0) progress((0.35 * m) / N);
    msgUnitStart[m] = units.length;
    segmentMessage(messages[m], m, units);
    let chars = 0;
    for (const c of messages[m].contents) {
      if (c.type === 'thinking') continue;
      const s = c.content ?? c.attachment?.extractedText ?? '';
      chars += s.length;
      msgTokens[m] += estimateTokens(s);
      if (messages[m].role === 'user' && userText.length < 40_000) userText += `${s}\n`;
    }
    void chars;
  }
  msgUnitStart[N] = units.length;
  const sourceTokens = Math.round(msgTokens.reduce((a, b) => a + b, 0));
  const lang: 'ko' | 'en' = hangulRatio(userText || messages.map((m) => m.contents.map((c) => c.content ?? '').join(' ')).join(' ').slice(0, 40_000)) >= 0.2 ? 'ko' : 'en';
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
  const ctx: BuildCtx = { sourceTokens, msgTokens, msgUnitStart, confirmedMsgs, lang, now, budgetTokens: opts.budgetTokens, selection: opts.selection ?? DEFAULT_SELECTION, layout: { ...DEFAULT_LAYOUT, ...opts.layout }, pastExtra: 0 };
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
  if (doc.budget != null) {
    const B = doc.budget;
    const limit = B * 1.02;
    let tokens = estimateTokens(markdown);
    let last = tokens;
    let extra = 0;
    for (let pass = 0; pass < 2; pass++) {
      const diff = B - last;
      if (diff >= -B * 0.02 && diff <= B * 0.04) break;
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
      }
    }
  }
  timings.renderMs = clock() - t0;
  progress?.(1);

  const outputTokens = estimateTokens(markdown);
  return {
    markdown,
    lang,
    cache,
    timings,
    stats: {
      sourceTokens,
      outputTokens,
      messages: N,
      decisions: doc.decisions.length,
      constraints: doc.constraints.length,
      openTasks: doc.open.length,
      cacheHits: hits,
      cacheMisses: misses,
      mode: doc.mode,
      uncertain: doc.uncertainCount,
      outputChars: markdown.length,
    },
  };
}

interface BuildCtx {
  budgetTokens?: number;
  selection: 'relevance' | 'coverage';
  layout: Layout;
  /** Extra tokens for earlier context (second pass, when the first one left budget unused). */
  pastExtra: number;
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
  const body = messageBodyMarkdown({ ...msg, contents: msg.contents.filter((c) => c.type !== 'sources') }, { locale: lang });
  // Message headings ("# 결론", "## 1. …") would otherwise read as sections of the handoff itself.
  return replaceOutsideCode(body, (seg) =>
    stripTracking(seg.replace(/^( {0,3})(#{1,6})(?=\s)/gm, (_, sp: string, h: string) => `${sp}${'#'.repeat(Math.min(6, h.length + 3))}`)),
  );
}

const REQUEST_CHARS = 240;
const LEAD_CHARS = 220;

function clipLine(text: string, max: number): { text: string; clipped: boolean } {
  const t = text.replace(/\s*\n\s*/g, ' ').trim();
  return t.length > max ? { text: `${t.slice(0, max).trimEnd()}…`, clipped: true } : { text: t, clipped: false };
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

  const fullMode = ctx.budgetTokens != null ? ctx.sourceTokens <= ctx.budgetTokens : ctx.sourceTokens <= FULL_MODE_TOKENS;
  const capBudget = ctx.budgetTokens ?? (fullMode ? MAX_BUDGET : handoffBudget(ctx.sourceTokens));
  const cap = (per: number, min: number, max: number) => Math.round(Math.min(max, Math.max(min, capBudget / per)));
  const MAX_DONE = cap(600, 10, 40);
  const MAX_OPEN = cap(500, 12, 50);
  const MAX_FAIL = cap(1500, 6, 20);
  const MAX_REQ = cap(600, 10, 40);
  const MAX_REQUESTS = fullMode ? 60 : cap(400, 20, 60);
  const MAX_LINKS = fullMode ? 20 : cap(1000, 8, 40);
  const MAX_FILES = fullMode ? 40 : cap(ctx.layout.filesPer, 6, 40);
  const MAX_COMMANDS = fullMode ? 25 : cap(700, 8, 25);
  /** One long answer must not flood a section: at most this many items per assistant message. */
  const PER_MESSAGE = 4;
  // Token shares of the budget per section (compressed mode). Each section is filled by priority
  // until its share is used, so the whole document stays near the budget instead of growing with
  // every extra signal. Decisions and constraints are never cut by these shares.
  const share = (f: number) => (fullMode ? Infinity : capBudget * f * ctx.layout.listScale);
  // Transcript caps per message shrink with the budget (the cut-out middle stays selectable).
  const scaledCap = (cap: number, s: number, floor: number) => (s > 0 ? Math.round(Math.min(cap, Math.max(floor, capBudget * s))) : cap);
  const lastMsgCap = scaledCap(ctx.layout.lastMsgCap, ctx.layout.lastMsgShare, 400);
  const recentMsgCap = scaledCap(ctx.layout.recentMsgCap, ctx.layout.recentMsgShare, 250);
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
  if (fullMode) recentFrom = 0;
  else {
    const { recentShare, recentMin } = ctx.layout;
    const recentBudget = Math.max(recentMin, capBudget * recentShare);
    let usedTok = 0;
    for (let m = N - 1; m >= 0; m--) {
      const tok = ctx.msgTokens[m];
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
    const picks = estimateTokens(firstText) <= 350 ? firstUnits : [...firstUnits].sort((x, y) => score[y] - score[x]).slice(0, 5).sort((x, y) => x - y);
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
    const latest = new Set(userMsgs.slice(-12));
    const msgScore0 = (m: number) => Math.max(0, ...unitsOf(m).map((i) => score[i]));
    const rest = userMsgs.filter((m) => !latest.has(m)).sort((x, y) => msgScore0(y) - msgScore0(x)).slice(0, MAX_REQUESTS - latest.size);
    const keep = new Set([...rest, ...latest]);
    keptReq = userMsgs.filter((m) => keep.has(m));
  }
  const msgScore = (m: number) => Math.max(0, ...unitsOf(m).map((i) => score[i]));
  let reqs0 = keptReq.map((m) => {
    const { text, clipped } = clipLine(bulletText(messageText(conv.messages[m])), REQUEST_CHARS);
    // The lead sentence of the answer gives the next AI the outcome of each turn in one line.
    let leadIdx = -1;
    const reply = m + 1 < N && conv.messages[m + 1].role === 'assistant' ? m + 1 : -1;
    if (reply >= 0 && reply < recentFrom) {
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
      const latest = new Set(reqs0.slice(-12).map((r) => r.m));
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
  const ruleBudget = fullMode ? Infinity : capBudget * ctx.layout.ruleShare;
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
  for (const d of decs.filter((x) => x.status === 'superseded').slice(-30).reverse()) {
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
  const nextTrim = next.slice(-15);
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
    const shownWhole = !fullMode && ctx.msgTokens[lastAssistant] <= lastMsgCap;
    const picked = [...idx].sort((x, y) => weight(y) - weight(x)).slice(0, shownWhole ? 2 : 6).sort((x, y) => x - y);
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
    for (const p of extractPaths(u.kind === 'code' ? text.slice(0, 2000) : text)) {
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
  const full = fullMode;
  const budget = full ? Infinity : capBudget;
  const fixedTokens = estimateTokens(
    [...goal, ...decisions, ...superseded, ...constraints, ...requirements, ...done, ...openTrim, ...nextTrim, ...failures, ...lastAssistantKey]
      .map((x) => x.text)
      .concat(requests.map((r) => `${r.text} ${r.lead?.text ?? ''}`))
      .join('\n'),
  );

  // Recent raw messages (verbatim), or the whole conversation when it is short.
  const recent: RecentMessage[] = [];
  const recentClipped = new Set<number>();
  const hiddenInRecent = new Set<number>();
  for (let m = recentFrom; m < N; m++) {
    const msg = conv.messages[m];
    let body = transcriptBody(msg, ctx.lang);
    const limit = full ? Infinity : N - m <= 2 ? lastMsgCap : recentMsgCap;
    let clipped = false;
    if (estimateTokens(body) > limit) {
      body = clipMarkdown(body, limit);
      clipped = true;
    }
    recent.push({ m, role: msg.role, model: msg.model, time: msg.created_at, body, clipped });
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


  // Code: latest version of each code cluster, highest scoring first, within ~30% of budget.
  const code: CodeItem[] = [];
  const codeInRecent = new Set<number>();
  if (!full) {
    const codeBudget = Math.max(ctx.layout.codeMin, budget * ctx.layout.codeShare);
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
      const body = truncated ? [...lines.slice(0, 170), `… (${lines.length - 200} lines omitted — see [#m${u.m + 1}])`, ...lines.slice(-30)].join('\n') : u.text;
      const tok = estimateTokens(body);
      if (usedTok + tok > codeBudget) continue;
      usedTok += tok;
      code.push({ text: body, m: u.m, role: u.role, lang: u.lang, title: u.title, versions: a.versions[i], truncated });
    }
    code.sort((x, y) => x.m - y.m);
  }

  // Important past context: remaining budget filled with the best unused units before the recent
  // window. Selection is relevance-ranked and redundancy-aware (MMR-style): a candidate whose topic
  // words are already covered by what was selected adds little and is skipped.
  const past: PastItem[] = [];
  if (!full) {
    const used0 = fixedTokens + code.reduce((s, c) => s + estimateTokens(c.text), 0) + recent.reduce((s, r) => s + estimateTokens(r.body), 0);
    // Reserve for the header, formatting and (if shown) the reference index; the render pass
    // in runHandoff corrects the estimate either way.
    let remaining = budget - used0 - (ctx.layout.refIndex ? 1500 : 700) + ctx.pastExtra;
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
    const chainCost = (ch: number[]) => ch.reduce((s2, k) => s2 + (used.has(k) ? 0 : estimateTokens(units[k].text) + 8), 0);
    const takeChain = (ch: number[]) => {
      for (const k of ch) {
        if (used.has(k)) continue;
        take(k);
        remaining -= estimateTokens(units[k].text) + 8;
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
      const df = new Map<string, number>();
      const tfAll = new Map<string, number>();
      const byUser = new Set<string>();
      for (let m = 0; m < N; m++) {
        const seen = new Set<string>();
        for (const i of unitsOf(m)) {
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
      const weight = (c: string) => {
        const parts = c.split(' ');
        const base = parts.length === 1 ? idf(c) : 0.5 * (idf(parts[0]) + idf(parts[1]));
        return base * (1 + Math.log(tfAll.get(parts[0]) ?? 1)) * (byUser.has(parts[0]) ? 1.5 : 1);
      };
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
  }

  return {
    lang: ctx.lang,
    mode: full ? 'full' : 'compressed',
    refIndex: ctx.layout.refIndex,
    conv,
    now: ctx.now,
    sourceTokens: ctx.sourceTokens,
    budget: full ? null : budget,
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
    files,
    commands,
    links,
    linksOmitted,
    code,
    codeInRecent: [...codeInRecent].sort((x, y) => x - y),
    past,
    recent,
    uncertainCount: uncertain,
  };
}

/** Two prohibitions about the same distinctive term (e.g. both mention "jquery"). */
function sameRule(a: string[], b: string[]): boolean {
  const distinctive = (t: string) => /[a-z0-9]/.test(t) && t.length >= 3;
  return a.some((t) => distinctive(t) && b.includes(t));
}

/** Keeps the head and tail of a long Markdown body and keeps code fences balanced. */
export function clipMarkdown(body: string, maxTokens: number): string {
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
  out.push('', `… [omitted ~${omittedTokens} tokens] …`, '');
  if ((fenceCount(head) + fenceCount(omitted)) % 2 === 1) out.push('```');
  out.push(...tail);
  return out.join('\n');
}

export type { Role };
