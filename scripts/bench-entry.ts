// Handoff performance benchmark. Builds synthetic conversations of ~100k and ~1M tokens and
// measures each engine stage (cold run and incremental warm run with the analysis cache).

import os from 'node:os';
import { writeFileSync, mkdirSync } from 'node:fs';
import { runHandoff } from '../src/handoff/engine';
import type { Conversation, ExportMessage } from '../src/shared/types';
import { estimateTokens } from '../src/shared/util';

let seed = 12345;
const rand = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 4294967296;
};
const pick = <T>(a: T[]) => a[Math.floor(rand() * a.length)];

const KO_WORDS = '데이터 서버 클라이언트 요청 응답 캐시 성능 구조 설계 모듈 함수 변수 테스트 배포 설정 파일 경로 사용자 화면 버튼 상태 이벤트 로그 오류 처리 인증 토큰 권한 데이터베이스 쿼리 인덱스 최적화 비동기 동기화 메모리 스레드 큐 메시지 이미지 문서 변환 형식 표 수식 코드 블록'.split(' ');
const KO_ENDS = ['합니다.', '입니다.', '할 수 있습니다.', '해야 합니다.', '되었습니다.', '하는 것이 좋습니다.'];
const EN_WORDS = 'server client request response cache performance architecture module function variable test deploy config file path user screen button state event log error handling auth token permission database query index optimize async sync memory thread queue message image document convert format table formula code block'.split(' ');

function koSentence(): string {
  const n = 6 + Math.floor(rand() * 10);
  return `${Array.from({ length: n }, () => pick(KO_WORDS)).join(' ')} ${pick(KO_ENDS)}`;
}
function enSentence(): string {
  const n = 8 + Math.floor(rand() * 14);
  const w = Array.from({ length: n }, () => pick(EN_WORDS)).join(' ');
  return `${w.charAt(0).toUpperCase()}${w.slice(1)}.`;
}
function paragraph(ko: boolean): string {
  return Array.from({ length: 3 + Math.floor(rand() * 4) }, () => (ko ? koSentence() : enSentence())).join(' ');
}
function codeBlock(i: number): string {
  const lines = Array.from({ length: 10 + Math.floor(rand() * 40) }, (_, k) => `  const v${k} = compute${i % 7}(input.${pick(EN_WORDS)}, ${k}); // ${pick(EN_WORDS)}`);
  return `\`\`\`ts\n// src/module${i % 30}.ts\nexport function handler${i % 50}(input: Input) {\n${lines.join('\n')}\n}\n\`\`\``;
}

function makeConversation(targetTokens: number): Conversation {
  const messages: ExportMessage[] = [];
  let tokens = 0;
  let i = 0;
  while (tokens < targetTokens) {
    const ko = rand() < 0.5;
    const userText =
      i % 25 === 0
        ? ko
          ? `이번에는 module${i % 30} 방식으로 진행하기로 하자. 절대 jQuery는 사용하지 마세요.`
          : `Let's go with option ${i % 9} for the cache layer. Never use global state.`
        : ko
          ? `${koSentence()} src/module${i % 30}.ts 파일을 수정해 주세요.`
          : `${enSentence()} Please update src/module${i % 30}.ts.`;
    const parts = [paragraph(ko), paragraph(ko)];
    if (i % 3 === 0) parts.push(codeBlock(i));
    if (i % 5 === 0) parts.push(`- ${ko ? '완료: ' : 'Done: '}${paragraph(ko)}\n- ${ko ? '남은 작업: ' : 'TODO: '}${paragraph(ko)}`);
    if (i % 11 === 0) parts.push('| a | b | c |\n|---|---|---|\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |');
    if (i % 7 === 0) parts.push(paragraph(ko)); // extra prose
    if (i % 13 === 0 && messages.length > 2) parts.push((messages[messages.length - 1].contents[0].content ?? '').slice(0, 400)); // repetition
    const assistantText = parts.join('\n\n');
    messages.push({ id: `u${i}`, role: 'user', created_at: i * 2000, contents: [{ type: 'text', content: userText }] });
    messages.push({ id: `a${i}`, role: 'assistant', created_at: i * 2000 + 1000, contents: [{ type: 'markdown', content: assistantText }] });
    tokens += estimateTokens(userText) + estimateTokens(assistantText);
    i++;
  }
  return {
    title: `Synthetic ${targetTokens}`,
    pageId: `bench-${targetTokens}`,
    fromUrl: 'https://chatgpt.com/c/bench',
    site: 'chatgpt',
    siteName: 'ChatGPT',
    pageType: 'fullPage',
    messages,
    extraction: { method: 'api', sourceNodeCount: messages.length, missingNodeIds: [], skipped: [], warnings: [], fetchedAt: 0 },
  };
}

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
