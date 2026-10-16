// Compression lab — shared preparation: segments a conversation into units (same segmenter as
// the handoff engine), content terms per unit, token costs, and corpus-level IDF.

import type { Conversation } from '../../src/shared/types';
import { segmentMessage, type Unit } from '../../src/handoff/segment';
import { topicTokens } from '../../src/handoff/patterns';
import { estimateTokens } from '../../src/shared/util';

export interface Prepared {
  conv: Conversation;
  units: Unit[];
  /** Content terms (particles/stopwords removed) per unit. */
  terms: string[][];
  /** Token cost per unit (text as it would be emitted). */
  cost: number[];
  /** First unit index of each message (length = messages + 1). */
  msgStart: number[];
  sourceTokens: number;
}

export function prepare(conv: Conversation): Prepared {
  const units: Unit[] = [];
  const msgStart: number[] = [];
  let sourceTokens = 0;
  conv.messages.forEach((m, i) => {
    msgStart.push(units.length);
    segmentMessage(m, i, units);
    for (const c of m.contents) if (c.type !== 'thinking' && c.type !== 'sources') sourceTokens += estimateTokens(c.content ?? '');
  });
  msgStart.push(units.length);
  return {
    conv,
    units,
    terms: units.map((u) => (u.kind === 'code' ? topicTokens(u.text.slice(0, 4000)) : topicTokens(u.text))),
    cost: units.map((u) => estimateTokens(u.text) + (u.kind === 'code' ? 6 : 2)),
    msgStart,
    sourceTokens: Math.round(sourceTokens),
  };
}

export type Idf = (term: string) => number;

/** IDF over messages of the whole corpus: words common to every conversation weigh little. */
export function corpusIdf(all: Prepared[]): Idf {
  const df = new Map<string, number>();
  let docs = 0;
  for (const p of all) {
    for (let m = 0; m + 1 < p.msgStart.length; m++) {
      docs++;
      const seen = new Set<string>();
      for (let i = p.msgStart[m]; i < p.msgStart[m + 1]; i++) for (const t of p.terms[i]) seen.add(t);
      for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
    }
  }
  return (t) => Math.log((docs + 1) / ((df.get(t) ?? 0) + 1)) + 1;
}

/** Message-grouped rendering used by every extractive algorithm (same format → fair comparison). */
export function renderUnits(p: Prepared, selected: Iterable<number>): string {
  const sel = [...new Set(selected)].sort((a, b) => a - b);
  const out: string[] = [];
  let lastM = -1;
  for (const i of sel) {
    const u = p.units[i];
    if (u.m !== lastM) {
      out.push(`\n### [#m${u.m + 1}] ${u.role === 'user' ? 'User' : 'AI'}`);
      lastM = u.m;
    }
    if (u.kind === 'code') out.push(`\`\`\`${u.lang ?? ''}\n${u.text}\n\`\`\``);
    else if (u.kind === 'table') out.push(u.text);
    else out.push(u.kind === 'item' ? `- ${u.text}` : u.text);
  }
  return out.join('\n').trim();
}

/** Adds units in priority order while the rendered size stays within the budget. */
export function fillBudget(p: Prepared, order: Iterable<number>, budget: number, preselected: number[] = []): number[] {
  const chosen = new Set<number>(preselected);
  const msgs = new Set<number>(preselected.map((i) => p.units[i].m));
  let used = preselected.reduce((s, i) => s + p.cost[i], 0) + msgs.size * 8;
  for (const i of order) {
    if (chosen.has(i)) continue;
    const extra = p.cost[i] + (msgs.has(p.units[i].m) ? 0 : 8);
    if (used + extra > budget) continue;
    used += extra;
    chosen.add(i);
    msgs.add(p.units[i].m);
  }
  return [...chosen];
}
