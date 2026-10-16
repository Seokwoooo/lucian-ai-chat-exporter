// Packs dist/ into the Chrome Web Store upload ZIP: release/lucian-ai-chat-exporter-v<version>.zip.
// Run after `npm run build` (`npm run package` does both). Refuses to pack a build that contains
// source maps or files that should never ship.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { zipSync } from 'fflate';

const DIST = 'dist';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const manifest = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8'));
if (manifest.version !== pkg.version) throw new Error(`manifest version ${manifest.version} != package.json ${pkg.version}`);

const FORBIDDEN = [/\.map$/, /\.ts$/, /(^|\/)\.env/, /\.pem$/, /\.key$/, /(^|\/)\.DS_Store$/];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const files = {};
let total = 0;
for (const file of walk(DIST)) {
  const rel = relative(DIST, file).split(sep).join('/');
  if (FORBIDDEN.some((re) => re.test(rel))) throw new Error(`refusing to package ${rel}`);
  const bytes = readFileSync(file);
  total += bytes.byteLength;
  // Fixed timestamp so the same build produces the same ZIP.
  files[rel] = [new Uint8Array(bytes), { level: 9, mtime: new Date('2026-01-01T00:00:00Z') }];
}

const zip = zipSync(files);
mkdirSync('release', { recursive: true });
const out = join('release', `lucian-ai-chat-exporter-v${pkg.version}.zip`);
writeFileSync(out, zip);
const sha = createHash('sha256').update(zip).digest('hex');
writeFileSync(`${out}.sha256`, `${sha}  ${out.split('/').pop()}\n`);
console.log(`${out} — ${Object.keys(files).length} files, ${(total / 1024).toFixed(0)} KB unpacked, ${(zip.byteLength / 1024).toFixed(0)} KB zipped`);
console.log(`sha256 ${sha}`);
