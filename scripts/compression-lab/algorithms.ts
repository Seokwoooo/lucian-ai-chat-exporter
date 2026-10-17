// Compression lab — candidate algorithms. Every algorithm gets the same token budget and returns
// Markdown. None uses a language model: they differ only in which verbatim units they keep.

import { conceptsOf, greedyCoverage, type CoverItem } from '../../src/handoff/coverage';
import { runHandoff, V11_LAYOUT, V12_LAYOUT, type Layout } from '../../src/handoff/engine';
import { estimateTokens } from '../../src/shared/util';
import { centroid, cliff, facility, hybrid, hybridRepair, klsum, lsa, submodular, sumbasic, surprisal, withRepair } from './classic';
import { embFacility, embHybrid, embMMR, external, semDedupeCoverage } from './embedding';
import { reduced } from './lossless';
import { fillBudget, renderUnits, type Idf, type Prepared } from './prepare';

export type Algorithm = (p: Prepared, budget: number, idf: Idf) => string;

const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const recency = (p: Prepared, i: number) => p.units[i].m / Math.max(1, p.conv.messages.length - 1);

/** Sparse TF-IDF vector of a unit (term → weight), L2-normalized. */
function vector(p: Prepared, i: number, idf: Idf): Map<string, number> {
  const v = new Map<string, number>();
  for (const t of p.terms[i]) v.set(t, (v.get(t) ?? 0) + idf(t));
  let n = 0;
  for (const w of v.values()) n += w * w;
  n = Math.sqrt(n) || 1;
  for (const [t, w] of v) v.set(t, w / n);
  return v;
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  const [s, l] = a.size < b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [t, w] of s) dot += w * (l.get(t) ?? 0);
  return dot;
}

// ---------- baselines ----------

/** Keep the latest messages verbatim (what a plain "copy the end of the chat" does). */
export const recent: Algorithm = (p, budget) => renderUnits(p, fillBudget(p, range(p.units.length).reverse(), budget));

/** First request, then the latest messages. */
export const headTail: Algorithm = (p, budget) => {
  const firstUser = p.conv.messages.findIndex((m) => m.role === 'user');
  const head = firstUser >= 0 ? range(p.msgStart[firstUser + 1] - p.msgStart[firstUser]).map((k) => p.msgStart[firstUser] + k) : [];
  return renderUnits(p, fillBudget(p, [...head, ...range(p.units.length).reverse()], budget));
};

/** Lead-k: the first k units of every message, k as large as the budget allows. */
export const lead: Algorithm = (p, budget) => {
  const pick = (k: number) => {
    const out: number[] = [];
    for (let m = 0; m + 1 < p.msgStart.length; m++) for (let i = p.msgStart[m]; i < Math.min(p.msgStart[m + 1], p.msgStart[m] + k); i++) out.push(i);
    return out;
  };
  let k = 1;
  while (k < 40 && pick(k + 1).reduce((s, i) => s + p.cost[i] + 1, 0) + p.conv.messages.length * 8 <= budget) k++;
  return renderUnits(p, fillBudget(p, pick(k), budget));
};

// ---------- classic extractive summarization ----------

/** TF-IDF salience with length normalization and a recency prior. */
export const tfidf: Algorithm = (p, budget, idf) => {
  const score = range(p.units.length).map((i) => {
    let s = 0;
    for (const t of new Set(p.terms[i])) s += idf(t);
    return (s / Math.sqrt(1 + p.terms[i].length)) * (0.6 + 0.8 * recency(p, i)) * (p.units[i].role === 'user' ? 1.3 : 1);
  });
  return renderUnits(p, fillBudget(p, range(p.units.length).sort((a, b) => score[b] - score[a]), budget));
};

/** LexRank/TextRank: PageRank over a sparse similarity graph of units (shared rare terms). */
export const textrank: Algorithm = (p, budget, idf) => {
  const U = p.units.length;
  const post = new Map<string, number[]>();
  p.terms.forEach((ts, i) => {
    for (const t of new Set(ts)) {
      const l = post.get(t);
      if (l) l.push(i);
      else post.set(t, [i]);
    }
  });
  const edges: Array<Map<number, number>> = range(U).map(() => new Map());
  for (const [t, list] of post) {
    if (list.length < 2 || list.length > 40) continue; // very common terms say nothing about similarity
    const w = idf(t);
    for (let a = 0; a < list.length; a++)
      for (let b = a + 1; b < list.length; b++) {
        edges[list[a]].set(list[b], (edges[list[a]].get(list[b]) ?? 0) + w);
        edges[list[b]].set(list[a], (edges[list[b]].get(list[a]) ?? 0) + w);
      }
  }
  const out = edges.map((e) => [...e.values()].reduce((s, x) => s + x, 0));
  let r = new Float64Array(U).fill(1 / Math.max(1, U));
  for (let it = 0; it < 25; it++) {
    const next = new Float64Array(U).fill(0.15 / Math.max(1, U));
    for (let i = 0; i < U; i++) {
      if (!out[i]) continue;
      for (const [j, w] of edges[i]) next[j] += (0.85 * r[i] * w) / out[i];
    }
    r = next;
  }
  const score = range(U).map((i) => r[i] * (0.6 + 0.8 * recency(p, i)));
  return renderUnits(p, fillBudget(p, range(U).sort((a, b) => score[b] - score[a]), budget));
};

/** MMR: relevance to what the user asked (recent requests weigh more) minus redundancy. */
export const mmr: Algorithm = (p, budget, idf) => {
  const U = p.units.length;
  const q = new Map<string, number>();
  range(U).forEach((i) => {
    if (p.units[i].role !== 'user') return;
    const w = 1 + 2 * recency(p, i);
    for (const t of p.terms[i]) q.set(t, (q.get(t) ?? 0) + w * idf(t));
  });
  let qn = 0;
  for (const w of q.values()) qn += w * w;
  qn = Math.sqrt(qn) || 1;
  for (const [t, w] of q) q.set(t, w / qn);
  const vecs = range(U).map((i) => vector(p, i, idf));
  const rel = range(U).map((i) => cosine(vecs[i], q) + 0.3 * recency(p, i));
  const cand = range(U).sort((a, b) => rel[b] - rel[a]).slice(0, 3000);
  const maxSim = new Float64Array(U);
  const order: number[] = [];
  const left = new Set(cand);
  let used = 0;
  while (left.size && used < budget) {
    let best = -1;
    let bestScore = -Infinity;
    for (const i of left) {
      const s = 0.7 * rel[i] - 0.3 * maxSim[i];
      if (s > bestScore) {
        bestScore = s;
        best = i;
      }
    }
    left.delete(best);
    order.push(best);
    used += p.cost[best];
    for (const i of left) maxSim[i] = Math.max(maxSim[i], cosine(vecs[i], vecs[best]));
  }
  return renderUnits(p, fillBudget(p, order, budget));
};

// ---------- budgeted maximum coverage ----------

/** Concept weight = IDF × log frequency in the conversation, ×1.5 when the user used the word. */
function conceptWeight(p: Prepared, idf: Idf): (c: string) => number {
  const tf = new Map<string, number>();
  const byUser = new Set<string>();
  p.terms.forEach((ts, i) => {
    for (const t of ts) {
      tf.set(t, (tf.get(t) ?? 0) + 1);
      if (p.units[i].role === 'user') byUser.add(t);
    }
  });
  return (c) => {
    const parts = c.split(' ');
    const base = parts.length === 1 ? idf(c) : 0.5 * (idf(parts[0]) + idf(parts[1]));
    return base * (1 + Math.log(tf.get(parts[0]) ?? 1)) * (byUser.has(parts[0]) ? 1.5 : 1);
  };
}

/** Budgeted maximum coverage over all units (shared implementation: src/handoff/coverage.ts). */
export function coverageSelect(p: Prepared, idf: Idf, budget: number, preselected: number[] = []): number[] {
  const covered = new Set<string>();
  for (const i of preselected) for (const c of conceptsOf(p.terms[i])) covered.add(c);
  const pre = new Set(preselected);
  const items: CoverItem[] = range(p.units.length)
    .filter((i) => !pre.has(i))
    .map((i) => ({ id: i, concepts: conceptsOf(p.terms[i]), cost: p.cost[i] + 1, prior: 0.75 + 0.5 * recency(p, i) }));
  const usedPre = preselected.reduce((s, i) => s + p.cost[i], 0);
  // Message headers cost ~8 tokens each; keep ~6% of the budget for them.
  const picked = greedyCoverage(items, conceptWeight(p, idf), Math.max(0, budget * 0.94 - usedPre), covered);
  return fillBudget(p, picked, budget, preselected);
}

export const coverage: Algorithm = (p, budget, idf) => renderUnits(p, coverageSelect(p, idf, budget));

/**
 * Skeleton + coverage: the latest exchange verbatim (≈25%), every user request (≈15%), then
 * budgeted coverage over everything else.
 */
export const skeletonCoverage: Algorithm = (p, budget, idf) => {
  const N = p.conv.messages.length;
  const recentUnits: number[] = [];
  let used = 0;
  for (let m = N - 1; m >= 0 && used < budget * 0.25; m--) {
    for (let i = p.msgStart[m]; i < p.msgStart[m + 1]; i++) {
      recentUnits.push(i);
      used += p.cost[i];
    }
  }
  const userUnits = range(p.units.length).filter((i) => p.units[i].role === 'user' && p.units[i].kind !== 'code');
  const base = fillBudget(p, [...recentUnits, ...userUnits.reverse()], budget * 0.42);
  return renderUnits(p, coverageSelect(p, idf, budget, base));
};

// ---------- current engine ----------

export const lucian: Algorithm = (p, budget) => runHandoff(p.conv, { budgetTokens: budget, now: 0 }).markdown;

const engine =
  (selection: 'relevance' | 'coverage', layout: Partial<Layout>): Algorithm =>
  (p, budget) =>
    runHandoff(p.conv, { budgetTokens: budget, now: 0, selection, layout }).markdown;

/** v1.1: relevance-ranked context, long transcript messages, 25% code, clipped middles dropped. */
export const lucianV11 = engine('relevance', V11_LAYOUT);
/** v1.1 layout with coverage selection only. */
export const lucianV11Coverage = engine('coverage', V11_LAYOUT);

/** v1.2: coverage-selected context, but a quarter of the budget for the transcript and no caps on decisions. */
export const lucianV12 = engine('coverage', V12_LAYOUT);

// ---------- token-level compaction (applied on top of a selection) ----------

const FILLER =
  /(?<![\p{L}\p{N}])(?:그리고|그래서|하지만|또한|특히|정말|매우|아주|사실|기본적으로|일반적으로|물론|우선|먼저|이제|다만|즉|예를 들어|the|a|an|very|really|basically|actually|just|also|simply|of course)(?![\p{L}\p{N}])\s*/giu;

/** Drops filler words outside code (a cheap stand-in for LLMLingua-style token pruning). */
export function compact(md: string): string {
  const parts = md.split(/(```[\s\S]*?```)/g);
  return parts.map((s, i) => (i % 2 ? s : s.replace(FILLER, '').replace(/[ \t]{2,}/g, ' '))).join('');
}

/** Wraps an algorithm: compacts its output and refills the freed tokens (two rounds). */
export function compacted(alg: Algorithm): Algorithm {
  return (p, budget, idf) => {
    let b = budget;
    let out = compact(alg(p, b, idf));
    for (let k = 0; k < 2; k++) {
      const t = estimateTokens(out);
      if (t <= 0) break;
      b = Math.round(b * (budget / t));
      out = compact(alg(p, b, idf));
    }
    return out;
  };
}

/** Runs an algorithm on the near-lossless reduced conversation (duplicates and old code removed). */
export const onReduced =
  (alg: Algorithm): Algorithm =>
  (p, budget, idf) =>
    alg(reduced(p), budget, idf);

export const ALGORITHMS: Record<string, Algorithm> = {
  recent,
  headTail,
  lead,
  tfidf,
  textrank,
  mmr,
  coverage,
  skeletonCoverage,
  lucian,
  'lucian/v1.2': lucianV12,
  'lucian/v1.1': lucianV11,
  'lucian/v1.1+coverage': lucianV11Coverage,
  // the default engine without referential repair (layout.repair = false)
  'lucian/norepair': engine('coverage', { repair: false }),
  // the default layout with relevance ranking instead of coverage
  'lucian/relevance': engine('relevance', {}),
  // smaller transcript (15%, ≤2000 / ≤1000 tokens per message)
  'lucian/recent15': engine('coverage', { recentShare: 0.15, recentMin: 1500, lastMsgCap: 2000, recentMsgCap: 1000 }),
  // longer latest messages in the transcript (≤4000 / ≤2000 tokens)
  'lucian/last4000': engine('coverage', { lastMsgCap: 4000, recentMsgCap: 2000 }),
  // ≤3500 / ≤1500
  'lucian/last3500': engine('coverage', { lastMsgCap: 3500 }),
  // code back at 25%
  'lucian/code25': engine('coverage', { codeShare: 0.25, codeMin: 1500 }),
  'coverage+compact': compacted(coverage),
  klsum,
  sumbasic,
  centroid,
  lsa,
  facility,
  submodular,
  surprisal,
  cliff,
  'coverage+repair': withRepair((p, idf, b) => coverageSelect(p, idf, b)),
  'coverage+facility': hybrid,
  'coverage+facility+repair': hybridRepair,
  'emb:facility': embFacility,
  'emb:mmr': embMMR,
  'emb:hybrid': embHybrid,
  'emb:dedupe+coverage': semDedupeCoverage,
  'ext:llmlingua2': external('llmlingua2'),
  'dedupe+recent': onReduced(recent),
  'dedupe+mmr': onReduced(mmr),
  'dedupe+coverage': onReduced(coverage),
  'dedupe+skeleton': onReduced(skeletonCoverage),
};
