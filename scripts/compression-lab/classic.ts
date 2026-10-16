// Compression lab — more model-free algorithms: classic extractive summarizers (KL-Sum, SumBasic,
// LSA, centroid, submodular coverage + diversity, facility location), an information-content
// ranking in the spirit of Selective Context (with a corpus n-gram model instead of GPT-2), a chat
// adaptation of CliffCompaction (truncate/drop only), and referential repair for "dangling"
// sentences. All select verbatim units and render them with the shared renderer.

import type { Algorithm } from './algorithms';
import { ANAPHOR_RE } from '../../src/handoff/patterns';
import { fillBudget, renderUnits, type Idf, type Prepared } from './prepare';

const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const recency = (p: Prepared, i: number) => p.units[i].m / Math.max(1, p.conv.messages.length - 1);
const eligible = (p: Prepared, i: number) => p.terms[i].length > 0;

function termCounts(p: Prepared, units: Iterable<number>): Map<string, number> {
  const tf = new Map<string, number>();
  for (const i of units) for (const t of p.terms[i]) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

// ---------- KL-Sum (Haghighi & Vanderwende 2009) ----------

/** Greedily adds the unit that brings the summary's word distribution closest to the source's. */
export const klsum: Algorithm = (p, budget) => {
  const U = p.units.length;
  const src = termCounts(p, range(U));
  let total = 0;
  for (const n of src.values()) total += n;
  const P = (t: string) => (src.get(t) ?? 0) / total;
  const sum = new Map<string, number>();
  let sumTotal = 0;
  const vocab = [...src.keys()].sort((a, b) => src.get(b)! - src.get(a)!).slice(0, 1500);
  const kl = (extra: string[]) => {
    const add = new Map<string, number>();
    for (const t of extra) add.set(t, (add.get(t) ?? 0) + 1);
    const tot = sumTotal + extra.length;
    let d = 0;
    for (const t of vocab) {
      const q = ((sum.get(t) ?? 0) + (add.get(t) ?? 0) + 0.01) / (tot + 0.01 * vocab.length);
      const pt = P(t);
      if (pt > 0) d += pt * Math.log(pt / q);
    }
    return d;
  };
  // Candidate pool: the 400 most term-dense units (KL over the whole set is quadratic).
  const pool = range(U)
    .filter((i) => eligible(p, i))
    .sort((a, b) => p.terms[b].length / Math.sqrt(p.cost[b] + 1) - p.terms[a].length / Math.sqrt(p.cost[a] + 1))
    .slice(0, 400);
  const chosen: number[] = [];
  let used = 0;
  const left = new Set(pool);
  while (left.size && used < budget * 0.94) {
    let best = -1;
    let bestD = Infinity;
    for (const i of left) {
      if (used + p.cost[i] > budget * 0.94) continue;
      const d = kl(p.terms[i]) * Math.pow(p.cost[i] + 1, 0.1);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best < 0) break;
    left.delete(best);
    chosen.push(best);
    used += p.cost[best];
    for (const t of p.terms[best]) sum.set(t, (sum.get(t) ?? 0) + 1);
    sumTotal += p.terms[best].length;
  }
  return renderUnits(p, fillBudget(p, chosen, budget));
};

// ---------- SumBasic (Nenkova & Vanderwende 2005) ----------

/** Picks units with high average word probability, then squares the probabilities of used words. */
export const sumbasic: Algorithm = (p, budget) => {
  const U = p.units.length;
  const tf = termCounts(p, range(U));
  let total = 0;
  for (const n of tf.values()) total += n;
  const prob = new Map([...tf].map(([t, n]) => [t, n / total]));
  const avg = (i: number) => p.terms[i].reduce((s, t) => s + (prob.get(t) ?? 0), 0) / Math.max(1, p.terms[i].length);
  const chosen = new Set<number>();
  let used = 0;
  while (used < budget * 0.94) {
    // The most probable word must be covered next (as in the original algorithm).
    let topWord = '';
    let topP = 0;
    for (const [t, pr] of prob)
      if (pr > topP) {
        topP = pr;
        topWord = t;
      }
    if (!topWord) break;
    let best = -1;
    let bestS = -1;
    for (let i = 0; i < U; i++) {
      if (chosen.has(i) || used + p.cost[i] > budget * 0.94 || !p.terms[i].includes(topWord)) continue;
      const s = avg(i);
      if (s > bestS) {
        bestS = s;
        best = i;
      }
    }
    if (best < 0) {
      prob.delete(topWord);
      continue;
    }
    chosen.add(best);
    used += p.cost[best];
    for (const t of new Set(p.terms[best])) prob.set(t, (prob.get(t) ?? 0) ** 2);
  }
  return renderUnits(p, fillBudget(p, chosen, budget));
};

// ---------- sparse similarity helpers ----------

/** L2-normalized TF-IDF vectors and a sparse neighbor list over shared distinctive terms. */
function sparseGraph(p: Prepared, idf: Idf, maxDf = 60): { vec: Array<Map<string, number>>; nbr: Array<Map<number, number>> } {
  const U = p.units.length;
  const vec = range(U).map((i) => {
    const v = new Map<string, number>();
    for (const t of p.terms[i]) v.set(t, (v.get(t) ?? 0) + idf(t));
    let n = 0;
    for (const w of v.values()) n += w * w;
    n = Math.sqrt(n) || 1;
    for (const [t, w] of v) v.set(t, w / n);
    return v;
  });
  const post = new Map<string, number[]>();
  vec.forEach((v, i) => {
    for (const t of v.keys()) {
      const l = post.get(t);
      if (l) l.push(i);
      else post.set(t, [i]);
    }
  });
  const nbr: Array<Map<number, number>> = range(U).map(() => new Map());
  for (const [t, list] of post) {
    if (list.length > maxDf) continue;
    for (const a of list)
      for (const b of list) {
        if (a === b) continue;
        nbr[a].set(b, (nbr[a].get(b) ?? 0) + vec[a].get(t)! * vec[b].get(t)!);
      }
  }
  for (let i = 0; i < U; i++) nbr[i].set(i, 1);
  return { vec, nbr };
}

// ---------- centroid (Radev et al. 2004) ----------

export const centroid: Algorithm = (p, budget, idf) => {
  const U = p.units.length;
  const c = new Map<string, number>();
  for (const [t, n] of termCounts(p, range(U))) c.set(t, n * idf(t));
  const top = new Map([...c].sort((a, b) => b[1] - a[1]).slice(0, 400));
  const score = range(U).map((i) => {
    let s = 0;
    for (const t of new Set(p.terms[i])) s += top.get(t) ?? 0;
    return s / Math.sqrt(p.cost[i] + 1);
  });
  // Skip near-copies of what is already chosen (redundancy threshold as in MEAD).
  const { vec } = sparseGraph(p, idf, 0);
  const chosen: number[] = [];
  let used = 0;
  for (const i of range(U).sort((a, b) => score[b] - score[a])) {
    if (used + p.cost[i] > budget * 0.94) continue;
    let dup = false;
    for (const j of chosen.slice(-200)) {
      let dot = 0;
      for (const [t, w] of vec[i]) dot += w * (vec[j].get(t) ?? 0);
      if (dot > 0.7) {
        dup = true;
        break;
      }
    }
    if (dup) continue;
    chosen.push(i);
    used += p.cost[i];
  }
  return renderUnits(p, fillBudget(p, [...chosen, ...range(U).sort((a, b) => score[b] - score[a])], budget));
};

// ---------- LSA (Steinberger & Ježek 2004) ----------

/** Units scored by their weight in the top latent topics (power iteration on the sparse matrix). */
export const lsa: Algorithm = (p, budget, idf) => {
  const U = p.units.length;
  const { vec } = sparseGraph(p, idf, 0);
  const k = 12;
  const sigmaV: number[][] = [];
  const deflate: Array<{ u: Map<string, number>; v: Float64Array; s: number }> = [];
  for (let r = 0; r < k; r++) {
    let v = new Float64Array(U).map((_, i) => ((i * 2654435761) % 1000) / 1000 + 0.01);
    let u = new Map<string, number>();
    let s = 0;
    for (let it = 0; it < 20; it++) {
      // u = A v (terms), minus previous components
      u = new Map();
      for (let i = 0; i < U; i++) if (v[i]) for (const [t, w] of vec[i]) u.set(t, (u.get(t) ?? 0) + w * v[i]);
      for (const d of deflate) {
        let dot = 0;
        for (let i = 0; i < U; i++) dot += d.v[i] * v[i];
        for (const [t, w] of d.u) u.set(t, (u.get(t) ?? 0) - d.s * w * dot);
      }
      let n = 0;
      for (const w of u.values()) n += w * w;
      n = Math.sqrt(n) || 1;
      for (const [t, w] of u) u.set(t, w / n);
      // v = A^T u
      const nv = new Float64Array(U);
      for (let i = 0; i < U; i++) {
        let x = 0;
        for (const [t, w] of vec[i]) x += w * (u.get(t) ?? 0);
        nv[i] = x;
      }
      for (const d of deflate) {
        let dot = 0;
        for (const [t, w] of d.u) dot += w * (u.get(t) ?? 0);
        for (let i = 0; i < U; i++) nv[i] -= d.s * d.v[i] * dot;
      }
      s = Math.sqrt(nv.reduce((a, x) => a + x * x, 0)) || 1;
      v = nv.map((x) => x / s);
    }
    deflate.push({ u, v, s });
    sigmaV.push(Array.from(v, (x) => x * s));
  }
  const score = range(U).map((i) => Math.sqrt(sigmaV.reduce((a, row) => a + row[i] * row[i], 0)) / Math.sqrt(p.cost[i] + 1));
  return renderUnits(p, fillBudget(p, range(U).sort((a, b) => score[b] - score[a]), budget));
};

// ---------- submodular: coverage + diversity (Lin & Bilmes 2011) ----------

/** Cost-scaled greedy for facility location (representativeness) with an optional diversity reward. */
function submodularSelect(p: Prepared, idf: Idf, budget: number, diversity: number): number[] {
  const U = p.units.length;
  const { nbr } = sparseGraph(p, idf);
  // Diversity clusters: units grouped by their most distinctive term.
  const cluster = range(U).map((i) => {
    let best = '';
    let bw = -1;
    for (const t of p.terms[i])
      if (idf(t) > bw) {
        bw = idf(t);
        best = t;
      }
    return best;
  });
  const reward = range(U).map((i) => {
    let s = 0;
    for (const w of nbr[i].values()) s += w;
    return s / U;
  });
  const best = new Float64Array(U); // current max similarity of each unit to the summary
  const clusterMass = new Map<string, number>();
  const gain = (j: number) => {
    let g = 0;
    for (const [i, w] of nbr[j]) if (w > best[i]) g += w - best[i];
    if (diversity) {
      const c = cluster[j];
      const m = clusterMass.get(c) ?? 0;
      g += diversity * (Math.sqrt(m + reward[j]) - Math.sqrt(m)) * U * 0.05;
    }
    return g / Math.pow(p.cost[j] + 1, 0.9);
  };
  const heap: Array<[number, number]> = range(U).map((j) => [gain(j), j]);
  heap.sort((a, b) => b[0] - a[0]);
  const chosen: number[] = [];
  let used = 0;
  // Lazy greedy with a sorted array (re-insert keeps it approximately ordered).
  while (heap.length && used < budget * 0.94) {
    const [, j] = heap.shift()!;
    if (used + p.cost[j] > budget * 0.94) continue;
    const g = gain(j);
    if (heap.length && g < heap[0][0]) {
      let lo = 0;
      let hi = heap.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (heap[mid][0] > g) lo = mid + 1;
        else hi = mid;
      }
      heap.splice(lo, 0, [g, j]);
      continue;
    }
    if (g <= 0) break;
    chosen.push(j);
    used += p.cost[j];
    for (const [i, w] of nbr[j]) if (w > best[i]) best[i] = w;
    clusterMass.set(cluster[j], (clusterMass.get(cluster[j]) ?? 0) + reward[j]);
  }
  return chosen;
}

export const facility: Algorithm = (p, budget, idf) => renderUnits(p, fillBudget(p, submodularSelect(p, idf, budget, 0), budget));
export const submodular: Algorithm = (p, budget, idf) => renderUnits(p, fillBudget(p, submodularSelect(p, idf, budget, 6), budget));

// ---------- information content (Selective Context without a neural LM) ----------

/** Self-information of each unit under a smoothed unigram+bigram model of the whole conversation. */
export const surprisal: Algorithm = (p, budget) => {
  const U = p.units.length;
  const uni = termCounts(p, range(U));
  const bi = new Map<string, number>();
  let total = 0;
  for (const n of uni.values()) total += n;
  for (const ts of p.terms) for (let k = 0; k + 1 < ts.length; k++) bi.set(`${ts[k]} ${ts[k + 1]}`, (bi.get(`${ts[k]} ${ts[k + 1]}`) ?? 0) + 1);
  const V = uni.size;
  const info = (i: number) => {
    const ts = p.terms[i];
    let s = 0;
    for (let k = 0; k < ts.length; k++) {
      const pu = ((uni.get(ts[k]) ?? 0) + 1) / (total + V);
      const pb = k ? ((bi.get(`${ts[k - 1]} ${ts[k]}`) ?? 0) + 0.5) / ((uni.get(ts[k - 1]) ?? 0) + 0.5 * V) : pu;
      s += -Math.log(0.6 * pb + 0.4 * pu);
    }
    return s;
  };
  const score = range(U).map((i) => (info(i) / (p.cost[i] + 2)) * (0.75 + 0.5 * recency(p, i)));
  // Redundancy filter: skip a unit whose words are mostly already selected twice.
  const seen = new Map<string, number>();
  const chosen: number[] = [];
  let used = 0;
  for (const i of range(U).sort((a, b) => score[b] - score[a])) {
    if (used + p.cost[i] > budget * 0.94) continue;
    const ts = [...new Set(p.terms[i])];
    if (ts.length >= 4 && ts.filter((t) => (seen.get(t) ?? 0) >= 2).length / ts.length > 0.7) continue;
    chosen.push(i);
    used += p.cost[i];
    for (const t of ts) seen.set(t, (seen.get(t) ?? 0) + 1);
  }
  // Budget left after the redundancy filter goes to the next most informative units.
  return renderUnits(p, fillBudget(p, [...chosen, ...range(U).sort((a, b) => score[b] - score[a])], budget));
};

// ---------- CliffCompaction adapted to chats (Nguyen et al. 2026) ----------

/**
 * Truncate/drop only: the first request and the latest K messages verbatim, older user messages
 * verbatim, older answers cut to their first N characters. K and N grow until the budget is used.
 */
export const cliff: Algorithm = (p, budget) => {
  const N = p.conv.messages.length;
  const firstUser = p.conv.messages.findIndex((m) => m.role === 'user');
  const msgUnits = (m: number) => range(p.msgStart[m + 1] - p.msgStart[m]).map((k) => p.msgStart[m] + k);
  const build = (K: number, chars: number) => {
    const out: number[] = [];
    for (let m = 0; m < N; m++) {
      const recentMsg = m >= N - K || m === firstUser;
      if (recentMsg || p.conv.messages[m].role === 'user') {
        out.push(...msgUnits(m));
        continue;
      }
      let c = 0;
      for (const i of msgUnits(m)) {
        if (c >= chars) break;
        out.push(i);
        c += p.units[i].text.length;
      }
    }
    return out;
  };
  const size = (sel: number[]) => sel.reduce((s, i) => s + p.cost[i], 0) + new Set(sel.map((i) => p.units[i].m)).size * 8;
  let K = 2;
  while (K < N && size(build(K + 1, 300)) <= budget) K++;
  let chars = 300;
  while (chars < 20000 && size(build(K, chars * 1.5)) <= budget) chars *= 1.5;
  // Over budget even at the minimum: keep the latest units of the selection that fit.
  const sel = build(K, chars);
  return renderUnits(p, fillBudget(p, [...sel].reverse(), budget));
};

// ---------- referential repair (after "Referential Dangling", 2026) ----------

/** Sentences that need the previous sentence to be understood (shared with the engine). */
export const ANAPHOR = ANAPHOR_RE;

/** Wraps a unit selector: selects at 92% of the budget, then adds missing antecedents. */
export function withRepair(select: (p: Prepared, idf: Idf, budget: number) => number[]): Algorithm {
  return (p, budget, idf) => {
    const chosen = new Set(select(p, idf, budget * 0.92));
    let used = [...chosen].reduce((s, i) => s + p.cost[i], 0) + new Set([...chosen].map((i) => p.units[i].m)).size * 8;
    for (const i of [...chosen].sort((a, b) => a - b)) {
      let j = i;
      // Walk back while the sentence still depends on the one before (at most 2 steps).
      for (let step = 0; step < 2 && ANAPHOR.test(p.units[j].text) && j > p.msgStart[p.units[j].m]; step++) {
        j--;
        if (chosen.has(j)) break;
        if (used + p.cost[j] > budget) break;
        chosen.add(j);
        used += p.cost[j];
      }
    }
    return renderUnits(p, fillBudget(p, chosen, budget));
  };
}

// ---------- concept coverage + facility location (model-free hybrid) ----------

/** Concept coverage plus TF-IDF facility location, both submodular; gains are scaled to match. */
export function hybridSelect(p: Prepared, idf: Idf, budget: number, facWeight = 1): number[] {
  const U = p.units.length;
  const { nbr } = sparseGraph(p, idf);
  const concepts = range(U).map((i) => {
    const out = new Set(p.terms[i]);
    for (let k = 0; k + 1 < p.terms[i].length; k++) out.add(`${p.terms[i][k]} ${p.terms[i][k + 1]}`);
    return [...out];
  });
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
  const covered = new Set<string>();
  const best = new Float64Array(U);
  const covGain = (j: number) => concepts[j].reduce((s, c) => s + (covered.has(c) ? 0 : cw(c)), 0);
  const facGain = (j: number) => {
    let s = 0;
    for (const [i, x] of nbr[j]) if (x > best[i]) s += x - best[i];
    return s;
  };
  const covScale = range(U).reduce((s, j) => s + covGain(j), 0) / U || 1;
  const facScale = range(U).reduce((s, j) => s + facGain(j), 0) / U || 1;
  const prior = (j: number) => 0.75 + 0.5 * recency(p, j);
  const gain = (j: number) => (prior(j) * (covGain(j) / covScale + (facWeight * facGain(j)) / facScale)) / Math.pow(p.cost[j] + 1, 0.9);
  const heap: Array<[number, number]> = range(U)
    .map((j) => [gain(j), j] as [number, number])
    .sort((a, b) => b[0] - a[0]);
  const chosen: number[] = [];
  let used = 0;
  while (heap.length && used < budget * 0.94) {
    const [, j] = heap.shift()!;
    if (used + p.cost[j] > budget * 0.94) continue;
    const g = gain(j);
    if (heap.length && g < heap[0][0]) {
      let lo = 0;
      let hi = heap.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (heap[mid][0] > g) lo = mid + 1;
        else hi = mid;
      }
      heap.splice(lo, 0, [g, j]);
      continue;
    }
    if (g <= 0) break;
    chosen.push(j);
    used += p.cost[j];
    for (const c of concepts[j]) covered.add(c);
    for (const [i, x] of nbr[j]) if (x > best[i]) best[i] = x;
  }
  return fillBudget(p, chosen, budget);
}

export const hybrid: Algorithm = (p, budget, idf) => renderUnits(p, hybridSelect(p, idf, budget));
export const hybridRepair: Algorithm = withRepair((p, idf, b) => hybridSelect(p, idf, b));
