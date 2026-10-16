// Production build with esbuild.
//  - extension pages + handoff worker: ESM with code splitting (exporters load on demand)
//  - service worker: single ESM file (dynamic import() is not allowed in service workers)
//  - content scripts: classic IIFE bundles (isolated world + MAIN world)
// Also copies static files, stamps the manifest version and writes third-party notices.

import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIST = 'dist';
const dev = process.argv.includes('--dev');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

/**
 * docx ships a pre-bundled copy of JSZip whose setImmediate polyfill turns string callbacks into
 * code with `new Function`. Extension pages must never evaluate strings (MV3 CSP, store review),
 * so that branch is replaced with a TypeError. The build fails if the pattern ever changes.
 */
function noStringEvalPlugin() {
  const PATTERN = '"function" != typeof e && (e = new Function("" + e));';
  return {
    name: 'no-string-eval',
    setup(b) {
      b.onLoad({ filter: /[\\/]node_modules[\\/]docx[\\/]dist[\\/]index\.mjs$/ }, (args) => {
        const code = readFileSync(args.path, 'utf8');
        if (!code.includes(PATTERN)) throw new Error('docx: setImmediate polyfill pattern not found; re-check for new Function');
        return { contents: code.replace(PATTERN, 'if ("function" != typeof e) throw new TypeError("setImmediate: function expected");'), loader: 'js' };
      });
    },
  };
}

const common = {
  bundle: true,
  minify: !dev,
  sourcemap: dev ? 'inline' : false,
  target: ['chrome116'],
  legalComments: 'none',
  charset: 'utf8',
  logLevel: 'warning',
  metafile: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [noStringEvalPlugin()],
};

const results = await Promise.all([
  build({
    ...common,
    entryPoints: {
      popup: 'src/popup/popup.ts',
      offscreen: 'src/offscreen/offscreen.ts',
      print: 'src/print/print.ts',
      'handoff-worker': 'src/handoff/worker.ts',
    },
    outdir: DIST,
    format: 'esm',
    splitting: true,
    chunkNames: 'chunks/[name]-[hash]',
  }),
  build({ ...common, entryPoints: { background: 'src/background/index.ts' }, outdir: DIST, format: 'esm' }),
  build({ ...common, entryPoints: { content: 'src/content/index.ts', inject: 'src/inject/main-world.ts' }, outdir: DIST, format: 'iife' }),
]);

// Static assets
cpSync('src/static/_locales', join(DIST, '_locales'), { recursive: true });
mkdirSync(join(DIST, 'icons'), { recursive: true });
for (const s of [16, 32, 48, 128]) cpSync(`src/static/icons/icon-${s}.png`, join(DIST, 'icons', `icon-${s}.png`));
for (const [from, to] of [
  ['src/popup/popup.html', 'popup.html'],
  ['src/popup/popup.css', 'popup.css'],
  ['src/offscreen/offscreen.html', 'offscreen.html'],
  ['src/print/print.html', 'print.html'],
  ['src/print/print-ui.css', 'print-ui.css'],
]) {
  cpSync(from, join(DIST, to));
}

const manifest = JSON.parse(readFileSync('src/static/manifest.json', 'utf8'));
manifest.version = pkg.version;
writeFileSync(join(DIST, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

// Third-party notices for every npm package that ended up in the bundle.
const packages = new Set();
for (const r of results) {
  for (const input of Object.keys(r.metafile.inputs)) {
    const m = input.match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//);
    if (m) packages.add(m[1]);
  }
}
const notices = ['Lucian AI Chat Exporter bundles the following open-source packages.\n'];
for (const name of [...packages].sort()) {
  const dir = join('node_modules', name);
  const meta = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const licFile = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(f));
  notices.push(`\n==== ${name}@${meta.version} (${meta.license ?? 'see license'}) ====\n`);
  notices.push(licFile ? readFileSync(join(dir, licFile), 'utf8') : `License: ${meta.license}\n`);
}
writeFileSync(join(DIST, 'THIRD_PARTY_NOTICES.txt'), notices.join(''));
cpSync('LICENSE', join(DIST, 'LICENSE.txt'));

// Size report
let total = 0;
const walk = (d) => {
  for (const f of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, f.name);
    if (f.isDirectory()) walk(p);
    else total += readFileSync(p).byteLength;
  }
};
walk(DIST);
console.log(`built ${DIST}/ — ${(total / 1024).toFixed(0)} KB, bundled packages: ${[...packages].sort().join(', ') || 'none'}`);
if (!existsSync(join(DIST, 'manifest.json'))) process.exit(1);
