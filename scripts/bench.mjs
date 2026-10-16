// Bundles scripts/bench-entry.ts with esbuild and runs it in Node.
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

mkdirSync('bench-results', { recursive: true });
await build({ entryPoints: ['scripts/bench-entry.ts'], bundle: true, platform: 'node', format: 'esm', outfile: 'bench-results/bench.mjs', logLevel: 'error' });
const r = spawnSync(process.execPath, ['bench-results/bench.mjs'], { stdio: 'inherit' });
process.exit(r.status ?? 1);
