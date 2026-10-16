// Compression lab — data produced outside TypeScript (Python, local models): unit embeddings and
// their nearest neighbors (EmbeddingGemma 2), and outputs of external compressors (LLMLingua-2).
// Files live in LAB_EXT_DIR, keyed by the conversation's index in the lab run.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const labContext = { ci: -1, ratio: 0, extDir: process.env.LAB_EXT_DIR ?? '' };

export interface Embeddings {
  dim: number;
  /** Row-major, L2-normalized. */
  vec: Float32Array;
  /** Top-k neighbors per unit (cosine), excluding the unit itself. */
  knnIdx: Int32Array;
  knnSim: Float32Array;
  k: number;
}

const cache = new Map<number, Embeddings | null>();

function readArray(path: string): ArrayBuffer {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

/** Embeddings for conversation `ci`, written by scripts/compression-lab/py/embed.py. */
export function embeddings(ci: number): Embeddings | null {
  if (cache.has(ci)) return cache.get(ci)!;
  const base = join(labContext.extDir, 'emb', `c${ci}`);
  let e: Embeddings | null = null;
  if (labContext.extDir && existsSync(`${base}.json`)) {
    const meta = JSON.parse(readFileSync(`${base}.json`, 'utf8')) as { dim: number; k: number };
    e = {
      dim: meta.dim,
      k: meta.k,
      vec: new Float32Array(readArray(`${base}.vec.f32`)),
      knnIdx: new Int32Array(readArray(`${base}.knn.i32`)),
      knnSim: new Float32Array(readArray(`${base}.knn.f32`)),
    };
  }
  cache.clear(); // one conversation at a time keeps memory flat
  cache.set(ci, e);
  return e;
}

/** Output of an external compressor for the current conversation and budget level, if present. */
export function externalOutput(name: string): string | null {
  const f = join(labContext.extDir, name, `c${labContext.ci}_${labContext.ratio}.md`);
  return labContext.extDir && existsSync(f) ? readFileSync(f, 'utf8') : null;
}
