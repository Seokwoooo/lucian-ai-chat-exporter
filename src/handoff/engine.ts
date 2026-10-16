// Lucian Handoff engine. Turns a full conversation into an extractive handoff document that
// another AI can continue from. Every line it outputs is copied from the conversation (with a
// [#mN] reference); the algorithm only selects, orders and labels — it never invents facts.
//
// Pipeline: normalize (segment) → dedupe (hash + MinHash/LSH) → score (rule-based signals,
// recency, repetition) → track decisions / constraints / tasks → budgeted selection → render.

import type { Conversation, HandoffStats, Role } from '../shared/types';
import { estimateTokens, hangulRatio } from '../shared/util';
import { messageBodyMarkdown } from '../export/markdown';
import { clusterNearDuplicates, minhash } from './minhash';
import { CODE_ERROR_RE, F, classify, extractCommands, extractPaths, extractUrls, jaccard, replacementPairs, topicTokens } from './patterns';
import { segmentMessage, type Unit } from './segment';
import { renderHandoff, type HandoffDoc, type Item, type CodeItem, type PastItem, type RecentMessage } from './render';

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
}

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
  for (let m = 0; m < N; m++) {
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
  for (let i = 0; i < U; i++) {
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
      if (f & F.POLITE) s -= 3;
      if (u.kind === 'heading') s += 0.5;
      if (u.kind === 'table') s += 0.8;
      const ents = extractPaths(u.text).length + extractCommands(u.text).length;
      s += Math.min(2, ents * 0.8) + Math.min(0.8, extractUrls(u.text).length * 0.4);
      if (u.text.length < 8 && !(f & F.CONFIRM)) s -= 1;
      if (u.text.length > 600) s -= 0.5;
      if (user && repeats[i] > 1) s += Math.min(3, repeats[i] - 1);
      const sticky = f & (F.DECISION | F.PROHIBIT | F.GOAL);
      s *= sticky ? 0.9 + 0.2 * r : 0.55 + 0.9 * r;
    }
    if (rep[i] !== i) s *= 0.15; // older duplicate: the latest occurrence carries the weight
    score[i] = s;
  }

  const a: Analysis = { units, flags, score, rep, repeats, versions };
  const doc = buildDocument(conv, a, { sourceTokens, msgTokens, msgUnitStart, confirmedMsgs, lang, now });
  timings.scoreMs = clock() - t0;

  // ---------- 4. render ----------
  opts.onPhase?.('render');
  t0 = clock();
  const markdown = renderHandoff(doc);
  timings.renderMs = clock() - t0;

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

function buildDocument(conv: Conversation, a: Analysis, ctx: BuildCtx): HandoffDoc {
  const { units, flags, score, rep, repeats } = a;
  const N = conv.messages.length;
  const U = units.length;
  const used = new Set<number>();
  const usedKeys = new Set<number>();
  let uncertain = 0;
  const take = (i: number) => {
    used.add(i);
    usedKeys.add(units[i].key);
  };
  const isUsed = (i: number) => used.has(i) || usedKeys.has(units[i].key);
  const item = (i: number, extra: Partial<Item> = {}): Item => ({ text: units[i].text, m: units[i].m, role: units[i].role, ...extra });
  const tokensOf = new Map<number, string[]>();
  const topics = (i: number) => {
    let t = tokensOf.get(i);
    if (!t) {
      t = topicTokens(units[i].text);
      tokensOf.set(i, t);
    }
    return t;
  };

  const fullMode = ctx.sourceTokens <= FULL_MODE_TOKENS;
  const capBudget = fullMode ? MAX_BUDGET : handoffBudget(ctx.sourceTokens);
  const cap = (per: number, min: number, max: number) => Math.round(Math.min(max, Math.max(min, capBudget / per)));
  const MAX_DONE = cap(600, 10, 40);
  const MAX_OPEN = cap(500, 12, 50);
  const MAX_FAIL = cap(1500, 6, 20);
  const MAX_REQ = cap(600, 10, 40);

  // ---------- goal ----------
  const goal: Item[] = [];
  const firstUser = conv.messages.findIndex((m) => m.role === 'user');
  if (firstUser >= 0) {
    const start = ctx.msgUnitStart[firstUser];
    const end = ctx.msgUnitStart[firstUser + 1];
    const firstUnits = Array.from({ length: end - start }, (_, k) => start + k).filter((i) => isProse(units[i]));
    const firstText = firstUnits.map((i) => units[i].text).join(' ');
    const picks = estimateTokens(firstText) <= 350 ? firstUnits : [...firstUnits].sort((x, y) => score[y] - score[x]).slice(0, 5).sort((x, y) => x - y);
    for (const i of picks) {
      goal.push(item(i));
      take(i);
    }
  }
  const laterGoals = Array.from({ length: U }, (_, i) => i)
    .filter((i) => units[i].role === 'user' && units[i].m !== firstUser && flags[i] & F.GOAL && !(flags[i] & (F.PROHIBIT | F.CONSTRAINT)) && rep[i] === i && isProse(units[i]))
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
    if (!isProse(u) || rep[i] !== i) continue;
    const f = flags[i];
    if (f & F.POLITE || f & F.QUESTION) continue;
    // A bare confirmation ("좋아요, 그걸로 하죠") is not itself a decision; the assistant
    // proposal it confirms is recorded instead.
    if (u.role === 'user' && f & F.CONFIRM && topics(i).length <= 1) continue;
    const userDecision = u.role === 'user' && (f & F.DECISION || (f & F.CHANGE && f & F.DIRECTIVE));
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
  const MAX_DECISIONS = 60;
  const activeDecs = decs.filter((d) => d.status === 'active');
  const keptDecs = activeDecs.length > MAX_DECISIONS ? [...activeDecs].sort((x, y) => score[y.i] - score[x.i]).slice(0, MAX_DECISIONS).sort((x, y) => x.i - y.i) : activeDecs;
  const decisions: Item[] = keptDecs.map((d) => {
    take(d.i);
    if (d.uncertainBy != null) uncertain++;
    return item(d.i, {
      uncertain: d.uncertainBy != null ? { m: units[d.uncertainBy].m, kind: 'maybe-changed' } : undefined,
      confirmed: d.confirmed ? units[d.i].m + 1 : undefined,
    });
  });
  const superseded: Item[] = decs
    .filter((d) => d.status === 'superseded')
    .slice(-30)
    .map((d) => {
      take(d.i);
      return item(d.i, { supersededBy: units[d.by!].m });
    });

  // ---------- constraints ----------
  const cons: number[] = [];
  for (let i = 0; i < U; i++) {
    const u = units[i];
    if (u.role !== 'user' || !isProse(u) || rep[i] !== i || isUsed(i)) continue;
    const f = flags[i];
    if (f & F.QUESTION && !(f & F.PROHIBIT)) continue;
    if (f & F.PROHIBIT || (f & F.CONSTRAINT && (f & (F.EMPHASIS | F.DIRECTIVE)) !== 0) || (f & F.EMPHASIS && f & F.DIRECTIVE)) cons.push(i);
  }
  // Later permission on the same topic ("이제 React 써도 돼") marks a prohibition as uncertain.
  const permits = Array.from({ length: U }, (_, i) => i).filter((i) => units[i].role === 'user' && flags[i] & F.PERMIT);
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
  const keptGroups = consGroups.length > MAX_CONSTRAINTS ? [...consGroups].sort((x, y) => groupScore(y) - groupScore(x)).slice(0, MAX_CONSTRAINTS) : consGroups;
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
  // Directives from the user that are not constraints still matter (requirements).
  const reqs = Array.from({ length: U }, (_, i) => i)
    .filter((i) => units[i].role === 'user' && isProse(units[i]) && rep[i] === i && !isUsed(i) && flags[i] & F.DIRECTIVE && !(flags[i] & (F.QUESTION | F.ASK)))
    .sort((x, y) => score[y] - score[x])
    .slice(0, MAX_REQ)
    .sort((x, y) => x - y);
  const requirements: Item[] = reqs.map((i) => {
    take(i);
    return item(i, { repeats: repeats[i] > 1 ? repeats[i] : undefined });
  });

  // ---------- tasks ----------
  const doneIdx = Array.from({ length: U }, (_, i) => i).filter((i) => {
    const f = flags[i];
    return isProse(units[i]) && units[i].kind !== 'heading' && rep[i] === i && f & F.DONE && !(f & F.NOT_DONE) && !(f & F.QUESTION) && !(f & F.POLITE) && (units[i].checked !== false);
  });
  const isLabel = (i: number) => units[i].text.length <= 60 && /[:：]\s*$/.test(units[i].text);
  const openIdx = Array.from({ length: U }, (_, i) => i).filter((i) => {
    const f = flags[i];
    if (!isProse(units[i]) || units[i].kind === 'heading' || rep[i] !== i || f & F.POLITE || isLabel(i)) return false;
    if (units[i].checked === false) return true;
    if (units[i].checked === true) return false;
    return (f & F.TODO || f & F.NOT_DONE) && !(f & F.DONE && !(f & F.NOT_DONE));
  });
  const failMsgs = new Set<number>();
  for (let i = 0; i < U; i++) if (flags[i] & F.FAILURE && isProse(units[i]) && units[i].role === 'user') failMsgs.add(units[i].m);
  // Assistant text mentions "bug"/"error" in general explanations all the time; only keep it when
  // it is concrete (code, identifiers, a stated cause) or answers a failure the user reported.
  const concrete = (i: number) => /`[^`]+`|\w+(Error|Exception)\b|[A-Za-z_]+\(|\d{3}\b/.test(units[i].text) || (flags[i] & F.CAUSE) !== 0;
  const failIdx = Array.from({ length: U }, (_, i) => i).filter((i) => {
    if (rep[i] !== i) return false;
    const u = units[i];
    if (u.kind === 'code') return (flags[i] & F.FAILURE) !== 0;
    if (!isProse(u) || u.kind === 'heading') return false;
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
  const done: Item[] = [...doneIdx]
    .filter((i) => !isUsed(i))
    .sort((x, y) => score[y] - score[x])
    .slice(0, MAX_DONE)
    .sort((x, y) => x - y)
    .map((i) => {
      take(i);
      return item(i);
    });
  const open: Item[] = [];
  for (const i of openIdx) {
    if (isUsed(i)) continue;
    const r = resolvedBy(i);
    if (r != null && jaccard(topics(r), topics(i)) >= 0.5) continue; // clearly completed later
    take(i);
    if (r != null) uncertain++;
    open.push(item(i, { uncertain: r != null ? { m: units[r].m, kind: 'maybe-done' } : undefined }));
  }
  const openTrim = open.length > MAX_OPEN ? open.slice(-MAX_OPEN) : open;
  const failures: Item[] = failIdx
    .filter((i) => !isUsed(i) && (units[i].kind !== 'code' || units[i].m >= N * 0.5))
    .sort((x, y) => score[y] - score[x])
    .slice(0, MAX_FAIL)
    .sort((x, y) => x - y)
    .map((i) => {
      take(i);
      const r = resolvedBy(i);
      const text = units[i].kind === 'code' ? units[i].text.split('\n').filter((l) => l.trim()).slice(-12).join('\n') : units[i].text;
      return { text, m: units[i].m, role: units[i].role, code: units[i].kind === 'code', resolved: r != null ? units[r].m : undefined };
    });

  // ---------- current state & next steps ----------
  let lastUser = -1;
  for (let m = N - 1; m >= 0; m--) if (conv.messages[m].role === 'user') {
    lastUser = m;
    break;
  }
  const lastAssistant = N - 1 >= 0 && conv.messages[N - 1].role === 'assistant' ? N - 1 : -1;
  const lastAssistantKey: Item[] = [];
  if (lastAssistant >= 0) {
    const start = ctx.msgUnitStart[lastAssistant];
    const end = ctx.msgUnitStart[lastAssistant + 1];
    const idx = Array.from({ length: end - start }, (_, k) => start + k).filter((i) => isProse(units[i]) && !(flags[i] & F.POLITE));
    const picked = [...idx].sort((x, y) => score[y] - score[x]).slice(0, 8).sort((x, y) => x - y);
    for (const i of picked) lastAssistantKey.push(item(i));
  }
  const next: Item[] = [];
  const nextFrom = Math.max(0, N - 6);
  for (let i = ctx.msgUnitStart[nextFrom]; i < U; i++) {
    const u = units[i];
    if (!isProse(u) || u.role !== 'assistant') continue;
    const f = flags[i];
    if (isLabel(i) || u.kind === 'heading') continue;
    if ((u.underNext && u.kind === 'item') || (f & F.NEXT && !(f & F.QUESTION)) || (u.kind === 'item' && u.checked === false)) {
      if (!next.some((n) => n.text === u.text)) next.push(item(i));
    }
  }
  const nextTrim = next.slice(-15);

  // ---------- files, commands, links ----------
  const pathCount = new Map<string, { n: number; m: number }>();
  const cmdSet = new Map<string, number>();
  const urlCount = new Map<string, { n: number; m: number; title?: string }>();
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
    if (u.kind !== 'code') for (const url of extractUrls(text)) {
      const e = urlCount.get(url);
      urlCount.set(url, { n: (e?.n ?? 0) + 1, m: u.m });
    }
    if (u.title && /[\w-]+\.[a-z0-9]{1,6}$/i.test(u.title)) {
      const e = pathCount.get(u.title);
      pathCount.set(u.title, { n: (e?.n ?? 0) + 1, m: u.m });
    }
  }
  conv.messages.forEach((msg, m) => {
    for (const c of msg.contents) if (c.type === 'sources') for (const s of c.sources ?? []) {
      const e = urlCount.get(s.url);
      urlCount.set(s.url, { n: (e?.n ?? 0) + 1, m, title: s.title ?? e?.title });
    }
  });
  const files = [...pathCount.entries()]
    .sort((x, y) => y[1].n - x[1].n || y[1].m - x[1].m)
    .slice(0, 40)
    .map(([path, v]) => ({ text: path, m: v.m, count: v.n }));
  const commands = [...cmdSet.entries()].slice(-25).map(([cmd, m]) => ({ text: cmd, m }));
  const links = [...urlCount.entries()]
    .sort((x, y) => y[1].n - x[1].n || y[1].m - x[1].m)
    .slice(0, 40)
    .map(([url, v]) => ({ text: url, m: v.m, title: v.title, count: v.n }));

  // ---------- budgeted sections ----------
  const full = fullMode;
  const budget = full ? Infinity : capBudget;
  const fixedTokens = estimateTokens(
    [...goal, ...decisions, ...superseded, ...constraints, ...requirements, ...done, ...openTrim, ...nextTrim, ...failures, ...lastAssistantKey]
      .map((x) => x.text)
      .join('\n'),
  );

  // Code: latest version of each code cluster, highest scoring first, within ~30% of budget.
  const code: CodeItem[] = [];
  if (!full) {
    const codeBudget = Math.max(1500, budget * 0.3);
    const codeIdx = Array.from({ length: U }, (_, i) => i).filter((i) => units[i].kind === 'code' && rep[i] === i && !(units[i].title ?? '').startsWith('tool:'));
    let usedTok = 0;
    for (const i of [...codeIdx].sort((x, y) => score[y] - score[x])) {
      const u = units[i];
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

  // Recent raw messages (verbatim) — at least the last exchange, up to ~25% of the budget.
  const recent: RecentMessage[] = [];
  let recentFrom = N;
  if (full) {
    recentFrom = 0;
  } else {
    const recentBudget = Math.max(2500, budget * 0.25);
    let usedTok = 0;
    for (let m = N - 1; m >= 0; m--) {
      const tok = ctx.msgTokens[m];
      const mustKeep = N - m <= 2;
      if (!mustKeep && usedTok + Math.min(tok, 4000) > recentBudget) break;
      usedTok += Math.min(tok, mustKeep ? 6000 : 4000);
      recentFrom = m;
    }
  }
  for (let m = recentFrom; m < N; m++) {
    const msg = conv.messages[m];
    let body = messageBodyMarkdown(msg, { locale: ctx.lang });
    const limit = full ? Infinity : N - m <= 2 ? 6000 : 4000;
    let clipped = false;
    if (estimateTokens(body) > limit) {
      body = clipMarkdown(body, limit);
      clipped = true;
    }
    recent.push({ m, role: msg.role, model: msg.model, time: msg.created_at, body, clipped });
  }

  // Important past context: remaining budget filled with the best unused units before the recent window.
  const past: PastItem[] = [];
  if (!full) {
    const used0 = fixedTokens + code.reduce((s, c) => s + estimateTokens(c.text), 0) + recent.reduce((s, r) => s + estimateTokens(r.body), 0);
    let remaining = budget - used0 - 1500;
    // "Current focus" = what the latest requests, open tasks, next steps and decisions talk about.
    // Older text that shares those topics is relevant past context even without strong signals.
    const focus = new Set<string>();
    const addFocus = (text: string) => topicTokens(text).forEach((t) => focus.add(t));
    for (let m = Math.max(0, N - 6); m < N; m++) if (conv.messages[m].role === 'user') {
      for (let i = ctx.msgUnitStart[m]; i < ctx.msgUnitStart[m + 1]; i++) addFocus(units[i].text);
    }
    for (const it of [...openTrim, ...nextTrim, ...decisions, ...goal]) addFocus(it.text);
    const rel = new Map<number, number>();
    const cand: number[] = [];
    for (let i = 0; i < U; i++) {
      const u = units[i];
      if (u.m >= recentFrom || !isProse(u) || rep[i] !== i || isUsed(i) || flags[i] & F.POLITE || u.text.length < 12) continue;
      let r = 0;
      if (focus.size) {
        const tt = topics(i);
        let hit = 0;
        for (const t of tt) if (focus.has(t)) hit++;
        r = Math.min(2.5, (hit / Math.sqrt(tt.length + 1)) * 1.5);
      }
      if (score[i] + r > 0.9) {
        rel.set(i, score[i] + r);
        cand.push(i);
      }
    }
    cand.sort((x, y) => rel.get(y)! - rel.get(x)!);
    for (const i of cand) {
      if (remaining <= 0) break;
      const tok = estimateTokens(units[i].text) + 8;
      if (tok > remaining) continue;
      remaining -= tok;
      take(i);
      past.push({ text: units[i].text, m: units[i].m, role: units[i].role });
    }
    past.sort((x, y) => x.m - y.m);
  }

  return {
    lang: ctx.lang,
    mode: full ? 'full' : 'compressed',
    conv,
    now: ctx.now,
    sourceTokens: ctx.sourceTokens,
    budget: full ? null : budget,
    goal,
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
    code,
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
