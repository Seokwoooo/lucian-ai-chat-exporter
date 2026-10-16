// Handoff performance benchmark. Builds synthetic conversations of ~100k and ~1M tokens and
// measures each engine stage (cold run and incremental warm run with the analysis cache).

import os from 'node:os';
import { writeFileSync, mkdirSync } from 'node:fs';
import { runHandoff } from '../src/handoff/engine';
import { estimateTokens } from '../src/shared/util';
import { makeConversation } from '../tests/fixtures/synthetic';

const results: Record<string, unknown>[] = [];
for (const target of [100_000, 1_000_000]) {
  const conv = makeConversation(target);
  const chars = conv.messages.reduce((n, m) => n + (m.contents[0].content?.length ?? 0), 0);
  const memBefore = process.memoryUsage().heapUsed;
  const t0 = performance.now();
  const cold = runHandoff(conv);
  const coldMs = performance.now() - t0;
  const memAfter = process.memoryUsage().heapUsed;
  conv.messages.push({ id: 'new-u', role: 'user', contents: [{ type: 'text', content: '마지막으로 README를 업데이트해 주세요.' }] });
  const t1 = performance.now();
  const warm = runHandoff(conv, { cache: cold.cache });
  const warmMs = performance.now() - t1;
  const row = {
    targetTokens: target,
    measuredSourceTokens: cold.stats.sourceTokens,
    messages: conv.messages.length,
    chars,
    cold: { totalMs: Math.round(coldMs), ...Object.fromEntries(Object.entries(cold.timings).map(([k, v]) => [k, Math.round(v)])) },
    warm: { totalMs: Math.round(warmMs), cacheHits: warm.stats.cacheHits, cacheMisses: warm.stats.cacheMisses },
    outputTokens: cold.stats.outputTokens,
    heapDeltaMB: Math.round((memAfter - memBefore) / 1024 / 1024),
  };
  results.push(row);
  console.log(JSON.stringify(row));
}

const env = {
  cpu: os.cpus()[0]?.model,
  cores: os.cpus().length,
  ramGB: Math.round(os.totalmem() / 1024 ** 3),
  platform: `${os.platform()} ${os.release()}`,
  node: process.version,
  v8: process.versions.v8,
  date: new Date().toISOString(),
};
console.log(JSON.stringify(env));
mkdirSync('bench-results', { recursive: true });
writeFileSync('bench-results/handoff-node.json', JSON.stringify({ env, results }, null, 2));

if (process.env.BENCH_SECTIONS) {
  const conv = makeConversation(Number(process.env.BENCH_SECTIONS));
  const md = runHandoff(conv).markdown;
  writeFileSync('bench-results/sample-handoff.md', md);
  const parts = md.split(/\n(?=## )/);
  for (const p of parts) console.log(estimateTokens(p).toString().padStart(7), p.split('\n')[0].slice(0, 60), (p.match(/\n- /g) ?? []).length, 'items');
}
