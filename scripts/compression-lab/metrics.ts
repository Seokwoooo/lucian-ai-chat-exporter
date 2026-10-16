// Compression lab — information-retention metrics. They are computed from the source conversation
// alone (independent of any algorithm) and compare it with an output text. No model is involved,
// so they measure retention of words, entities and sentences — not paraphrased meaning.

import { extractPaths, topicTokens } from '../../src/handoff/patterns';
import { estimateTokens, urlKey } from '../../src/shared/util';
import type { Idf, Prepared } from './prepare';

export interface Gold {
  keyTerms: Map<string, number>;
  userTerms: Map<string, number>;
  recentTerms: Map<string, number>;
  entities: Set<string>;
  probes: string[][];
}

export interface Scores {
  /** Share of fact probes (sentences sampled across the whole conversation) kept nearly verbatim. */
  fact: number;
  /** Weighted recall of the conversation's top TF-IDF terms. */
  keyTerms: number;
  /** Weighted recall of the words the user wrote (requests, constraints, decisions). */
  user: number;
  /** Recall of entities: URLs, paths, identifiers, numbers with units, versions. */
  entities: number;
  /** Weighted recall of the last four messages' words (current state). */
  recent: number;
  /** Share of duplicated lines in the output (lower is better). */
  redundancy: number;
  tokens: number;
  /** 0.3 fact + 0.25 key terms + 0.2 user + 0.15 entities + 0.1 recent. */
  composite: number;
}

const URL_RE = /https?:\/\/[^\s<>()"'`\]]+[^\s<>()"'`\].,;:!?]/g;
const IDENT_RE = /`([^`\n]{2,60})`|\b[a-z]+[A-Z][A-Za-z0-9]+\b|\b[a-z][a-z0-9]*_[a-z0-9_]+\b|\b[A-Z][A-Z0-9_]{2,}\b/g;
const NUM_RE = /\b\d+(?:[.,]\d+)+\b|\b\d{2,}(?:\s?(?:%|ms|s|초|분|시간|일|개|원|만|억|MB|GB|KB|px|k|K|M|토큰|tokens?))?/g;

/** Entities of a text, normalized for comparison. */
export function entitiesOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const u of text.match(URL_RE) ?? []) out.add(`url:${urlKey(u)}`);
  const noUrl = text.replace(URL_RE, ' ');
  for (const p of extractPaths(noUrl)) out.add(`path:${p}`);
  for (const m of noUrl.matchAll(IDENT_RE)) out.add(`id:${(m[1] ?? m[0]).trim()}`);
  for (const m of noUrl.matchAll(NUM_RE)) out.add(`num:${m[0].replace(/\s+/g, '')}`);
  return out;
}

function weighted(terms: Iterable<string>, idf: Idf): Map<string, number> {
  const w = new Map<string, number>();
  for (const t of terms) w.set(t, (w.get(t) ?? 0) + idf(t));
  return w;
}

/** Deterministic, evenly spaced sample of fact-bearing sentences across the conversation. */
function sampleProbes(p: Prepared, count: number): string[][] {
  const eligible: number[] = [];
  p.units.forEach((u, i) => {
    if (u.kind === 'code' || u.kind === 'heading' || u.kind === 'attachment') return;
    if (p.terms[i].length < 5) return;
    const hasFact = entitiesOf(u.text).size > 0 || p.terms[i].length >= 8;
    if (hasFact) eligible.push(i);
  });
  if (!eligible.length) return [];
  const step = eligible.length / Math.min(count, eligible.length);
  const out: string[][] = [];
  for (let k = 0; k < Math.min(count, eligible.length); k++) out.push([...new Set(p.terms[eligible[Math.floor(k * step + step / 2)]])]);
  return out;
}

export function buildGold(p: Prepared, idf: Idf): Gold {
  const tf = new Map<string, number>();
  for (const ts of p.terms) for (const t of ts) tf.set(t, (tf.get(t) ?? 0) + 1);
  const key = [...tf.entries()]
    .map(([t, n]) => [t, n * idf(t)] as [string, number])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 300);
  const userTerms: string[] = [];
  const recentTerms: string[] = [];
  const entities = new Set<string>();
  const N = p.conv.messages.length;
  p.units.forEach((u, i) => {
    if (u.role === 'user' && u.kind !== 'code') userTerms.push(...p.terms[i]);
    if (u.m >= N - 4) recentTerms.push(...p.terms[i]);
    if (u.kind !== 'code') for (const e of entitiesOf(u.text)) entities.add(e);
  });
  return {
    keyTerms: new Map(key),
    userTerms: weighted(new Set(userTerms), idf),
    recentTerms: weighted(new Set(recentTerms), idf),
    entities,
    probes: sampleProbes(p, 40),
  };
}

function recall(w: Map<string, number>, present: Set<string>): number {
  let tot = 0;
  let hit = 0;
  for (const [t, x] of w) {
    tot += x;
    if (present.has(t)) hit += x;
  }
  return tot ? hit / tot : 1;
}

export function score(output: string, gold: Gold): Scores {
  const lines = output
    .split(/\n|(?<=[.!?。])\s+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const lineTerms = lines.map((l) => new Set(topicTokens(l)));
  const present = new Set<string>();
  for (const s of lineTerms) for (const t of s) present.add(t);
  const index = new Map<string, number[]>();
  lineTerms.forEach((s, li) => {
    for (const t of s) {
      const l = index.get(t);
      if (l) l.push(li);
      else index.set(t, [li]);
    }
  });
  // A probe counts as kept when one output line contains at least 60% of its words.
  let factHit = 0;
  for (const probe of gold.probes) {
    const count = new Map<number, number>();
    for (const t of probe) for (const li of index.get(t) ?? []) count.set(li, (count.get(li) ?? 0) + 1);
    let best = 0;
    for (const c of count.values()) best = Math.max(best, c);
    if (best / probe.length >= 0.6) factHit++;
  }
  const outEntities = entitiesOf(output);
  let entHit = 0;
  for (const e of gold.entities) if (outEntities.has(e)) entHit++;
  const longLines = lines.filter((l) => l.length >= 20);
  const redundancy = longLines.length ? 1 - new Set(longLines).size / longLines.length : 0;
  const s = {
    fact: gold.probes.length ? factHit / gold.probes.length : 1,
    keyTerms: recall(gold.keyTerms, present),
    user: recall(gold.userTerms, present),
    entities: gold.entities.size ? entHit / gold.entities.size : 1,
    recent: recall(gold.recentTerms, present),
    redundancy,
    tokens: estimateTokens(output),
  };
  return { ...s, composite: 0.3 * s.fact + 0.25 * s.keyTerms + 0.2 * s.user + 0.15 * s.entities + 0.1 * s.recent };
}
