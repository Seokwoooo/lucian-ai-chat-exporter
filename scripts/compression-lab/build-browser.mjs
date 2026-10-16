// Builds dist-lab/lab.js (readable, not mangled) with UI strings stubbed out.
import { build } from 'esbuild';
import { resolve } from 'node:path';

const stub = resolve('scripts/compression-lab/i18n-stub.ts');
await build({
  entryPoints: ['scripts/compression-lab/browser-entry.ts'],
  bundle: true,
  format: 'iife',
  target: 'chrome116',
  minifyWhitespace: true,
  minifySyntax: true,
  outfile: 'dist-lab/lab.js',
  logLevel: 'error',
  plugins: [{ name: 'i18n-stub', setup: (b) => b.onResolve({ filter: /shared\/i18n$/ }, () => ({ path: stub })) }],
});
