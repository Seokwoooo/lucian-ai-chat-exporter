// Compression lab — lossless and near-lossless reductions, measured before any selection.
//   exact     : a unit whose normalized text appears again later (≥ 30 chars) adds nothing.
//   code      : a code block that a later block of the same language rewrites (≥ 60% shared lines)
//               is an older version; the final version keeps the current state.
//   near      : a prose unit sharing ≥ 80% of its content words with a later unit of similar size.
// The latest copy is the one kept (it is the current state and the most likely to be selected).
// Every reduction keeps at least one verbatim copy of the information it removes, except "code",
// which drops superseded versions (history, not state).

import type { Prepared } from './prepare';
import { renderUnits } from './prepare';
import { estimateTokens } from '../../src/shared/util';

export interface LosslessStats {
  sourceTokens: number;
  /** Tokens of the full transcript in the shared rendering. */
  full: number;
  afterExact: number;
  afterCode: number;
  afterNear: number;
}

const lineSet = (text: string) => new Set(text.split('\n').map((l) => l.trim()).filter((l) => l.length > 2));

/** Units that remain after each reduction tier (cumulative). */
export function reductionMasks(p: Prepared): { exact: boolean[]; code: boolean[]; near: boolean[] } {
  const U = p.units.length;
  const exact = new Array<boolean>(U).fill(true);
  const seen = new Set<number>();
  for (let i = U - 1; i >= 0; i--) {
    const u = p.units[i];
    if (u.text.length < 30) continue;
    if (seen.has(u.key)) exact[i] = false;
    else seen.add(u.key);
  }

  const code = exact.slice();
  const blocks = p.units.map((u, i) => (u.kind === 'code' && exact[i] ? i : -1)).filter((i) => i >= 0);
  const sets = new Map(blocks.map((i) => [i, lineSet(p.units[i].text)]));
  for (let a = 0; a < blocks.length; a++) {
    const ia = blocks[a];
    const A = sets.get(ia)!;
    if (A.size < 3) continue;
    for (let b = a + 1; b < blocks.length && b < a + 60; b++) {
      const ib = blocks[b];
      if ((p.units[ia].lang ?? '') !== (p.units[ib].lang ?? '')) continue;
      const B = sets.get(ib)!;
      let shared = 0;
      for (const l of A) if (B.has(l)) shared++;
      if (shared / A.size >= 0.6) {
        code[ia] = false;
        break;
      }
    }
  }

  const near = code.slice();
  const post = new Map<string, number[]>();
  const size = new Map<number, number>();
  for (let i = U - 1; i >= 0; i--) {
    if (!near[i]) continue;
    const u = p.units[i];
    const terms = [...new Set(p.terms[i])];
    size.set(i, terms.length);
    if (u.kind !== 'code' && terms.length >= 8) {
      const overlap = new Map<number, number>();
      for (const t of terms) for (const j of post.get(t) ?? []) overlap.set(j, (overlap.get(j) ?? 0) + 1);
      for (const [j, c] of overlap)
        if (c / Math.max(terms.length, size.get(j)!) >= 0.8) {
          near[i] = false;
          break;
        }
    }
    if (near[i] && u.kind !== 'code')
      for (const t of terms) {
        const l = post.get(t);
        if (!l) post.set(t, [i]);
        else if (l.length < 200) l.push(i);
      }
  }
  return { exact, code, near };
}

export function losslessStats(p: Prepared): LosslessStats {
  const all = p.units.map((_, i) => i);
  const m = reductionMasks(p);
  const tok = (mask: boolean[]) => estimateTokens(renderUnits(p, all.filter((i) => mask[i])));
  return { sourceTokens: p.sourceTokens, full: estimateTokens(renderUnits(p, all)), afterExact: tok(m.exact), afterCode: tok(m.code), afterNear: tok(m.near) };
}

const reducedCache = new WeakMap<Prepared, Prepared>();

/** The conversation after all three reductions, as a Prepared view (unit order and messages kept). */
export function reduced(p: Prepared): Prepared {
  const hit = reducedCache.get(p);
  if (hit) return hit;
  const keep = reductionMasks(p).near;
  const idx = p.units.map((_, i) => i).filter((i) => keep[i]);
  const units = idx.map((i) => p.units[i]);
  const msgStart: number[] = [];
  let k = 0;
  for (let m = 0; m < p.conv.messages.length; m++) {
    while (k < units.length && units[k].m < m) k++;
    msgStart.push(k);
  }
  msgStart.push(units.length);
  const out: Prepared = { conv: p.conv, units, terms: idx.map((i) => p.terms[i]), cost: idx.map((i) => p.cost[i]), msgStart, sourceTokens: p.sourceTokens };
  reducedCache.set(p, out);
  return out;
}
