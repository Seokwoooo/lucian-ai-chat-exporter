import { describe, expect, it } from 'vitest';
import { handoffBudget, runHandoff } from '../../src/handoff/engine';
import { ANAPHOR_RE, clipText, extractPaths } from '../../src/handoff/patterns';
import { verifyHandoffMarkdown } from '../../src/handoff/render';
import { conv as makeConv, englishScenario, koreanScenario, msg, researchScenario, unrelatedChangeScenario } from '../fixtures/handoff-scenarios';
import { parseChatGPTConversation } from '../../src/content/adapters/chatgpt';
import { CHATGPT_ID, chatgptConversation } from '../fixtures/sites';
import { estimateTokens } from '../../src/shared/util';

/**
 * Returns the body of the "## N. {title}…" section (until the next level-2 heading). Sections are
 * numbered in order and empty ones are left out, so tests look them up by title.
 */
function section(md: string, title: string): string {
  const m = new RegExp(`\\n## \\d+\\. ${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).exec(md);
  if (!m) return '';
  const rest = md.slice(m.index + 1);
  const end = rest.indexOf('\n## ', 3);
  return end < 0 ? rest : rest.slice(0, end);
}

const DEC = '확정된 주요 결정';
const CONS = '사용자 지시사항';
const CODE = '핵심 코드';
const DONE = '완료한 작업';
const OPEN = '미완료 작업';
const NEXT = '다음에 이어서 할 작업';
const FAIL = '이전 시도에서 실패한 원인';
const CUR = '현재 진행 상황';

function subsection(text: string, prefix: string): string {
  const start = text.indexOf(`\n### ${prefix}`);
  if (start < 0) return '';
  const rest = text.slice(start + 1);
  const end = rest.indexOf('\n### ', 4);
  return end < 0 ? rest : rest.slice(0, end);
}

describe('handoff accuracy — Korean scenario (Electron → Tauri)', () => {
  const conv = koreanScenario();
  const r = runHandoff(conv, { now: Date.UTC(2026, 9, 16) });
  const md = r.markdown;
  const decisions = section(md, DEC);
  const active = decisions.split('### ')[0];
  const superseded = subsection(decisions, '변경되거나');

  it('uses compressed mode for a long conversation', () => {
    expect(r.stats.mode).toBe('compressed');
    expect(r.stats.sourceTokens).toBeGreaterThan(12_000);
    expect(r.stats.outputTokens).toBeLessThan(r.stats.sourceTokens);
  });

  it('keeps the latest confirmed decision (Tauri) as active', () => {
    expect(active).toMatch(/Tauri로 (바꾸자|확정)/);
  });

  it('moves the replaced decision (Electron) to the superseded list, not the active list', () => {
    expect(active).not.toMatch(/Electron으로 개발하기로 하자/);
    expect(superseded).toMatch(/Electron으로 개발하기로 하자/);
    expect(superseded).toMatch(/변경됨/);
  });

  it('preserves the prohibition and notes the repetition', () => {
    const cons = section(md, CONS);
    expect(cons).toMatch(/jQuery는 사용하지 마세요/);
    expect(cons).toMatch(/2회 반복 강조/);
  });

  it('lists important file paths and the latest code', () => {
    const code = section(md, CODE);
    expect(code).toMatch(/src-tauri\/tauri\.conf\.json/);
    expect(code).toMatch(/src\/main\.rs/);
    // The latest code is in the recent transcript, so the code section points there instead of
    // repeating it; the document still contains it exactly once.
    expect(code).toMatch(/최근 대화 원문에 있는 코드는 그곳에만 둡니다: \[#m\d+\]/);
    expect(md.match(/tauri::Builder::default/g)).toHaveLength(1);
  });

  it('separates completed work from open work', () => {
    expect(section(md, DONE)).toMatch(/초기 설정을 완료했습니다/);
    const open = section(md, OPEN) + section(md, NEXT);
    expect(open).toMatch(/자동 업데이트/);
    expect(open).toMatch(/코드 서명/);
  });

  it('records the failure cause', () => {
    expect(section(md, FAIL)).toMatch(/Xcode 명령줄 도구/);
  });

  it('shows the final user instruction as the current state', () => {
    const cur = section(md, CUR);
    expect(cur).toMatch(/자동 업데이트 기능을 구현해 주세요/);
    expect(md).toMatch(/https:\/\/updates\.example\.com\/memo/);
  });

  it('starts with instructions for the next AI and references source messages', () => {
    expect(md.slice(0, 600)).toMatch(/이 문서를 읽는 AI에게/);
    expect(md).toMatch(/\[#m\d+\]/);
    // The reference index costs budget without answering anything (QA evaluation, 2026-10), so it
    // is off by default; the layout can still turn it on.
    expect(md).not.toMatch(/## 부록/);
    expect(runHandoff(conv, { now: 0, layout: { refIndex: true } }).markdown).toMatch(/## 부록\. 메시지 참조 색인/);
  });

  it('keeps an early important decision even though it is old', () => {
    // The jQuery prohibition was first stated in message 3 of 90+.
    expect(md).toMatch(/\[#m3\]/);
  });
});

describe('handoff accuracy — English scenario (REST → GraphQL)', () => {
  const r = runHandoff(englishScenario(), { now: Date.UTC(2026, 9, 16) });
  const md = r.markdown;
  const decisions = section(md, 'Confirmed decisions');
  const active = decisions.split('### ')[0];

  it('writes the document in English', () => {
    expect(r.lang).toBe('en');
    expect(md).toMatch(/To the AI reading this/);
  });

  it('treats GraphQL as the current decision and REST as superseded', () => {
    expect(active).toMatch(/GraphQL/);
    expect(active).not.toMatch(/Let's go with a REST API/);
    expect(decisions).toMatch(/Let's go with a REST API[\s\S]*changed in/);
  });

  it('keeps the Redux prohibition', () => {
    expect(section(md, 'User instructions')).toMatch(/never use Redux/i);
    expect(section(md, 'User instructions')).toMatch(/\[#m3\]/);
  });

  it('carries next steps and the final instruction', () => {
    expect(section(md, 'Next steps')).toMatch(/ticket search resolver/);
    expect(section(md, 'Current state')).toMatch(/implement the ticket search resolver now/);
  });
});

describe('handoff accuracy — keyword overlap alone does not change decisions', () => {
  const r = runHandoff(unrelatedChangeScenario());
  const decisions = section(r.markdown, DEC);
  it('keeps PostgreSQL active after an unrelated "change" request', () => {
    expect(decisions.split('### ')[0]).toMatch(/PostgreSQL로 결정/);
    expect(decisions).not.toMatch(/변경되거나 폐기된/);
  });
  it('uses full mode for a short conversation', () => {
    expect(r.stats.mode).toBe('full');
    expect(r.markdown).toMatch(/## \d+\. 전체 대화 원문/);
  });
});

describe('handoff — incremental cache', () => {
  it('reuses analysis for unchanged messages and only analyzes new ones', () => {
    const conv = koreanScenario(20);
    const first = runHandoff(conv);
    expect(first.stats.cacheMisses).toBeGreaterThan(0);
    conv.messages.push({ id: 'new', role: 'user', contents: [{ type: 'text', content: '새로운 요청: 다크 모드를 추가해 주세요.' }] });
    const second = runHandoff(conv, { cache: first.cache });
    expect(second.stats.cacheMisses).toBeLessThanOrEqual(2);
    expect(second.stats.cacheHits).toBeGreaterThan(first.stats.cacheMisses * 0.5);
    expect(second.markdown).toMatch(/다크 모드를 추가해 주세요/);
  });
});

describe('handoff — hidden reasoning', () => {
  it('never copies thinking blocks into the handoff, including the reference index', () => {
    const conv = parseChatGPTConversation(chatgptConversation(), { conversationId: CHATGPT_ID, url: `https://chatgpt.com/c/${CHATGPT_ID}` });
    const thinking = conv.messages[1].contents.find((c) => c.type === 'thinking')?.content ?? '';
    expect(thinking.length).toBeGreaterThan(0);
    const { markdown } = runHandoff(conv);
    for (const line of thinking.split('\n').map((l) => l.replace(/[*#]/g, '').trim()).filter((l) => l.length > 4)) {
      expect(markdown).not.toContain(line);
    }
    // Short conversation: everything is in the transcript, which shows the visible answer text.
    expect(markdown).toMatch(/### \[#m2\] ChatGPT[\s\S]*?원인은 `user`가/);
    expect(markdown).not.toMatch(/## 부록/);
  });
});

describe('handoff noise control — web-search research chat (user report, 2026-10)', () => {
  const r = runHandoff(researchScenario(), { now: Date.UTC(2026, 9, 16) });
  const md = r.markdown;
  const transcript = md.slice(md.search(/\n## \d+\. 전체 대화 원문/));
  const structured = md.slice(0, md.search(/\n## \d+\. 전체 대화 원문/));

  it('drops uncited search results and source lists', () => {
    expect(md).not.toContain('search0.example');
    expect(md).not.toContain('검색 결과');
    expect(transcript).not.toMatch(/\*\*(출처|Sources)\*\*/);
    expect(md).not.toContain('utm_source');
  });

  it('lists each link once, with its title', () => {
    const links = section(md, '참고 링크');
    expect(links.match(/shop\.example\/a\)/g)?.length).toBe(1);
    expect(links).toMatch(/\[앱 A( 요금제)?\]\(https:\/\/shop\.example\/a\)/);
    expect(links).toMatch(/\[OpenThing\]\(https:\/\/github\.com\/example\/openthing\)/);
  });

  it('never flattens tables into bullet lines and strips citation chips from bullets', () => {
    expect(structured).not.toMatch(/^- \|/m);
    expect(structured).not.toMatch(/^- .*\(\[(shop|law)\.example\]/m);
  });

  it('shows a sentence in only one structured section', () => {
    const bullets = structured.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.replace(/\s*\[#m\d+\].*$/, ''));
    expect(new Set(bullets).size).toBe(bullets.length);
  });

  it('keeps message headings below the document outline and omits empty sections', () => {
    expect(transcript).not.toMatch(/^#{1,3} (재배포|결론|유료)/m);
    expect(transcript).toMatch(/^#### 재배포 조건에 대한 라이선스 조사/m);
    expect(md).not.toContain('해당 내용을 찾지 못했습니다');
    expect(section(md, '확정된 주요 결정')).toBe('');
  });

  it('lists the request flow, the open problem and the stated next step', () => {
    const goal = section(md, '목표와 요청 흐름');
    expect(goal).toMatch(/비슷한 오픈소스 있는지 찾아줘 \[#m3\]/);
    expect(goal).toMatch(/라이선스 조건 찾아서 제대로 정리해줘 \[#m5\]/);
    expect(section(md, '미완료 작업')).toMatch(/실제 약관 원문은 확보하지 못했습니다/);
    expect(section(md, '다음에 이어서 할 작업')).toMatch(/남은 핵심은 저작권 표시 조건의 실제 원문 확인입니다/);
    // The whole conversation follows, so "current state" points to the last answer instead of
    // copying its sentences (v1.3.4); the answer itself is in the transcript.
    expect(section(md, '현재 진행 상황')).toMatch(/마지막 AI 응답 \[#m6\]: 아래 대화 원문에 전체가 있습니다/);
    expect(section(md, '현재 진행 상황')).not.toMatch(/먼저 결론부터 말씀드리면/);
    expect(transcript).toMatch(/먼저 결론부터 말씀드리면/);
    // Advice ("~확인해야 합니다") and descriptions of other projects are not the user's tasks.
    expect(section(md, '미완료 작업')).not.toMatch(/동기화 제한도 확인해야 합니다/);
    expect(section(md, '완료한 작업')).not.toMatch(/테마 12개를 자체 제작해 작성했습니다/);
  });
});

describe('handoff — very long messages (real-data shape, 2026-10)', () => {
  // Real ChatGPT sessions often hold most of their text in a few huge messages (a pasted spec, a
  // long report). The transcript clips such messages; their middle must still compete for the
  // budget instead of disappearing (compression lab, docs/compression-lab.md).
  // Every paragraph uses its own words, so paragraphs are not near-duplicates of each other.
  const nouns = ['캐시', '배포', '권한', '색인', '알림', '결제', '로그', '이미지', '세션', '쿼터', '백업', '토큰', '웹훅', '큐', '스키마', '리전', '샤드', '버킷', '정책', '감사'];
  const verbs = ['분리합니다', '줄입니다', '검증합니다', '기록합니다', '재시도합니다', '압축합니다', '암호화합니다', '보관합니다', '격리합니다', '정렬합니다', '나눕니다'];
  const paragraph = (k: number) => {
    const a = nouns[k % 20];
    const b = nouns[(k * 7 + 3) % 20];
    const c = nouns[(k * 13 + 5) % 20];
    return `항목 ${k}: ${a} 계층은 ${b}${k} 단위로 ${verbs[k % 11]}. ${c} 설정 cfg_${a.length}${k}_${b.length}는 ${(k * 37) % 997}ms 기준이고, ${verbs[(k + 5) % 11].replace('니다', '면')} handler${k}()가 ${nouns[(k * 3 + 1) % 20]}${k * 11}을 ${verbs[(k + 3) % 11]}.`;
  };
  const report = Array.from({ length: 600 }, (_, k) => paragraph(k)).join('\n\n');
  const c = makeConv([
    msg('user', '아래 설계 문서를 검토하고 위험한 설정을 찾아 주세요.'),
    msg('assistant', report),
    msg('user', '좋아요. 결제 재시도 부분부터 고쳐 주세요.'),
    msg('assistant', `결제 재시도 설정을 고쳤습니다.\n\n${report.slice(0, 20_000)}`),
  ]);
  const r = runHandoff(c, { now: 0 });
  const md = r.markdown;

  it('keeps excerpts from the middle of a clipped message, within the budget', () => {
    expect(r.stats.mode).toBe('compressed');
    expect(md).toMatch(/\[약 [\d,]+토큰 생략\]/); // localized since v1.3.3 (was English in Korean documents)
    const excerpts = section(md, '중요한 맥락');
    expect(excerpts).toMatch(/\[#m2\]/);
    // A paragraph from the middle of the 600-paragraph report survives as a verbatim excerpt.
    const middle = [...excerpts.matchAll(/항목 (\d+):/g)].map((m) => Number(m[1]));
    expect(middle.some((k) => k > 150 && k < 450)).toBe(true);
    expect(estimateTokens(md)).toBeLessThanOrEqual(handoffBudget(r.stats.sourceTokens) * 1.05);
  });
});

describe('handoff — referential repair (2026-10)', () => {
  it('detects sentences that depend on the previous one', () => {
    for (const t of ['그래서 캐시를 Redis로 옮겼습니다.', '이 방식은 메모리를 줄입니다.', '따라서 롤백이 필요합니다.', 'This means the cache is stale.', 'So we moved it.'])
      expect(ANAPHOR_RE.test(t), t).toBe(true);
    for (const t of ['이미 배포했습니다.', '이번 주에 끝냅니다.', 'Redis를 씁니다.', 'Thisbe is a name.'])
      expect(ANAPHOR_RE.test(t), t).toBe(false);
  });

  it('keeps the sentence before an excerpt that opens with a reference', () => {
    // A long answer whose paragraphs read "X 쪽은 …상황이었습니다. 그래서 handlerN()…": the second
    // sentence carries the facts, the first one says what "그래서" refers to.
    const nouns = ['캐시', '배포', '권한', '색인', '알림', '결제', '로그', '이미지', '세션', '쿼터', '백업', '토큰', '웹훅', '큐', '스키마', '리전', '샤드', '버킷', '정책', '감사'];
    const para = (k: number) =>
      `${nouns[k % 20]} 쪽은 예전 방식 그대로 두면 안 되는 상황이었습니다. 그래서 handler${k}()의 기준값은 cfg_${k}=${(k * 37) % 997}ms이고 대상은 ${nouns[(k * 7 + 3) % 20]}${k * 11}입니다.`;
    const c = makeConv([msg('user', '변경 내역을 정리해 주세요.'), msg('assistant', Array.from({ length: 500 }, (_, k) => para(k)).join('\n\n')), msg('user', '좋아요.'), msg('assistant', '네.')]);
    const lines = runHandoff(c, { now: 0 }).markdown.split('\n');
    let kept = 0;
    let dangling = 0;
    lines.forEach((l, n) => {
      if (!/그래서 handler\d+\(\)/.test(l)) return;
      kept++;
      // The transcript keeps whole paragraphs (both sentences on one line); excerpts are one per line.
      if (!/쪽은 예전 방식/.test(l) && !/쪽은 예전 방식/.test(lines[n - 1] ?? '')) dangling++;
    });
    expect(kept).toBeGreaterThan(30);
    expect(dangling / kept).toBeLessThan(0.1);
  });
});

describe('handoff — decisions, rejections and budget (QA evaluation, 2026-10)', () => {
  // A long project chat in the shape of the QA evaluation: one real decision change, a rejected
  // proposal, a stream of small edit requests ("… 바꿔 주세요") and a shell command shown twice.
  const filler = (k: number) =>
    `모듈${k} 쪽 로그를 확인했습니다. 설정 파일의 타임아웃 값은 ${k % 50}초이고 요청 ${k * 3}건 중 대부분이 정상 처리됐습니다. 캐시 적중률은 ${k % 90}%이고 handler${k}()는 그대로 둡니다.`;
  const m = [
    msg('user', '꽃집 주문·결제 시스템을 만들려고 해요.'),
    msg('assistant', '좋습니다. 데이터 모델부터 잡겠습니다.'),
    msg('user', 'DB는 일단 MongoDB로 하자.'),
    msg('assistant', 'MongoDB 기준으로 스키마를 잡겠습니다.'),
  ];
  for (let k = 0; k < 400; k++) {
    m.push(msg('user', k % 3 === 0 ? `화면${k}의 표 머리글 좀 바꿔 주세요.` : `모듈${k} 로그 좀 보여 줄래요?`));
    m.push(msg('assistant', filler(k)));
    if (k === 120) {
      m.push(msg('user', '조회가 느린데 방법이 있을까요?'), msg('assistant', '조회 속도를 높이려면 Redis 캐시를 도입하는 것도 방법입니다.'));
      m.push(msg('user', '아니요, Redis 캐시는 쓰지 않기로 해요. 운영할 사람이 없어요.'), msg('assistant', '알겠습니다. 쿼리를 다듬겠습니다.'));
    }
    if (k === 200) m.push(msg('user', 'MongoDB 말고 PostgreSQL로 가죠.'), msg('assistant', 'PostgreSQL로 전환하겠습니다.'));
    if (k === 300) m.push(msg('user', '마이그레이션은 어떻게 돌려요?'), msg('assistant', '아래 명령으로 실행합니다.\n\n```bash\nnpm run db:migrate -- --env staging\n```'));
  }
  const c = makeConv(m, '결제');
  const r = runHandoff(c, { now: 0 });
  const md = r.markdown;
  const decisions = section(md, DEC);

  it('is long enough to be compressed', () => {
    expect(r.stats.mode).toBe('compressed');
  });

  it('does not turn edit requests into decisions, but keeps a real change of choice', () => {
    expect(decisions).not.toMatch(/표 머리글/);
    expect(decisions.split('### ')[0]).toMatch(/PostgreSQL로 가죠/);
    expect(subsection(decisions, '변경되거나')).toMatch(/MongoDB로 하자/);
  });

  it('keeps a rejected proposal as a prohibition', () => {
    expect(section(md, CONS)).toMatch(/Redis 캐시는 쓰지 않기로 해요/);
  });

  it('shows a shell command once, in the command list', () => {
    expect(md.match(/npm run db:migrate -- --env staging/g)).toHaveLength(1);
  });

  it('stays within the budget and shrinks with it', () => {
    let prev = Infinity;
    for (const budget of [16_000, 8_000, 4_000]) {
      const t = estimateTokens(runHandoff(c, { now: 0, budgetTokens: budget }).markdown);
      expect(t, `budget ${budget}`).toBeLessThanOrEqual(budget * 1.02);
      expect(t).toBeLessThan(prev);
      prev = t;
    }
  });
});

describe('handoff structure check (verification report)', () => {
  it('accepts every scenario in both languages and modes, and rejects a broken document', () => {
    for (const c of [koreanScenario(), englishScenario(), unrelatedChangeScenario(), researchScenario()]) {
      const r = runHandoff(c, { now: Date.UTC(2026, 9, 16) });
      expect(verifyHandoffMarkdown(r.markdown, r.lang), `${c.title} (${r.stats.mode}, ${r.lang})`).toEqual({ ok: true });
    }
    const md = runHandoff(researchScenario()).markdown;
    expect(verifyHandoffMarkdown(md.replace(/^## \d+\. 현재 진행 상황.*$/m, ''), 'ko').ok).toBe(false);
  });
});

describe('files and images from a real ChatGPT handoff (v1.3.2)', () => {
  it('does not take Korean government domains (.go.kr) for Go files', () => {
    const text = '출처는 [district.go.kr](https://district.go.kr/a/b) 와 www.agency.go.kr 입니다. 코드는 main.go, src/app.ts, config.yaml. 에 있고 ./scripts/run.sh 도 봐요.';
    expect(extractPaths(text)).toEqual(['main.go', 'src/app.ts', 'config.yaml', './scripts/run.sh']);
  });

  it('names attached images instead of copying their signed links', () => {
    const user = msg('user', '이 주스는 원액 함량이 낮은데 괜찮은 제품인가요?');
    user.contents.push({ type: 'image', imageUrl: 'https://chatgpt.com/backend-api/estuary/content?id=file_0001&fn=IMG_0001.jpeg&sig=abc123', alt: '이미지' });
    const answer = msg('assistant', '표시 기준으로 보면 원액 함량이 낮은 편입니다.\n\n![성분표](https://files.example.com/u/label.png?token=secret)');
    const md = runHandoff(makeConv([user, answer]), { now: 0 }).markdown;
    expect(md).toContain('[이미지: IMG_0001.jpeg]');
    expect(md).toContain('[이미지: label.png]');
    expect(md).not.toMatch(/estuary|sig=|token=secret/);
  });
});

describe('handoff details found by comparing real handoffs with full exports (v1.3.3)', () => {
  it('reads sandbox links and Korean file names as whole paths', () => {
    const text = '[결과 PDF](sandbox:/mnt/data/out/회의록_요약.pdf) 와 sandbox:/mnt/data/report_v2.md 를 만들었습니다. C:/Users/dev/app.ts 도 봤어요.';
    expect(extractPaths(text)).toEqual(['/mnt/data/out/회의록_요약.pdf', '/mnt/data/report_v2.md', 'C:/Users/dev/app.ts']);
  });

  it('does not take slash-separated Korean words for paths', () => {
    expect(extractPaths('색은 빨강/파랑/초록 중에 고르고, 설계/구현/검토 순서로 정리했어요. 결과는 ~/notes/색_정리.md 에 있어요.')).toEqual(['~/notes/색_정리.md']);
  });

  it('does not take web links in fetched pages for files', () => {
    expect(extractPaths('[Skills](/docs/en/skills#pass-arguments) are the exception. See [setup](./setup) and `src/index.ts`.')).toEqual(['src/index.ts']);
  });

  it('never ends a clipped line inside a Markdown link', () => {
    const long = `${'가'.repeat(200)} 이 판단은 [**Example Model 1.0**](https://example.com/models/example-model-1.0-flash) 모델로 할 거야. ${'나'.repeat(100)}`;
    for (const max of [205, 230, 240, 260]) {
      const out = clipText(long, max);
      expect(out, `max ${max}`).not.toMatch(/\]\([^)]*$/);
      expect(out.endsWith('…')).toBe(true);
    }
  });

  it('keeps a long last request short in "current state" when the transcript below has it', () => {
    const paste = Array.from({ length: 400 }, (_, i) => `규칙 ${i + 1}: 원고는 존댓말로 쓰고 출처를 반드시 확인합니다. 항목 번호 ${i + 1}을 지킵니다.`).join('\n');
    const c = makeConv([msg('user', paste), msg('assistant', `원고 두 편을 저장했습니다.\n\n${'확인한 내용입니다. '.repeat(300)}`)]);
    const r = runHandoff(c, { now: 0 });
    expect(r.stats.mode).toBe('compressed');
    expect(estimateTokens(r.markdown)).toBeLessThanOrEqual(handoffBudget(r.stats.sourceTokens) * 1.02);
    const current = section(r.markdown, '현재 진행 상황');
    expect(current.length).toBeLessThan(2_500);
    expect(current).toContain('이어지는 내용은 아래 대화 원문');
  });
});

describe('last answer with nothing visible yet (v1.3.3)', () => {
  it('tells the next AI to start from the last request instead of showing an empty answer', () => {
    const answer = msg('assistant', '');
    answer.contents = [{ type: 'thinking', content: '목차부터 다시 정리한다.' }];
    const md = runHandoff(makeConv([msg('user', '보고서를 정리해 주세요.'), msg('assistant', '정리했습니다.'), msg('user', '보고서 전체를 다시 정리해 주세요.'), answer]), { now: 0 }).markdown;
    expect(section(md, '현재 진행 상황')).toMatch(/마지막 AI 응답 \[#m4\]에는 보이는 내용이 없습니다/);
    expect(md).toContain('_(보이는 내용 없음)_');
    expect(md).not.toContain('_(empty)_');
  });
});

describe('revised drafts and the full-transcript index (v1.3.4)', () => {
  const body = [
    '봄맞이 신제품 출시를 알리는 첫 문장입니다. 새로운 텀블러가 오늘부터 판매됩니다.',
    '',
    '보온 12시간, 보냉 24시간을 지키는 이중 진공 구조로 만들었습니다.',
    '용량은 500ml이고 색상은 크림, 세이지, 차콜 세 가지입니다.',
    '가격: 3만원',
    '',
    '#신제품 #텀블러 #봄맞이 이벤트는 이번 주 일요일까지 진행합니다.',
  ];
  const draft = (lines: string[]) => `X 게시물 초안입니다.\n\n${lines.join('\n')}`;
  const v2 = body.map((l) => (l === '가격: 3만원' ? '가격: 2만 9천원' : l));
  const v3 = v2.map((l) => (l.startsWith('용량은') ? '용량은 500ml와 750ml 두 가지이고, 색상은 크림과 차콜만 남겼습니다.' : l));
  const c = makeConv([
    msg('user', '신제품 텀블러 출시 X 게시물 초안 써줘'),
    msg('assistant', draft(body)),
    msg('user', '가격을 2만 9천원으로 바꿔서 다시 써줘'),
    msg('assistant', draft(v2)),
    msg('user', '용량 옵션 추가해서 다시'),
    msg('assistant', draft(v3)),
  ]);
  const r = runHandoff(c, { now: 0 });
  const md = r.markdown;
  const transcript = md.slice(md.search(/\n## \d+\. 전체 대화 원문/));
  const count = (s: string, sub: string) => s.split(sub).length - 1;

  it('shows each repeated draft line once, in the latest draft', () => {
    expect(r.stats.mode).toBe('full');
    expect(count(transcript, '이중 진공 구조로 만들었습니다')).toBe(1);
    expect(count(transcript, '이벤트는 이번 주 일요일까지')).toBe(1);
    expect(transcript).toMatch(/_\(… \d+줄 생략 — 같거나 거의 같은 내용이 아래 \[#m6\]에 있습니다\)_/);
    // The latest draft is complete.
    const last = transcript.slice(transcript.lastIndexOf('[#m6]'));
    for (const l of v3.filter((x) => x.trim())) expect(last).toContain(l);
  });

  it('keeps the lines that changed between drafts', () => {
    expect(transcript).toContain('가격: 3만원');
    expect(transcript).toContain('용량은 500ml이고 색상은 크림, 세이지, 차콜 세 가지입니다.');
  });

  it('never collapses what the user wrote into an AI reply', () => {
    const paste = '이번 시즌 메시지는 "가볍게 들고 다니는 하루"로 정했고, 이 문장은 꼭 그대로 써 주세요.';
    const md2 = runHandoff(makeConv([msg('user', `${paste}\n이 문장으로 초안 써줘`), msg('assistant', `${paste}\n\n초안을 썼습니다.`)]), { now: 0 }).markdown;
    const t2 = md2.slice(md2.search(/\n## \d+\. 전체 대화 원문/));
    expect(count(t2, paste)).toBe(2);
    expect(t2).not.toContain('줄 생략 — 같거나');
  });

  it('keeps the transcript unchanged with the v1.2 layout', () => {
    const old = runHandoff(c, { now: 0, layout: { collapseRepeats: false, fullIndex: false } }).markdown;
    expect(count(old, '이중 진공 구조로 만들었습니다')).toBeGreaterThanOrEqual(3);
    expect(estimateTokens(md)).toBeLessThan(estimateTokens(old));
  });

  it('keeps the sections a short index when the whole conversation follows', () => {
    const goal = section(md, '목표와 요청 흐름');
    expect(goal).not.toContain('답변 요지');
    expect(section(md, '현재 진행 상황')).toMatch(/마지막 AI 응답 \[#m6\]: 아래 대화 원문에 전체가 있습니다/);
    const long = `${'이번 캠페인의 문구 원칙을 정리합니다. '.repeat(20)}마지막으로 해시태그는 세 개까지만.`;
    const md3 = runHandoff(makeConv([msg('user', '초안 써줘'), msg('assistant', '초안입니다.'), msg('user', long), msg('assistant', '반영했습니다.')]), { now: 0 }).markdown;
    const req = section(md3, '현재 진행 상황').split('\n').filter((l) => l.startsWith('> '));
    expect(req.join('\n').length).toBeLessThan(260);
    expect(md3).not.toContain('To the AI reading this');
  });
});

describe('attachments and pasted text (v1.3.5)', () => {
  // Real-data shape (Claude, 2026-10; content synthetic): the first request asks about "the note
  // below" and the note itself is a nameless pasted-text attachment; 80+ messages follow, so the
  // first message is far outside the transcript. The attachment used to be missing entirely.
  const thought = [
    '베란다 텃밭은 햇빛이 드는 시간보다 바람이 지나가는 길을 먼저 봐야 한다.',
    '물은 겉흙이 마른 다음 날 아침에 주고, 화분 받침의 물은 바로 버린다.',
    '상추는 겉잎부터 따면 한 포기로 한 달 넘게 먹을 수 있다.',
  ].join('\n');
  const first = msg('user', '아래 메모 어떻게 생각해?');
  first.contents.push({ type: 'attachment', attachment: { name: '', mime_type: 'txt', size: 900, extractedText: thought } });
  const turns = () =>
    Array.from({ length: 40 }, (_, k) => [
      msg('user', `${k + 1}번째 질문: 화분 ${k + 1}번의 잎이 누렇게 되는 이유를 설명해 줘.`),
      msg('assistant', `화분 ${k + 1}번에 대한 설명입니다. ${'물이 너무 자주 고이면 뿌리가 숨을 쉬지 못해 아래 잎부터 누렇게 됩니다. '.repeat(25)}`),
    ]).flat();
  const c = makeConv([first, msg('assistant', '좋은 메모입니다. 바람길을 먼저 보는 점이 특히 실용적입니다.'), ...turns()]);
  const r = runHandoff(c, { now: 0 });
  const md = r.markdown;

  it('shows the attached text of the first request verbatim, with a pointer from the request', () => {
    expect(r.stats.mode).toBe('compressed');
    const att = section(md, '첨부 자료');
    for (const line of thought.split('\n')) expect(att).toContain(line);
    expect(att).toMatch(/^### 붙여넣은 텍스트 · txt · 약 [\d,]+토큰 \[#m1\]$/m);
    expect(section(md, '목표와 요청 흐름')).toMatch(/- 아래 메모 어떻게 생각해\? \[#m1\]\n- \(첨부 1개: 붙여넣은 텍스트 — 「첨부 자료」\) \[#m1\]/);
    expect(estimateTokens(md)).toBeLessThanOrEqual(handoffBudget(r.stats.sourceTokens) * 1.02);
  });

  it('clips a long attachment to its share of the budget and says so', () => {
    const big = msg('user', '이 문서 검토해 줘');
    big.contents.push({ type: 'attachment', attachment: { name: 'report.md', mime_type: 'text/markdown', extractedText: Array.from({ length: 900 }, (_, i) => `문단 ${i + 1}: 보고서의 이 부분은 실험 결과 ${i + 1}을 설명합니다.`).join('\n') } });
    const r2 = runHandoff(makeConv([big, msg('assistant', '검토했습니다.'), ...turns()]), { now: 0 });
    const att = section(r2.markdown, '첨부 자료');
    expect(att).toContain('문단 1: 보고서의 이 부분은');
    expect(att).toContain('문단 900: 보고서의 이 부분은');
    expect(att).toMatch(/\[약 [\d,]+토큰 생략\]/);
    expect(att).toContain('길어서 앞뒤만 넣었습니다');
    expect(estimateTokens(att)).toBeLessThan(handoffBudget(r2.stats.sourceTokens) * 0.16);
    expect(estimateTokens(r2.markdown)).toBeLessThanOrEqual(handoffBudget(r2.stats.sourceTokens) * 1.02);
  });

  it('lists files and images the record has no text for once, and points into the transcript for recent ones', () => {
    const pdf = msg('user', '이 논문 요약해 줘');
    pdf.contents.push({ type: 'attachment', attachment: { name: 'paper.pdf', mime_type: 'application/pdf' } });
    const last = msg('user', '이 메모도 반영해 줘');
    last.contents.push({ type: 'attachment', attachment: { name: 'memo.txt', mime_type: 'text/plain', extractedText: '메모: 결론을 먼저 쓰고 근거는 세 줄 이내로.' } });
    last.contents.push({ type: 'image', imageUrl: 'https://example.com/a.png', alt: 'screen.png' });
    const r3 = runHandoff(makeConv([pdf, msg('assistant', '요약했습니다.'), ...turns(), last, msg('assistant', '반영했습니다.')]), { now: 0 });
    const att = section(r3.markdown, '첨부 자료');
    expect(att).toMatch(/^### memo\.txt · text\/plain · 약 \d+토큰 \[#m\d+\]\n\n\(내용은 아래 대화 원문 \[#m\d+\]에 있습니다\)/m);
    expect(att).toMatch(/^- paper\.pdf · pdf \[#m1\]$/m);
    expect(att).toMatch(/^- screen\.png \[#m\d+\]$/m);
    expect(att.match(/다시 첨부해 달라고/g)?.length).toBe(1);
    expect(section(r3.markdown, '현재 진행 상황')).toMatch(/> \(첨부 1개: memo\.txt — 아래 대화 원문 \[#m\d+\]\)/);
    // Unnamed uploaded images (ChatGPT) are not listed: the request already reads "이미지".
    const noName = msg('user', '이 화면처럼 바꿔 줘');
    noName.contents.push({ type: 'image', imageUrl: 'https://example.com/b.png' });
    expect(runHandoff(makeConv([noName, msg('assistant', '바꿨습니다.'), ...turns()]), { now: 0 }).markdown).not.toContain('첨부 자료');
  });

  it('English counts agree with one attachment', () => {
    const one = msg('user', 'Please review the attached memo and tell me what to change.');
    one.contents.push({ type: 'attachment', attachment: { name: 'memo.txt', mime_type: 'text/plain', extractedText: 'Memo: lead with the conclusion, keep the evidence to three lines.' } });
    const md = runHandoff(makeConv([one, msg('assistant', 'I reviewed the memo. Move the conclusion to the first line.')]), { now: 0 }).markdown;
    expect(md).toContain('(1 attachment: memo.txt');
    expect(md).not.toContain('1 attachments');
  });

  it('only lists attachments when the whole conversation follows, and leaves them out with the v1.2 layout', () => {
    const short = runHandoff(makeConv([first, msg('assistant', '좋은 메모입니다.')]), { now: 0 });
    expect(short.stats.mode).toBe('full');
    expect(section(short.markdown, '첨부 자료').trim().split('\n').slice(1).filter(Boolean)).toEqual([expect.stringMatching(/^- 붙여넣은 텍스트 · txt · 약 \d+토큰 \[#m1\]$/)]);
    expect(section(short.markdown, '목표와 요청 흐름')).toContain('(첨부 1개: 붙여넣은 텍스트 — 아래 대화 원문 [#m1]) [#m1]');
    expect(runHandoff(c, { now: 0, layout: { attachShare: 0 } }).markdown).not.toContain('첨부 자료');
  });
});
