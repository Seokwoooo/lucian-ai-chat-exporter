// Reader AI for the QA evaluation: a fresh Claude Code session per document (Haiku, no tools, no
// settings, plugins, MCP servers or session history) answers the questions from the document
// alone. Lab only — the extension never calls a model. Costs API usage (about $0.005 per 10k-token
// document); documents are synthetic (scenario.ts), never real conversations.
//
// Usage: node scripts/compression-lab/qa/ask.mjs <dir> <run> [concurrency=3] [skipRegex]
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [DIR, RUN, CONC = '3', SKIP = '^$'] = process.argv.slice(2);
if (!DIR || !RUN) throw new Error('usage: ask.mjs <dir> <run> [concurrency] [skipRegex]');
const SYS = {
  ko: '당신은 이전 AI 대화를 이어받은 AI입니다. 사용자가 준 인수인계 문서만을 근거로 질문에 답하세요. 각 답은 짧게(단어나 한 문장) 쓰세요. 문서로 알 수 없으면 정확히 "모름"이라고 답하고 추측하지 마세요. 출력은 JSON 하나만: {"answers":[{"id":"질문 id","answer":"답"}]}',
  en: 'You are an AI taking over an earlier AI conversation. Answer using only the handoff document the user gives you. Keep each answer short (a few words or one sentence). If the document does not tell you, answer exactly "unknown" and do not guess. Output a single JSON object only: {"answers":[{"id":"question id","answer":"..."}]}',
};
// An empty working directory: no project instructions or files for the reader to find.
const cwd = mkdtempSync(join(tmpdir(), 'lucian-qa-'));
const index = JSON.parse(readFileSync(join(DIR, 'index.json'), 'utf8'));
const jobs = [];
for (const it of index) {
  const qs = JSON.parse(readFileSync(join(DIR, it.id, 'questions.json'), 'utf8'));
  for (const f of readdirSync(join(DIR, it.id)).filter((x) => x.endsWith('.md'))) {
    const method = f.slice(0, -3);
    const out = join(DIR, 'answers', RUN, it.id, `${method}.json`);
    if (new RegExp(SKIP).test(method) || existsSync(out)) continue;
    jobs.push({ lang: it.lang, id: it.id, method, doc: readFileSync(join(DIR, it.id, f), 'utf8'), qs, out });
  }
}
jobs.sort((a, b) => a.doc.length - b.doc.length);
console.log(`${jobs.length} documents`);

function ask(job) {
  const ko = job.lang === 'ko';
  const prompt = `${ko ? '인수인계 문서' : 'Handoff document'}:\n\n<document>\n${job.doc}\n</document>\n\n${ko ? '질문' : 'Questions'}:\n${job.qs.map((q) => `- ${q.id}: ${q.q}`).join('\n')}\n`;
  const args = ['-n', '19', 'claude', '-p', '--model', 'haiku', '--setting-sources', 'local', '--strict-mcp-config', '--tools', '', '--disable-slash-commands', '--no-session-persistence', '--system-prompt', SYS[job.lang], '--output-format', 'json'];
  return new Promise((resolve) => {
    const p = spawn('nice', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => resolve(out));
    p.stdin.end(prompt);
  });
}

let done = 0;
let cost = 0;
async function worker() {
  for (let job = jobs.shift(); job; job = jobs.shift()) {
    let rec = null;
    for (let attempt = 0; attempt < 2 && !rec; attempt++) {
      try {
        const j = JSON.parse(await ask(job));
        const m = /\{[\s\S]*\}/.exec(String(j.result ?? '').replace(/```(json)?/g, ''));
        if (j.is_error || !m) throw new Error(String(j.result).slice(0, 160));
        rec = { answers: JSON.parse(m[0]).answers, cost: j.total_cost_usd, model: Object.keys(j.modelUsage ?? {})[0] };
      } catch (e) {
        console.log(`  retry ${job.id}/${job.method}: ${String(e).slice(0, 160)}`);
      }
    }
    if (rec) {
      mkdirSync(join(job.out, '..'), { recursive: true });
      writeFileSync(job.out, JSON.stringify(rec, null, 1));
      cost += rec.cost ?? 0;
    }
    console.log(`[${++done}] ${job.id}/${job.method} ${rec ? 'ok' : 'FAILED'}`);
  }
}
await Promise.all(Array.from({ length: Number(CONC) }, worker));
console.log(`cost $${cost.toFixed(2)}`);
