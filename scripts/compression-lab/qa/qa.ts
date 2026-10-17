// QA evaluation of handoff documents (docs/compression-lab.md, 3rd study). Synthetic conversations
// only (scenario.ts): every conversation has 17 planted facts with an answer key and 2 questions
// without an answer. Commands:
//
//   presence [ratios] [algos]   share of planted answers present in each document — no AI, seconds
//   build <dir> [ratios] [algos] writes <dir>/<conv>/<algo>@<ratio>.md + questions.json + index.json
//   grade <dir> <run>           grades <dir>/answers/<run>/… written by ask.mjs (a reader AI)
//
// QA_SHAPE=long switches to few turns with very long answers (buildLongConversation).
//
// ratios: shares of the source, comma-separated; 0 = the product's default budget (12%, 8k–32k).
// algos: names from ../algorithms.ts plus "full" (the whole conversation).

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { handoffBudget } from '../../../src/handoff/engine';
import { estimateTokens } from '../../../src/shared/util';
import { ALGORITHMS } from '../algorithms';
import { corpusIdf, prepare, renderUnits, type Prepared } from '../prepare';
import { buildConversation, buildLongConversation, presence, questions, type Lang, type Question } from './scenario';

const SIZES = [30_000, 50_000, 80_000, 130_000, 220_000];
const [cmd, ...args] = process.argv.slice(2);
/** QA_SHAPE=long: few turns with very long answers (the shape of the real chats in the 1st study). */
const LONG = process.env.QA_SHAPE === 'long';

function corpus() {
  const items: Array<{ id: string; lang: Lang; ci: number }> = [];
  for (const lang of ['ko', 'en'] as const) for (let ci = 0; ci < SIZES.length; ci++) items.push({ id: `${lang}${ci}${LONG ? 'L' : ''}`, lang, ci });
  const prepared = items.map((it) => prepare(LONG ? buildLongConversation(it.lang, it.ci, SIZES[it.ci], 4 + it.ci * 2) : buildConversation(it.lang, it.ci, SIZES[it.ci])));
  return { items, prepared, idf: corpusIdf(prepared) };
}

const budgetFor = (p: Prepared, ratio: number) => (ratio === 0 ? handoffBudget(p.sourceTokens) : Math.round(Math.max(800, p.sourceTokens * ratio)));
const fileOf = (algo: string, ratio: number) => `${algo.replace(/\//g, '_')}@${ratio}`;

function documentFor(algo: string, p: Prepared, ratio: number, idf: ReturnType<typeof corpusIdf>): string {
  if (algo === 'full') return renderUnits(p, p.units.map((_, i) => i));
  const fn = ALGORITHMS[algo];
  if (!fn) throw new Error(`unknown algorithm: ${algo}`);
  return fn(p, budgetFor(p, ratio), idf);
}

const list = (s: string | undefined, dflt: string) => (s ?? dflt).split(',').filter(Boolean);

if (cmd === 'presence') {
  const ratios = list(args[0], '0.06,0.12,0').map(Number);
  const algos = list(args[1], 'lucian,lucian/v1.2,coverage');
  const { items, prepared, idf } = corpus();
  console.log('| 방법 | 예산 | 실제 크기 | 정답이 문서에 있는 비율 | 자주 빠진 질문 |\n|---|---|---|---|---|');
  for (const algo of algos)
    for (const ratio of ratios) {
      let hit = 0;
      let n = 0;
      let size = 0;
      const miss = new Map<string, number>();
      for (const [k, it] of items.entries()) {
        const md = documentFor(algo, prepared[k], ratio, idf);
        size += estimateTokens(md) / prepared[k].sourceTokens;
        for (const [q, re] of Object.entries(presence(it.ci))) {
          n++;
          if (new RegExp(re, 'i').test(md)) hit++;
          else miss.set(q, (miss.get(q) ?? 0) + 1);
        }
      }
      const top = [...miss.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([q, c]) => `${q} ${c}`).join(', ');
      console.log(`| ${algo} | ${ratio === 0 ? '기본' : `${ratio * 100}%`} | ${((100 * size) / items.length).toFixed(1)}% | ${((100 * hit) / n).toFixed(1)}% | ${top} |`);
    }
} else if (cmd === 'build') {
  const dir = args[0];
  if (!dir) throw new Error('usage: build <dir> [ratios] [algos]');
  const ratios = list(args[1], '0').map(Number);
  const algos = list(args[2], 'lucian,coverage');
  const { items, prepared, idf } = corpus();
  const indexPath = join(dir, 'index.json');
  const index: Array<{ id: string; lang: Lang; sourceTokens: number; tokens: Record<string, number> }> = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : [];
  for (const [k, it] of items.entries()) {
    const p = prepared[k];
    mkdirSync(join(dir, it.id), { recursive: true });
    writeFileSync(join(dir, it.id, 'questions.json'), JSON.stringify(questions(it.lang, it.ci), null, 1));
    let row = index.find((r) => r.id === it.id);
    if (!row) index.push((row = { id: it.id, lang: it.lang, sourceTokens: p.sourceTokens, tokens: {} }));
    for (const algo of algos)
      for (const ratio of algo === 'full' ? [1] : ratios) {
        const md = documentFor(algo, p, ratio, idf);
        writeFileSync(join(dir, it.id, `${fileOf(algo, ratio)}.md`), md);
        row.tokens[fileOf(algo, ratio)] = estimateTokens(md);
      }
    console.log(it.id, `${p.sourceTokens} tokens`);
  }
  writeFileSync(indexPath, JSON.stringify(index, null, 1));
} else if (cmd === 'grade') {
  const [dir, run] = args;
  if (!dir || !run) throw new Error('usage: grade <dir> <run>');
  const UNKNOWN = /^\s*(모름|unknown)|알 수 없|문서에(는)? (없|나와 있지 않|언급)|언급(이|되어 있지|되지) 않|정보(가|는) 없|not (mentioned|stated|specified|provided|in the document)|no information|does not (say|mention|specify)|doesn.t (say|mention|specify)/i;
  const grade = (q: Question, a: string) => {
    const unk = UNKNOWN.test(a);
    if (q.unanswerable) return unk ? 'correct' : 'wrong';
    if (new RegExp(q.accept, 'i').test(a) && !(q.reject && new RegExp(q.reject, 'i').test(a))) return 'correct';
    return unk ? 'unknown' : 'wrong';
  };
  const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as Array<{ id: string; sourceTokens: number; tokens: Record<string, number> }>;
  const stats = new Map<string, { n: number; ok: number; unk: number; un: number; unWrong: number; size: number; convs: number; byKind: Map<string, [number, number]> }>();
  for (const it of index) {
    const qs = JSON.parse(readFileSync(join(dir, it.id, 'questions.json'), 'utf8')) as Question[];
    const adir = join(dir, 'answers', run, it.id);
    if (!existsSync(adir)) continue;
    for (const f of readdirSync(adir)) {
      const method = f.replace(/\.json$/, '');
      const answers = new Map((JSON.parse(readFileSync(join(adir, f), 'utf8')).answers as Array<{ id: string; answer: unknown }>).map((x) => [x.id, String(x.answer ?? '')]));
      let s = stats.get(method);
      if (!s) stats.set(method, (s = { n: 0, ok: 0, unk: 0, un: 0, unWrong: 0, size: 0, convs: 0, byKind: new Map() }));
      s.convs++;
      s.size += (it.tokens[method] ?? 0) / it.sourceTokens;
      for (const q of qs) {
        const g = grade(q, answers.get(q.id) ?? '');
        if (q.unanswerable) {
          s.un++;
          if (g === 'wrong') s.unWrong++;
          continue;
        }
        s.n++;
        if (g === 'correct') s.ok++;
        if (g === 'unknown') s.unk++;
        const k = s.byKind.get(q.kind) ?? [0, 0];
        s.byKind.set(q.kind, [k[0] + (g === 'correct' ? 1 : 0), k[1] + 1]);
      }
    }
  }
  const pct = (a: number, b: number) => `${b ? ((100 * a) / b).toFixed(1) : '-'}%`;
  console.log('| 방법 | 실제 크기 (원문 대비) | 정답률 | 모름 | 틀림 | 답 없는 질문에 지어냄 |\n|---|---|---|---|---|---|');
  for (const [m, s] of [...stats.entries()].sort()) console.log(`| ${m} | ${pct(s.size, s.convs)} | ${pct(s.ok, s.n)} | ${pct(s.unk, s.n)} | ${pct(s.n - s.ok - s.unk, s.n)} | ${pct(s.unWrong, s.un)} |`);
  const kinds = [...new Set([...stats.values()].flatMap((s) => [...s.byKind.keys()]))];
  console.log(`\n| 질문 종류 | ${[...stats.keys()].sort().join(' | ')} |\n|---|${[...stats.keys()].map(() => '---').join('|')}|`);
  for (const k of kinds) console.log(`| ${k} | ${[...stats.entries()].sort().map(([, s]) => { const [a, b] = s.byKind.get(k) ?? [0, 0]; return pct(a, b); }).join(' | ')} |`);
} else {
  console.log('usage: npm run lab:qa -- presence [ratios] [algos] | build <dir> [ratios] [algos] | grade <dir> <run>');
}
