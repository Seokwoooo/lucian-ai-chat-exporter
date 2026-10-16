// Runs the compression lab on a local JSON file of ChatGPT /backend-api/conversation payloads
// (an array, or { conversations: [...] }). Prints aggregate numbers only.
//   node dist-lab/lab-file.mjs <input.json> <results.json> [outputs-dir]
// Keep the input and the outputs outside the repository and delete them after the run.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseChatGPTConversation } from '../../src/content/adapters/chatgpt';
import type { Conversation } from '../../src/shared/types';
import { formatLossless, formatSummary, runLab } from './lab';

const [input, resultsPath, outDir] = process.argv.slice(2);
if (!input || !resultsPath) throw new Error('usage: lab-file <input.json> <results.json> [outputs-dir]');

const raw = JSON.parse(readFileSync(input, 'utf8'));
const payloads: Array<Record<string, unknown>> = Array.isArray(raw) ? raw : raw.conversations;
const convs: Conversation[] = [];
let failed = 0;
payloads.forEach((data, k) => {
  try {
    convs.push(parseChatGPTConversation(data, { conversationId: `c${k}`, url: `https://chatgpt.com/c/c${k}` }));
  } catch {
    failed++;
  }
});

const outputs = new Map<string, string>();
const t0 = Date.now();
const { rows, summary, lossless } = await runLab(convs, {
  ratios: process.env.LAB_RATIOS ? process.env.LAB_RATIOS.split(',').map(Number) : [0.05, 0, 0.1, 0.2],
  algorithms: process.env.LAB_ALGOS ? process.env.LAB_ALGOS.split(',') : undefined,
  minTokens: 12_000,
  onProgress: (d, n) => process.stderr.write(`\r${d}/${n}`),
  keepOutputs: outDir ? (key, text) => outputs.set(key, text) : undefined,
});
process.stderr.write('\n');

console.log(`parsed ${convs.length} conversations (${failed} failed) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(formatSummary(summary));

console.log(formatLossless(lossless));

writeFileSync(resultsPath, JSON.stringify({ summary, lossless, rows }, null, 1));
if (outDir) {
  mkdirSync(outDir, { recursive: true });
  for (const [key, text] of outputs) writeFileSync(join(outDir, `${key.replace(/[:]/g, '_')}.md`), text);
}
