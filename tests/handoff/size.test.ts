// The handoff is never larger than the full export of the same conversation (v1.3.8).
//
// User report (2026-10): a 4-message ChatGPT chat and a 10-message Grok chat (~2k tokens each)
// gave handoffs 29–38% LARGER than their full Markdown exports. Short conversations (≤12k) were
// handed off whole, with the reader instructions, the source table and index sections on top.
// The audit behind this file ran 263 shapes × sizes: 177 handoffs were not smaller than the
// full export, including compressed ones (long tool output counted whole, clipped in the export).
//
// Every case is checked with the engine's estimate and with real tokenizers (o200k, cl100k).
// All conversations here are synthetic.

import { describe, expect, it } from 'vitest';
import { encode as o200k } from 'gpt-tokenizer/encoding/o200k_base';
import { encode as cl100k } from 'gpt-tokenizer/encoding/cl100k_base';
import { BUDGET_TOLERANCE, FULL_EXPORT_SHARE, SECTIONS_FROM, detectLanguage, fullExportTokens, handoffBudget, runHandoff } from '../../src/handoff/engine';
import { verifyHandoffMarkdown } from '../../src/handoff/render';
import { balanceBold } from '../../src/handoff/patterns';
import { conversationToMarkdown } from '../../src/export/markdown';
import { conversationToTxt } from '../../src/export/txt';
import { estimateTokens } from '../../src/shared/util';
import type { Conversation, ExportContent, ExportMessage } from '../../src/shared/types';
import { makeConversation } from '../fixtures/synthetic';
import { englishScenario, koreanScenario, researchScenario, unrelatedChangeScenario } from '../fixtures/handoff-scenarios';
import { buildConversation, buildLongConversation } from '../../scripts/compression-lab/qa/scenario';

const NOW = Date.UTC(2026, 9, 21, 6);
let seq = 0;
const m = (role: 'user' | 'assistant', contents: ExportContent[]): ExportMessage => ({ id: `s${++seq}`, role, created_at: Date.UTC(2026, 9, 20) + seq * 60_000, contents });
const txt = (s: string): ExportContent => ({ type: 'text', content: s });
const md = (s: string): ExportContent => ({ type: 'markdown', content: s });
function conv(messages: ExportMessage[], title: string, site: Conversation['site'] = 'chatgpt'): Conversation {
  const meta = {
    chatgpt: ['ChatGPT', 'https://chatgpt.com/c/0a1b2c3d-1111-2222-3333-444455556666'],
    claude: ['Claude', 'https://claude.ai/chat/0b6f1c2e-1111-2222-3333-444455556666'],
    gemini: ['Gemini', 'https://gemini.google.com/app/1a2b3c4d5e6f7a8b'],
    grok: ['Grok', 'https://grok.com/c/0c0c0c0c-1111-2222-3333-444455556666?rid=0f0f0f0f-1111-2222-3333-444455556666'],
  }[site];
  return { title, pageId: title, fromUrl: meta[1], site, siteName: meta[0], pageType: 'fullPage', messages, extraction: { method: 'api', sourceNodeCount: messages.length, missingNodeIds: [], skipped: [], warnings: [], fetchedAt: 0 } };
}
const KO = '오늘 배포한 서버의 응답 속도가 느려져서 캐시 설정을 다시 확인하고 있습니다. 데이터베이스 인덱스도 함께 점검해야 합니다.';
const EN = 'The deployment slowed down after the cache layer change, so we are checking the configuration and the database indexes again.';
const fill = (s: string, tokens: number) => {
  const out: string[] = [];
  for (let i = 1, t = 0; t < tokens; i++) {
    const line = `${s} (${i})`;
    out.push(line);
    t += estimateTokens(line) + 1;
  }
  return out.join('\n\n');
};

/** Every shape the audit found a larger handoff for, plus the long-chat shapes. */
const SHAPES: Record<string, (n: number) => Conversation> = {
  qaShortKo: (n) => buildConversation('ko', 1, n),
  qaLongEn: (n) => buildLongConversation('en', 3, n, 2),
  bench: (n) => makeConversation(n),
  korean: (n) => koreanScenario(Math.round(n / 120)),
  english: (n) => englishScenario(Math.round(n / 90)),
  twoTurnsKo: (n) => conv([m('user', [txt('이거 어떻게 해?')]), m('assistant', [md(fill(KO, n / 2))]), m('user', [txt('더 자세히')]), m('assistant', [md(fill(KO, n / 2))])], '두 번 질문'),
  oneAnswerEn: (n) => conv([m('user', [txt('How do I fix this?')]), m('assistant', [md(fill(EN, n))])], 'One answer'),
  bigPaste: (n) => conv([m('user', [txt(`아래 로그 봐줘\n\n${fill('ERROR 2026-10-21 cache miss at node-3 key=user:1234 latency=950ms', n * 0.9)}`)]), m('assistant', [md(fill(KO, n * 0.1))])], '로그 분석'),
  pastedScreen: (n) => conv([m('user', [txt('지금 이거 사용량 별도야?')]), m('assistant', [md(fill(KO, n * 0.3))]), m('user', [txt(fill('  Weekly Limit Remaining [█████████████] 99.87% Refreshes in 132h 38m', n * 0.3))]), m('assistant', [md(fill(KO, n * 0.4))])], '사용량'),
  toolHeavy: (n) => conv([m('user', [txt('Run the analysis on the data file.')]), m('assistant', [{ type: 'tool', title: 'python', content: fill('row,value,flag 1234,5678,ok', n * 0.85) }, md(fill(EN, n * 0.15))])], 'Tool output'),
  attachment: (n) => conv([m('user', [{ type: 'attachment', attachment: { name: 'notes.txt', mime_type: 'text/plain', extractedText: fill(KO, n * 0.7) } }, txt('이 글 어떻게 생각해?')]), m('assistant', [md(fill(KO, n * 0.3))])], '첨부', 'claude'),
  imagesOnly: (n) => conv(Array.from({ length: Math.max(2, Math.round(n / 60)) }, (_, i) => m(i % 2 ? 'assistant' : 'user', i % 2 ? [{ type: 'image', imageUrl: `https://files.example.com/file-${i}?se=2026-10-21&sig=abcdefghijklmnop`, alt: '' }] : [txt('그림 그려줘')])), '이미지'),
  linkHeavy: (n) => conv(Array.from({ length: Math.max(2, Math.round(n / 400)) }, (_, i) => (i % 2 ? m('assistant', [md(`${KO} ([example.com](https://example.com/a/${i}?utm_source=chatgpt.com))\n\n${KO}`), { type: 'sources', sources: Array.from({ length: 8 }, (_, k) => ({ title: `Source ${k} about caching`, url: `https://docs.example.com/guide/${i}/${k}` })) }]) : m('user', [txt('최신 정보 찾아줘')]))), '검색'),
  manyTiny: (n) => conv(Array.from({ length: Math.max(2, Math.round(n / 8)) }, (_, i) => m(i % 2 ? 'assistant' : 'user', [txt(i % 2 ? '네.' : 'ㅇㅋ')])), '짧은 말'),
  thinkingOnly: (n) => conv([m('user', [txt('긴 계산 해줘')]), m('assistant', [{ type: 'thinking', content: fill(EN, n) }])], '생각만'),
  codeHeavy: (n) => conv([m('user', [txt('Write the module.')]), m('assistant', [md(`Here it is:\n\n\`\`\`ts\n${fill('export const value = compute(input.cache, 42); // cache', n)}\n\`\`\``)])], 'Code', 'gemini'),
};
const SIZES = [60, 300, 1_000, 2_500, 6_000, 11_900, 12_200, 25_000];
const FIXED: Record<string, () => Conversation> = {
  greeting: () => conv([m('user', [txt('hi')]), m('assistant', [md('Hello! How can I help you today?')])], 'Greeting'),
  greetingKo: () => conv([m('user', [txt('안녕')]), m('assistant', [md('안녕하세요! 무엇을 도와드릴까요?')])], '인사'),
  oneQuestion: () => conv([m('user', [txt('이 코드 리뷰해줘')])], '질문만'),
  research: researchScenario,
  unrelated: unrelatedChangeScenario,
};

interface Case {
  name: string;
  conv: Conversation;
}
const cases: Case[] = [];
for (const [name, fn] of Object.entries(SHAPES)) for (const n of SIZES) cases.push({ name: `${name}@${n}`, conv: fn(n) });
for (const [name, fn] of Object.entries(FIXED)) cases.push({ name, conv: fn() });

/** Every full export the user can make of the same conversation (UI language × image choice, TXT). */
function fullExports(c: Conversation): string[] {
  return [
    conversationToMarkdown(c, { locale: 'ko' }, NOW).text,
    conversationToMarkdown(c, { locale: 'en' }, NOW).text,
    conversationToMarkdown(c, { locale: 'ko', unmappedImage: 'omit' }, NOW).text,
    conversationToMarkdown(c, { locale: 'en', unmappedImage: 'omit' }, NOW).text,
    conversationToTxt(c, 'ko', NOW).text,
    conversationToTxt(c, 'en', NOW).text,
  ];
}

describe('handoff size: never larger than the full export (v1.3.8)', () => {
  const results = cases.map((c) => ({ ...c, r: runHandoff(c.conv, { now: NOW }), full: fullExports(c.conv) }));

  it(`stays within ${Math.round(FULL_EXPORT_SHARE * 100)}% (+2%) of the full export by the engine's count, for ${cases.length} shapes and sizes`, () => {
    for (const { name, conv: c, r } of results) {
      const R = fullExportTokens(c, NOW);
      expect(r.stats.sourceTokens, name).toBe(R);
      expect(r.stats.outputTokens, name).toBe(estimateTokens(r.markdown));
      expect(r.stats.outputTokens, name).toBeLessThanOrEqual(Math.floor(handoffBudget(R) * BUDGET_TOLERANCE));
      expect(r.stats.outputTokens, name).toBeLessThan(R);
    }
  });

  it('is smaller than every full export (Markdown in both languages, with or without image links, TXT) by real tokenizers', () => {
    let worst = 0;
    for (const { name, r, full } of results) {
      for (const [label, encode] of [
        ['o200k', o200k],
        ['cl100k', cl100k],
      ] as const) {
        const out = encode(r.markdown).length;
        const smallest = Math.min(...full.map((f) => encode(f).length));
        worst = Math.max(worst, out / smallest);
        // A clear margin: 2/3 by the estimate, at most ~85% by any tokenizer.
        expect(out / smallest, `${name} ${label}: ${out} vs ${smallest}`).toBeLessThan(0.85);
      }
    }
    expect(worst).toBeGreaterThan(0.4);
  });

  it('has a valid structure and the expected form: condensed below the sections budget, sections above', () => {
    for (const { name, r } of results) {
      expect(verifyHandoffMarkdown(r.markdown, r.lang), name).toEqual({ ok: true });
      const budget = handoffBudget(r.stats.sourceTokens);
      if (budget < SECTIONS_FROM) expect(r.stats.mode, name).toBe('condensed');
      else expect(r.stats.mode, name).toBe('compressed');
      // References point at real messages (the reader note's `[#m12]` is an example in code).
      const N = cases.find((c) => c.name === name)!.conv.messages.length;
      for (const x of r.markdown.replace(/`[^`\n]*`/g, '').matchAll(/\[#m(\d+)\]/g)) expect(Number(x[1]), name).toBeLessThanOrEqual(N);
    }
  });

  it('shrinks smoothly with the conversation: no jump at the old 12k full-transcript limit', () => {
    const below = runHandoff(SHAPES.bench(11_900), { now: NOW });
    const above = runHandoff(SHAPES.bench(12_200), { now: NOW });
    expect(below.stats.outputTokens).toBeLessThan(below.stats.sourceTokens * 0.7);
    expect(Math.abs(below.stats.outputTokens - above.stats.outputTokens)).toBeLessThan(above.stats.outputTokens * 0.25);
  });
});

describe('the two user-reported shapes (2026-10, synthetic mirrors)', () => {
  // ChatGPT web-search answer (Korean, cited sources, a table, sections), then the user pastes an
  // English terminal screen, then a second answer. Real: 1,950 tokens, handoff was 129% of the export.
  const search = conv(
    [
      m('user', [txt('지금 CLI에서 쓰는 모델 사용량이랑 웹에서 쓰는 사용량이랑 별도야? CLI 쪽 사용량은 어케돼? 나 Pro 플랜이야.')]),
      m('assistant', [
        md(
          [
            '**네. 별도입니다!** Pro 플랜이라면 웹과 CLI에서 쓰는 **모델 X의 사용량은 각각 따로 계산됩니다.** ([support.example](https://support.example/a?utm_source=chatgpt.com))',
            '그런데 더 중요한 사실이 있습니다. **CLI의 모델 X는 5시간마다 초기화되는 것이 아니라, 별도의 주간 할당량이 적용됩니다.**',
            '## 1. 사용량 비교',
            '| 구분 | 웹 | CLI |\n|---|---|---|\n| 사용량 한도 | 자체 한도 | 별도 한도 |\n| 초기화 | 5시간 주기 + 주간 상한 | **주간 초기화만** |\n| 정확한 횟수 | 작업 복잡도에 따라 변동 | 공식 고정 횟수 미공개 |',
            'CLI 안에서도 모델 X는 모델 Y의 기존 한도와 별도입니다. 따라서 모델 X 할당량을 모두 쓰더라도 모델 Y로 계속 작업할 수 있습니다.',
            '## 2. 실제로 얼마나 쓸 수 있나?',
            '공식적으로는 **정확한 주간 요청 횟수나 토큰 한도를 공개하지 않았습니다.** 사용자 보고로는 복잡한 작업으로 1~3시간 만에 주간 한도를 소진했다는 이야기가 있습니다.',
            '## 3. 내 사용량 확인 방법',
            '1. 터미널을 열고 다음 명령어를 입력하세요.',
            '```bash\nexamplecli\n```',
            '2. CLI가 열리면 아래 명령을 입력합니다.',
            '```text\n/usage\n```',
            '남은 주간 할당량과 초기화 시점을 볼 수 있습니다. `/quota`도 같은 명령입니다.',
            '**결론:** 웹에서 많이 써도 CLI의 주간 할당량은 줄어들지 않습니다. 다만 CLI 쪽 한도는 빨리 소진될 수 있으니 중요한 작업에 아껴 쓰세요.',
          ].join('\n\n'),
        ),
        { type: 'sources', sources: Array.from({ length: 8 }, (_, k) => ({ title: `Plans and limits — docs page ${k + 1}`, url: `https://docs.example.com/plans/${k + 1}` })) },
      ]),
      m('user', [txt(['└ Models & Quota', '', 'GROUP A MODELS', '  Weekly Limit Remaining', '    [██████████████████████████████████████████████████] 99.87%', '    Refreshes in 132h 38m', '', '  Five Hour Limit Remaining', '    [██████████████████████████████████████████████████] 100.00%', '', 'MODEL X', '  For paid Pro plans, model X quota is separate.', '  Model X Weekly Limit', '    [█████████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░] 41.34%', '    Refreshes in 130h 29m', '', '  │Within each group, models share a weekly limit and a 5-hour limit. Quota is', '  │consumed proportionally to the cost of the tokens.'].join('\n'))]),
      m('assistant', [md(['오, 이거 보니까 **Pro 플랜에서 모델 X 사용량이 얼마나 남았는지 정확하게 확인되네요!**', '## 현재 사용량', '**모델 X**\n41.34% 남음\n\n58.66% 사용 완료, 5일 10시간 29분 후 초기화', '## 여기서 중요한 사실 3가지', '1. **모델 X 사용량은 다른 모델과 확실히 분리되어 있습니다.**\n2. **Pro의 모델 X는 주간 한도만 표시됩니다.**\n3. **토큰 비용에 비례해 차감됩니다.**', '다만 정확히 몇 회 요청할 수 있는지는 이 화면만으로 계산할 수 없습니다.'].join('\n\n'))]),
    ],
    '사용량 비교 확인',
  );
  // Grok: ten short Korean turns about a prediction market, with tables in most answers.
  const market = conv(
    [
      ['오늘 출시해? 마켓 확률은?', '**아직 공식 출시는 안 됐어요.** 현재 공개된 최신 버전은 여전히 **5.1**입니다.\n\n| 결과 | 확률 |\n|---|---|\n| **10월 20일** | **~20.5%** |\n| 10월 31일까지 안 나옴 | ~21.1% |\n| 10월 22일 | ~17.9% |\n\n화요일 출시 패턴도 겹쳐서 사람들이 주목하고 있습니다.'],
      ['지금 어디가 젤 높아?', '**지금 가장 높은 쪽 기준으로 보면 이렇게 나뉩니다.**\n\n### 1. 정확한 날짜 시장\n가장 높은 게 **“10월 31일까지 안 나옴”** 쪽입니다.\n\n| 순위 | 결과 | 확률 |\n|---|---|---|\n| 1 | 10월 31일까지 안 나옴 | ~21% |\n| 2 | 10월 20일 | ~20.5% |\n\n---\n\n**요약**: 오늘과 “10월 말까지 안 나옴”이 거의 비등합니다.'],
      ['지금 확률은 또 바뀌엇제?', '**응, 바뀌었어.**\n\n### 1. 정확한 날짜 시장\n**지금 가장 높은 건 10월 20일**이야.\n\n| 순위 | 결과 | 확률 |\n|---|---|---|\n| 1 | 10월 20일 | 26.8% |\n| 2 | 10월 31일까지 안 나옴 | 18.4% |\n\n10월 말까지 나올 확률은 여전히 높은 편이야.'],
      ['내 말이 맞앗네?', '응, 어느 정도 맞았네. 20일이 26.8%로 확실히 1위로 올라갔어. 아직 하루가 끝난 건 아니니까 조금 더 지켜봐야겠지만.'],
      ['20일 확률이 높아진 이유', '**특별한 공식 발표가 있어서 올라간 건 아니야.**\n\n- **화요일 출시 패턴**: 이전 버전들이 화요일에 나왔던 기록.\n- **파트너 액세스 루머**: 미확인.\n- **시장 모멘텀**: 베팅이 몰리면서 올라간 형태.\n\n실제로 안 나오면 22일 쪽으로 다시 움직일 가능성도 있어.'],
    ].flatMap(([u, a]) => [m('user', [txt(u)]), m('assistant', [md(a)])]),
    '오늘 출시 마켓',
    'grok',
  );

  for (const [name, c, key, code] of [
    ['ChatGPT search answer + English screen paste', search, /별도입니다!|각각 따로 계산됩니다/, ['다음 명령어를 입력하세요.\n\n```bash\nexamplecli\n```', '```text\n/usage\n```']],
    ['Grok market chat', market, /26\.8%/, []],
  ] as const) {
    it(`${name}: condensed, Korean, ≤ 2/3 of the export, keeps the first answer's point`, () => {
      const r = runHandoff(c, { now: NOW });
      const full = fullExports(c);
      expect(r.stats.mode).toBe('condensed');
      expect(r.lang).toBe('ko');
      expect(r.stats.outputTokens).toBeLessThanOrEqual(Math.floor(r.stats.sourceTokens * FULL_EXPORT_SHARE * BUDGET_TOLERANCE));
      for (const f of full) expect(o200k(r.markdown).length).toBeLessThan(o200k(f).length * 0.8);
      expect(r.markdown).toMatch(key);
      // Short commands stay, with the sentence that leads into them (ChatGPT code widgets, 2026-10-21).
      for (const k of code) expect(r.markdown).toContain(k);
      // The last exchange is there, and the first request.
      expect(r.markdown).toContain(`### [#m${c.messages.length}] ${c.siteName}`);
      expect(r.markdown).toContain('### [#m1] 사용자');
      expect(r.markdown).not.toContain('utm_source');
      // Bold spans cut by sentence splitting are closed again.
      for (const line of r.markdown.split('\n')) if (!line.startsWith('|')) expect((line.split('**').length - 1) % 2, line).toBe(0);
    });
  }
});

describe('language of the handoff (v1.3.8)', () => {
  it('follows what the user typed, not a long English paste', () => {
    const c = conv([m('user', [txt('지금 이 사용량 별도야?')]), m('assistant', [md(KO)]), m('user', [txt(fill('Weekly Limit Remaining 99.87% Refreshes in 132h 38m', 600))]), m('assistant', [md(KO)])], '사용량');
    expect(detectLanguage(c)).toBe('ko');
    expect(runHandoff(c, { now: NOW }).lang).toBe('ko');
  });
  it('stays English for an English user who pastes a Korean line once', () => {
    const c = conv([m('user', [txt('Translate this for me please.')]), m('assistant', [md(EN)]), m('user', [txt('How about this one?')]), m('assistant', [md(EN)]), m('user', [txt('안녕하세요')]), m('assistant', [md(EN)]), m('user', [txt('Thanks, and the next one?')])], 'Translate');
    expect(detectLanguage(c)).toBe('en');
  });
});

describe('bold spans cut by sentence splitting (v1.3.8)', () => {
  it('drops the lone ** of a sentence cut out of a bold span', () => {
    expect(balanceBold('**네.')).toBe('네.');
    expect(balanceBold('별도입니다!** 웹과 CLI의 **사용량은 따로** 계산됩니다.')).toBe('별도입니다! 웹과 CLI의 **사용량은 따로** 계산됩니다.');
    expect(balanceBold('결론은 **A입니다. 그리고')).toBe('결론은 A입니다. 그리고');
    expect(balanceBold('**굵게** 그대로')).toBe('**굵게** 그대로');
    expect(balanceBold('***강조***')).toBe('***강조***');
  });
});
