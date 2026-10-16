// Compression lab — selection with sentence embeddings (EmbeddingGemma 2, computed offline by
// py/embed.py). Not usable in the extension as it is (Lucian has no model); measured to see what a
// local embedding model would add over the model-free concept coverage.

import type { Algorithm } from './algorithms';
import { coverageSelect } from './algorithms';
import { embeddings, externalOutput, labContext, type Embeddings } from './ext';
import { conceptsOf } from '../../src/handoff/coverage';
import { fillBudget, renderUnits, type Idf, type Prepared } from './prepare';

const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const recency = (p: Prepared, i: number) => p.units[i].m / Math.max(1, p.conv.messages.length - 1);

function dot(e: Embeddings, a: number, b: number): number {
  let s = 0;
  const oa = a * e.dim;
  const ob = b * e.dim;
  for (let d = 0; d < e.dim; d++) s += e.vec[oa + d] * e.vec[ob + d];
  return s;
}

/** Reverse neighbor lists: units that have `j` among their nearest neighbors (with similarity). */
function reverseKnn(e: Embeddings, U: number): Array<Array<[number, number]>> {
  const rev: Array<Array<[number, number]>> = range(U).map((i) => [[i, 1]]);
  for (let i = 0; i < U; i++)
    for (let r = 0; r < e.k; r++) {
      const j = e.knnIdx[i * e.k + r];
      if (j >= 0 && j < U) rev[j].push([i, e.knnSim[i * e.k + r]]);
    }
  return rev;
}

/** Generic cost-scaled lazy greedy over a monotone submodular gain. */
function lazyGreedy(n: number, cost: (j: number) => number, gain: (j: number) => number, commit: (j: number) => void, budget: number): number[] {
  const g = range(n).map((j) => gain(j) / Math.pow(cost(j) + 1, 0.9));
  const order = range(n).sort((a, b) => g[b] - g[a]);
  const heap: Array<[number, number]> = order.map((j) => [g[j], j]);
  const chosen: number[] = [];
  let used = 0;
  while (heap.length && used < budget) {
    const [, j] = heap.shift()!;
    if (used + cost(j) > budget) continue;
    const fresh = gain(j) / Math.pow(cost(j) + 1, 0.9);
    if (heap.length && fresh < heap[0][0]) {
      let lo = 0;
      let hi = heap.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (heap[mid][0] > fresh) lo = mid + 1;
        else hi = mid;
      }
      heap.splice(lo, 0, [fresh, j]);
      continue;
    }
    if (fresh <= 0) break;
    chosen.push(j);
    used += cost(j);
    commit(j);
  }
  return chosen;
}

/** Facility location: every unit should have a close (semantically similar) unit in the summary. */
function facilitySelect(p: Prepared, e: Embeddings, budget: number, weight: (i: number) => number = () => 1): number[] {
  const U = p.units.length;
  const rev = reverseKnn(e, U);
  const best = new Float64Array(U);
  return lazyGreedy(
    U,
    (j) => p.cost[j],
    (j) => {
      let s = 0;
      for (const [i, w] of rev[j]) if (w > best[i]) s += (w - best[i]) * weight(i);
      return s;
    },
    (j) => {
      for (const [i, w] of rev[j]) if (w > best[i]) best[i] = w;
    },
    budget * 0.94,
  );
}

const fallback: Algorithm = (p, budget, idf) => renderUnits(p, coverageSelect(p, idf, budget));

export const embFacility: Algorithm = (p, budget, idf) => {
  const e = embeddings(labContext.ci);
  if (!e) return fallback(p, budget, idf);
  return renderUnits(p, fillBudget(p, facilitySelect(p, e, budget, (i) => 0.75 + 0.5 * recency(p, i)), budget));
};

/** MMR with embeddings: similarity to the latest requests minus similarity to what is chosen. */
export const embMMR: Algorithm = (p, budget, idf) => {
  const e = embeddings(labContext.ci);
  if (!e) return fallback(p, budget, idf);
  const U = p.units.length;
  const q = new Float64Array(e.dim);
  const users = range(U).filter((i) => p.units[i].role === 'user' && p.units[i].kind !== 'code');
  for (const i of users.slice(-12)) for (let d = 0; d < e.dim; d++) q[d] += e.vec[i * e.dim + d] * (1 + recency(p, i));
  const qn = Math.sqrt(q.reduce((a, x) => a + x * x, 0)) || 1;
  const rel = range(U).map((i) => {
    let s = 0;
    for (let d = 0; d < e.dim; d++) s += (e.vec[i * e.dim + d] * q[d]) / qn;
    return s + 0.3 * recency(p, i);
  });
  const cand = range(U).sort((a, b) => rel[b] - rel[a]).slice(0, 2500);
  const maxSim = new Float64Array(U);
  const left = new Set(cand);
  const order: number[] = [];
  let used = 0;
  while (left.size && used < budget) {
    let best = -1;
    let bs = -Infinity;
    for (const i of left) {
      const s = 0.7 * rel[i] - 0.3 * maxSim[i];
      if (s > bs) {
        bs = s;
        best = i;
      }
    }
    left.delete(best);
    order.push(best);
    used += p.cost[best];
    for (const i of left) maxSim[i] = Math.max(maxSim[i], dot(e, i, best));
  }
  return renderUnits(p, fillBudget(p, order, budget));
};

/** Concept coverage + facility location (both submodular; the sum is too). */
export const embHybrid: Algorithm = (p, budget, idf) => {
  const e = embeddings(labContext.ci);
  if (!e) return fallback(p, budget, idf);
  const U = p.units.length;
  const rev = reverseKnn(e, U);
  const best = new Float64Array(U);
  const covered = new Set<string>();
  const concepts = range(U).map((i) => conceptsOf(p.terms[i]));
  const w = new Map<string, number>();
  const cw = (c: string) => {
    let x = w.get(c);
    if (x == null) {
      const parts = c.split(' ');
      x = parts.length === 1 ? idf(c) : 0.5 * (idf(parts[0]) + idf(parts[1]));
      w.set(c, x);
    }
    return x;
  };
  // Scale the two parts so that each contributes about half of a typical first gain.
  const covGain = (j: number) => concepts[j].reduce((s, c) => s + (covered.has(c) ? 0 : cw(c)), 0);
  const facGain = (j: number) => rev[j].reduce((s, [i, x]) => s + (x > best[i] ? x - best[i] : 0), 0);
  const covScale = range(U).reduce((s, j) => s + covGain(j), 0) / U || 1;
  const facScale = range(U).reduce((s, j) => s + facGain(j), 0) / U || 1;
  const prior = (j: number) => 0.75 + 0.5 * recency(p, j);
  const chosen = lazyGreedy(
    U,
    (j) => p.cost[j],
    (j) => prior(j) * (covGain(j) / covScale + facGain(j) / facScale),
    (j) => {
      for (const c of concepts[j]) covered.add(c);
      for (const [i, x] of rev[j]) if (x > best[i]) best[i] = x;
    },
    budget * 0.94,
  );
  return renderUnits(p, fillBudget(p, chosen, budget));
};

/** Semantic near-duplicates (cosine ≥ 0.92 with a later unit) removed before concept coverage. */
export function semanticDuplicates(p: Prepared, e: Embeddings, threshold = 0.92): Set<number> {
  const drop = new Set<number>();
  for (let i = 0; i < p.units.length; i++)
    for (let r = 0; r < e.k; r++) {
      const j = e.knnIdx[i * e.k + r];
      if (j > i && e.knnSim[i * e.k + r] >= threshold && p.units[i].kind === p.units[j].kind) {
        drop.add(i);
        break;
      }
    }
  return drop;
}

export const semDedupeCoverage: Algorithm = (p, budget, idf: Idf) => {
  const e = embeddings(labContext.ci);
  if (!e) return fallback(p, budget, idf);
  const drop = semanticDuplicates(p, e);
  const keep = range(p.units.length).filter((i) => !drop.has(i));
  const view: Prepared = {
    ...p,
    units: keep.map((i) => p.units[i]),
    terms: keep.map((i) => p.terms[i]),
    cost: keep.map((i) => p.cost[i]),
    msgStart: p.msgStart.map((s) => keep.findIndex((i) => i >= s)).map((x) => (x < 0 ? keep.length : x)),
  };
  return renderUnits(view, coverageSelect(view, idf, budget));
};

/** An external compressor's output (e.g. LLMLingua-2), or an empty string when it was not run. */
export const external =
  (name: string): Algorithm =>
  () =>
    externalOutput(name) ?? '';
