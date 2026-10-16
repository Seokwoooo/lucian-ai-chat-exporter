// MinHash over character 5-gram shingles with LSH banding: finds near-duplicate paragraphs and
// code blocks (re-pasted outputs, slightly edited code versions) in roughly linear time.

export const NUM_HASHES = 32;
const BANDS = 8;
const ROWS = NUM_HASHES / BANDS;
const SHINGLE = 5;

// Fixed odd multipliers / offsets for the universal hash family h_i(x) = (a_i * x + b_i) mod 2^32.
const A = new Uint32Array(NUM_HASHES);
const B = new Uint32Array(NUM_HASHES);
{
  let s = 0x9e3779b9;
  const next = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return s >>> 0;
  };
  for (let i = 0; i < NUM_HASHES; i++) {
    A[i] = next() | 1;
    B[i] = next();
  }
}

/** Computes a MinHash signature. Long inputs are sampled so cost stays bounded per unit. */
export function minhash(text: string): Uint32Array {
  const sig = new Uint32Array(NUM_HASHES).fill(0xffffffff);
  const n = text.length;
  if (n < SHINGLE) {
    const h = shingleHash(text, 0, n);
    for (let i = 0; i < NUM_HASHES; i++) sig[i] = (Math.imul(A[i], h) + B[i]) >>> 0;
    return sig;
  }
  const step = n > 20000 ? Math.ceil(n / 20000) : 1;
  for (let p = 0; p + SHINGLE <= n; p += step) {
    const h = shingleHash(text, p, p + SHINGLE);
    for (let i = 0; i < NUM_HASHES; i++) {
      const v = (Math.imul(A[i], h) + B[i]) >>> 0;
      if (v < sig[i]) sig[i] = v;
    }
  }
  return sig;
}

function shingleHash(text: string, from: number, to: number): number {
  let h = 0x811c9dc5;
  for (let i = from; i < to; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function similarity(a: Uint32Array, b: Uint32Array): number {
  let eq = 0;
  for (let i = 0; i < NUM_HASHES; i++) if (a[i] === b[i]) eq++;
  return eq / NUM_HASHES;
}

/**
 * Groups items whose estimated Jaccard similarity is >= threshold. Returns for each item the
 * index of its cluster representative (the item itself when unique). Only LSH candidates are
 * compared, so the cost is close to linear.
 */
export function clusterNearDuplicates(sigs: Array<Uint32Array | undefined>, groupKey: (i: number) => string, threshold = 0.7): Int32Array {
  const parent = new Int32Array(sigs.length);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < sigs.length; i++) {
    const s = sigs[i];
    if (!s) continue;
    const g = groupKey(i);
    for (let b = 0; b < BANDS; b++) {
      let key = `${g}|${b}|`;
      for (let r = 0; r < ROWS; r++) key += s[b * ROWS + r].toString(36) + ',';
      const list = buckets.get(key);
      if (list) {
        if (list.length < 64) {
          for (const j of list) {
            if (find(i) !== find(j) && similarity(s, sigs[j]!) >= threshold) parent[find(i)] = find(j);
          }
          list.push(i);
        }
      } else {
        buckets.set(key, [i]);
      }
    }
  }
  for (let i = 0; i < parent.length; i++) parent[i] = find(i);
  return parent;
}
