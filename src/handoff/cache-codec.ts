// Packs the handoff analysis cache into typed arrays for IndexedDB (compact, structured-clone fast).

import type { HandoffCacheRecord } from '../shared/db';
import type { CacheMap } from './engine';
import { NUM_HASHES } from './minhash';

export const CACHE_VERSION = 3;
const MAX_ENTRIES = 400_000;

export function encodeCache(key: string, cache: CacheMap): HandoffCacheRecord {
  const entries = [...cache.entries()].slice(-MAX_ENTRIES);
  const n = entries.length;
  const keys = new Float64Array(n);
  const flags = new Uint32Array(n);
  const hasSig = new Uint8Array(n);
  const sigs = new Uint32Array(n * NUM_HASHES);
  entries.forEach(([k, v], i) => {
    keys[i] = k;
    flags[i] = v.flags;
    if (v.sig) {
      hasSig[i] = 1;
      sigs.set(v.sig, i * NUM_HASHES);
    }
  });
  return { key, version: CACHE_VERSION, updatedAt: Date.now(), keys, flags, hasSig, sigs };
}

export function decodeCache(rec: HandoffCacheRecord | undefined): CacheMap {
  const cache: CacheMap = new Map();
  if (!rec || rec.version !== CACHE_VERSION) return cache;
  for (let i = 0; i < rec.keys.length; i++) {
    cache.set(rec.keys[i], {
      flags: rec.flags[i],
      sig: rec.hasSig[i] ? rec.sigs.slice(i * NUM_HASHES, (i + 1) * NUM_HASHES) : undefined,
    });
  }
  return cache;
}
