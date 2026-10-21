// The token estimate is what the handoff budget and its "never larger than the full export"
// guarantee are measured in, and what the popup shows. It must stay close to real tokenizers for
// every kind of text a chat holds — including Markdown markup, which the pre-1.3.8 rule ("4
// characters per token") counted at about half: a handoff full of [#m12] references and tables
// looked 30% smaller than it was.
import { describe, expect, it } from 'vitest';
import { encode as o200k } from 'gpt-tokenizer/encoding/o200k_base';
import { estimateTokens } from '../../src/shared/util';
import { runHandoff } from '../../src/handoff/engine';
import { conversationToMarkdown } from '../../src/export/markdown';
import { englishScenario, koreanScenario } from '../fixtures/handoff-scenarios';
import { makeConversation } from '../fixtures/synthetic';
import { sampleConversation } from '../fixtures/sample-conversation';
import { buildLongConversation } from '../../scripts/compression-lab/qa/scenario';

const texts: Record<string, string> = {
  'Korean prose': '오늘 배포한 서버의 응답 속도가 느려져서 캐시 설정을 다시 확인하고 있습니다. 데이터베이스 인덱스도 함께 점검해야 합니다. '.repeat(40),
  'English prose': 'The deployment slowed down after the cache layer change, so we are checking the configuration and the database indexes again. '.repeat(40),
  'message references': Array.from({ length: 300 }, (_, i) => `- item [#m${i + 1}]`).join('\n'),
  'Markdown table': Array.from({ length: 100 }, (_, i) => `| ${i} | **값 ${i}** | ~${i}.5% |`).join('\n'),
  'links': Array.from({ length: 100 }, (_, i) => `- [Source ${i}](https://docs.example.com/guide/${i}?a=b)`).join('\n'),
  'code': Array.from({ length: 120 }, (_, i) => `  const v${i} = compute(input.cache, ${i}); // retry ${i}`).join('\n'),
  'symbols': Array.from({ length: 60 }, (_, i) => `결정 — “캐시 ${i}”를 쓰기로 함 → 다음 단계 · 확인… The cache — “layer ${i}” → next`).join('\n'),
  'Japanese': 'これは日本語の文章です。会話の内容を別のAIに引き継ぐためのファイルです。'.repeat(30),
  'Korean export': conversationToMarkdown(koreanScenario(30), { locale: 'ko' }).text,
  'English export': conversationToMarkdown(englishScenario(30), { locale: 'en' }).text,
  'mixed export': conversationToMarkdown(makeConversation(20_000), { locale: 'ko' }).text,
  'long answers': conversationToMarkdown(buildLongConversation('en', 3, 20_000, 3), { locale: 'en' }).text,
  'Korean handoff': runHandoff(koreanScenario(30), { now: 0 }).markdown,
  'English handoff': runHandoff(englishScenario(30), { now: 0 }).markdown,
  'sample handoff': runHandoff(sampleConversation(), { now: 0, budgetTokens: 8_000, layout: { sectionsFrom: 0 } }).markdown,
};

describe('token estimate (v1.3.8)', () => {
  it('is within ±12% of o200k for prose, markup, code and handoffs', () => {
    for (const [name, text] of Object.entries(texts)) {
      const ratio = estimateTokens(text) / o200k(text).length;
      expect(ratio, `${name}: ${estimateTokens(text)} vs ${o200k(text).length}`).toBeGreaterThan(0.88);
      expect(ratio, name).toBeLessThan(1.12);
    }
  });

  it('counts empty and tiny strings sensibly', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a')).toBe(1);
    expect(estimateTokens('안녕')).toBeGreaterThanOrEqual(1);
    expect(estimateTokens('[#m12]')).toBeGreaterThanOrEqual(3);
  });

  it('is fast enough for a 1M-token conversation', () => {
    const big = texts['mixed export'].repeat(30);
    const t0 = performance.now();
    estimateTokens(big);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
