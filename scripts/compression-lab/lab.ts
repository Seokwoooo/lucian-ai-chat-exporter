// Compression lab — runner. Every algorithm gets the same token budget per conversation and
// budget level; outputs are scored against metrics computed from the source alone.

import type { Conversation } from '../../src/shared/types';
import { handoffBudget } from '../../src/handoff/engine';
import { ALGORITHMS } from './algorithms';
import { labContext } from './ext';
import { losslessStats, type LosslessStats } from './lossless';
import { buildGold, score, type Scores } from './metrics';
import { corpusIdf, prepare } from './prepare';

export interface LabRow {
  conv: number;
  sourceTokens: number;
  messages: number;
  ratio: number;
  budget: number;
  algo: string;
  ms: number;
  scores: Scores;
}

export interface LabSummary {
  conversations: number;
  ratios: number[];
  /** ratio → algorithm → mean scores (+ mean runtime) */
  means: Record<string, Record<string, Scores & { ms: number; wins: number }>>;
}

export interface LabOptions {
  /** Budget levels as a share of the source; 0 = the engine's own default budget. */
  ratios?: number[];
  minTokens?: number;
  algorithms?: string[];
  onProgress?: (done: number, total: number) => void;
  keepOutputs?: (key: string, text: string) => void;
}

const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export async function runLab(convs: Conversation[], opts: LabOptions = {}): Promise<{ rows: LabRow[]; summary: LabSummary; lossless: LosslessStats[] }> {
  const ratios = opts.ratios ?? [0.05, 0.1, 0.2];
  const names = opts.algorithms ?? Object.keys(ALGORITHMS);
  const prepared = convs.map(prepare).filter((p) => p.sourceTokens >= (opts.minTokens ?? 12_000));
  const idf = corpusIdf(prepared);
  const rows: LabRow[] = [];
  const total = prepared.length * ratios.length;
  let done = 0;
  const lossless: LosslessStats[] = [];
  for (const [ci, p] of prepared.entries()) {
    const gold = buildGold(p, idf);
    lossless.push(losslessStats(p));
    for (const ratio of ratios) {
      const target = ratio === 0 ? handoffBudget(p.sourceTokens) : Math.round(Math.min(200_000, Math.max(1_500, p.sourceTokens * ratio)));
      // Every algorithm gets the same budget. The engine has fixed parts (guide, latest messages)
      // and can exceed very small budgets; the tokens column shows what each one really used.
      const budget = target;
      labContext.ci = ci;
      labContext.ratio = ratio;
      for (const name of names) {
        const t0 = clock();
        const out = ALGORITHMS[name](p, budget, idf);
        const ms = clock() - t0;
        if (!out && name.startsWith('ext:')) continue; // external compressor not run for this level
        rows.push({ conv: ci, sourceTokens: p.sourceTokens, messages: p.conv.messages.length, ratio, budget, algo: name, ms, scores: score(out, gold) });
        opts.keepOutputs?.(`${ci}:${ratio}:${name}`, out);
        await new Promise((r) => setTimeout(r, 0));
      }
      opts.onProgress?.(++done, total);
    }
  }
  return { rows, summary: summarize(rows, ratios, prepared.length), lossless };
}

export function summarize(rows: LabRow[], ratios: number[], conversations: number): LabSummary {
  const means: LabSummary['means'] = {};
  for (const ratio of ratios) {
    const at = rows.filter((r) => r.ratio === ratio);
    const byAlgo = new Map<string, LabRow[]>();
    for (const r of at) byAlgo.set(r.algo, [...(byAlgo.get(r.algo) ?? []), r]);
    const wins = new Map<string, number>();
    for (const c of new Set(at.map((r) => r.conv))) {
      const best = at.filter((r) => r.conv === c).sort((a, b) => b.scores.composite - a.scores.composite)[0];
      if (best) wins.set(best.algo, (wins.get(best.algo) ?? 0) + 1);
    }
    means[String(ratio)] = {};
    for (const [algo, list] of byAlgo) {
      const avg = (f: (s: Scores) => number) => list.reduce((s, r) => s + f(r.scores), 0) / list.length;
      means[String(ratio)][algo] = {
        fact: avg((s) => s.fact),
        keyTerms: avg((s) => s.keyTerms),
        user: avg((s) => s.user),
        entities: avg((s) => s.entities),
        recent: avg((s) => s.recent),
        redundancy: avg((s) => s.redundancy),
        dangling: avg((s) => s.dangling),
        tokens: avg((s) => s.tokens),
        composite: avg((s) => s.composite),
        ms: list.reduce((s, r) => s + r.ms, 0) / list.length,
        wins: wins.get(algo) ?? 0,
      };
    }
  }
  return { conversations, ratios, means };
}

/** Plain-text table of the summary (one block per budget level, sorted by composite score). */
export function formatSummary(s: LabSummary): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}`.padStart(5);
  const out: string[] = [`conversations: ${s.conversations}`];
  for (const ratio of s.ratios) {
    out.push(ratio === 0 ? '\n== default handoff budget (12% of source, 8k–32k) ==' : `\n== budget ≈ ${ratio * 100}% of source ==`);
    out.push('algorithm             composite  fact  terms  user  ents  recent  dup  dangl   tokens   ms   wins');
    const entries = Object.entries(s.means[String(ratio)] ?? {}).sort((a, b) => b[1].composite - a[1].composite);
    for (const [name, m] of entries) {
      out.push(
        `${name.padEnd(21)} ${pct(m.composite)}    ${pct(m.fact)} ${pct(m.keyTerms)} ${pct(m.user)} ${pct(m.entities)} ${pct(m.recent)}  ${pct(m.redundancy)} ${pct(m.dangling)} ${String(Math.round(m.tokens)).padStart(7)} ${String(Math.round(m.ms)).padStart(5)} ${String(m.wins).padStart(5)}`,
      );
    }
  }
  return out.join('\n');
}

/** Plain-text summary of the lossless / near-lossless reductions over all conversations. */
export function formatLossless(list: LosslessStats[]): string {
  if (!list.length) return '';
  const sum = (f: (s: LosslessStats) => number) => list.reduce((a, x) => a + f(x), 0);
  const full = sum((s) => s.full);
  const pct = (a: number) => `-${((1 - a / full) * 100).toFixed(1)}%`;
  const per = list.map((s) => 1 - s.afterNear / s.full).sort((a, b) => a - b);
  return [
    `\n== lossless / near-lossless reductions (${list.length} conversations, ${full} tokens) ==`,
    `exact duplicates     ${pct(sum((s) => s.afterExact))}`,
    `+ superseded code    ${pct(sum((s) => s.afterCode))}`,
    `+ near duplicates    ${pct(sum((s) => s.afterNear))}`,
    `per conversation: median -${(per[Math.floor(per.length / 2)] * 100).toFixed(1)}%, max -${(per[per.length - 1] * 100).toFixed(1)}%`,
  ].join('\n');
}
