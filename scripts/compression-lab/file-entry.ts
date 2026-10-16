// Runs the compression lab on local JSON files of conversation payloads: ChatGPT
// /backend-api/conversation/{id} or Claude chat_conversations/{id} responses (each file an array,
// or { conversations: [...] }; several files separated by commas). Prints aggregate numbers only.
//   node dist-lab/lab-file.mjs <a.json[,b.json]> <results.json> [outputs-dir]
// Keep the inputs and the outputs outside the repository and delete them after the run.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseChatGPTConversation } from '../../src/content/adapters/chatgpt';
import { parseClaudeConversation } from '../../src/content/adapters/claude';
import type { Conversation } from '../../src/shared/types';
import { formatLossless, formatSummary, runLab } from './lab';
import { prepare, renderUnits } from './prepare';
import { handoffBudget } from '../../src/handoff/engine';
import { estimateTokens } from '../../src/shared/util';

const [input, resultsPath, outDir] = process.argv.slice(2);
if (!input || !resultsPath) throw new Error('usage: lab-file <a.json[,b.json]> <results.json> [outputs-dir]');

const convs: Conversation[] = [];
let failed = 0;
for (const file of input.split(',')) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const payloads: Array<Record<string, unknown>> = Array.isArray(raw) ? raw : raw.conversations;
  payloads.forEach((data, k) => {
    try {
      const id = `c${convs.length}-${k}`;
      convs.push(
        Array.isArray(data.chat_messages)
          ? parseClaudeConversation(data, { conversationId: id, url: `https://claude.ai/chat/${id}` })
          : parseChatGPTConversation(data, { conversationId: id, url: `https://chatgpt.com/c/${id}` }),
      );
    } catch {
      failed++;
    }
  });
}

// LAB_EXPORT=<dir>: write the units of every lab conversation (for py/embed.py) and the full
// transcript (for py/lingua.py), then stop. Indices match the lab run (same filter, same order).
if (process.env.LAB_EXPORT) {
  const dir = process.env.LAB_EXPORT;
  mkdirSync(dir, { recursive: true });
  const prepared = convs.map(prepare).filter((p) => p.sourceTokens >= 12_000);
  const levels = process.env.LAB_RATIOS ? process.env.LAB_RATIOS.split(',').map(Number) : [0.05, 0, 0.1, 0.2, 0.3, 0.5];
  const meta = prepared.map((p, ci) => {
    writeFileSync(
      join(dir, `units-c${ci}.jsonl`),
      p.units.map((u, i) => JSON.stringify({ i, m: u.m, role: u.role, kind: u.kind, text: u.text.slice(0, 4000) })).join('\n'),
    );
    const full = renderUnits(p, p.units.map((_, i) => i));
    writeFileSync(join(dir, `full-c${ci}.md`), full);
    return { ci, units: p.units.length, sourceTokens: p.sourceTokens, fullTokens: estimateTokens(full), budgets: Object.fromEntries(levels.map((r) => [r, r === 0 ? handoffBudget(p.sourceTokens) : Math.round(Math.min(200_000, Math.max(1_500, p.sourceTokens * r)))])) };
  });
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 1));
  console.log(`exported ${prepared.length} conversations to ${dir}`);
  process.exit(0);
}

const outputs = new Map<string, string>();
const t0 = Date.now();
const { rows, summary, lossless } = await runLab(convs, {
  ratios: process.env.LAB_RATIOS ? process.env.LAB_RATIOS.split(',').map(Number) : [0.05, 0, 0.1, 0.2],
  algorithms: process.env.LAB_ALGOS ? process.env.LAB_ALGOS.split(',') : undefined,
  minTokens: 12_000,
  onProgress: (d, n) => process.stderr.write(`\r${d}/${n}`),
  keepOutputs: outDir
    ? (key, text) => {
        // LAB_KEEP_RATIOS=0,0.3 keeps only those levels' outputs (for py/semeval.py).
        const keep = process.env.LAB_KEEP_RATIOS?.split(',');
        if (!keep || keep.includes(key.split(':')[1])) outputs.set(key, text);
      }
    : undefined,
});
process.stderr.write('\n');

console.log(`parsed ${convs.length} conversations (${failed} failed) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(formatSummary(summary));

console.log(formatLossless(lossless));

writeFileSync(resultsPath, JSON.stringify({ summary, lossless, rows }, null, 1));
if (outDir) {
  mkdirSync(outDir, { recursive: true });
  const index: Array<{ file: string; ci: number; ratio: number; algo: string }> = [];
  for (const [key, text] of outputs) {
    const [ci, ratio, ...rest] = key.split(':');
    const algo = rest.join(':');
    const file = `${ci}_${ratio}_${algo.replace(/[^A-Za-z0-9.]+/g, '-')}.md`;
    writeFileSync(join(outDir, file), text);
    index.push({ file, ci: Number(ci), ratio: Number(ratio), algo });
  }
  writeFileSync(join(outDir, 'index.json'), JSON.stringify(index));
}
