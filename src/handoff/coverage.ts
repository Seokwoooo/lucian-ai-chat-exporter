// Budgeted maximum coverage (Khuller, Moss & Naor 1999; the concept model of Gillick & Favre
// 2009), solved with the lazy greedy algorithm (Minoux; "CELF"). Picks verbatim units that cover
// the most weighted distinct concepts per token, so repeated explanations add nothing and rare,
// specific information is kept. Deterministic, no model, O(n log n) in practice.

export interface CoverItem {
  id: number;
  /** Distinct concepts (content words, word pairs) the unit mentions. */
  concepts: string[];
  /** Token cost of emitting the unit. */
  cost: number;
  /** Multiplier for the unit's gain (recency, role…). */
  prior: number;
}

/** Content words plus adjacent word pairs. */
export function conceptsOf(terms: string[]): string[] {
  const out = new Set(terms);
  for (let k = 0; k + 1 < terms.length; k++) out.add(`${terms[k]} ${terms[k + 1]}`);
  return [...out];
}

class MaxHeap {
  private g: number[] = [];
  private v: number[] = [];
  get size(): number {
    return this.g.length;
  }
  peekGain(): number {
    return this.g[0];
  }
  push(gain: number, value: number): void {
    this.g.push(gain);
    this.v.push(value);
    let i = this.g.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.g[p] >= this.g[i]) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): [number, number] {
    const top: [number, number] = [this.g[0], this.v[0]];
    const lastG = this.g.pop()!;
    const lastV = this.v.pop()!;
    if (this.g.length) {
      this.g[0] = lastG;
      this.v[0] = lastV;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.g.length && this.g[l] > this.g[m]) m = l;
        if (r < this.g.length && this.g[r] > this.g[m]) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
  private swap(a: number, b: number): void {
    [this.g[a], this.g[b]] = [this.g[b], this.g[a]];
    [this.v[a], this.v[b]] = [this.v[b], this.v[a]];
  }
}

export interface CoverHooks {
  /**
   * Current cost of an item, when it can drop as other items are chosen (an excerpt chained with
   * the sentence before it costs less once that sentence is in the document).
   */
  cost?: (it: CoverItem) => number;
  /** Called for each chosen item, in selection order. */
  onChoose?: (it: CoverItem) => void;
}

/**
 * Lazy greedy budgeted coverage. Returns the chosen item ids in selection order. A unit's gain
 * can only shrink as more concepts are covered, so a stale heap value is an upper bound (with
 * dynamic costs it is an estimate: the gain is recomputed with the current cost on every pop).
 */
export function greedyCoverage(items: CoverItem[], weight: (concept: string) => number, budget: number, covered: Set<string> = new Set(), hooks: CoverHooks = {}): number[] {
  const costOf = (it: CoverItem) => (hooks.cost ? hooks.cost(it) : it.cost);
  const w = new Map<string, number>();
  const wOf = (c: string) => {
    let x = w.get(c);
    if (x == null) {
      x = weight(c);
      w.set(c, x);
    }
    return x;
  };
  const gain = (it: CoverItem) => {
    let g = 0;
    for (const c of it.concepts) if (!covered.has(c)) g += wOf(c);
    return (g * it.prior) / Math.pow(Math.max(1, costOf(it)), 0.9);
  };
  const heap = new MaxHeap();
  items.forEach((it, k) => heap.push(gain(it), k));
  const chosen: number[] = [];
  let remaining = budget;
  while (heap.size && remaining > 0) {
    const [, k] = heap.pop();
    const it = items[k];
    const cost = costOf(it);
    if (cost > remaining) continue;
    const fresh = gain(it);
    if (fresh <= 0) continue;
    if (heap.size && fresh < heap.peekGain()) {
      heap.push(fresh, k);
      continue;
    }
    chosen.push(it.id);
    remaining -= cost;
    for (const c of it.concepts) covered.add(c);
    hooks.onChoose?.(it);
  }
  return chosen;
}
