import { describe, expect, it } from 'vitest';
import { runHandoff } from '../../src/handoff/engine';
import { verifyHandoffMarkdown } from '../../src/handoff/render';
import { englishScenario, koreanScenario, researchScenario, unrelatedChangeScenario } from '../fixtures/handoff-scenarios';
import { parseChatGPTConversation } from '../../src/content/adapters/chatgpt';
import { CHATGPT_ID, chatgptConversation } from '../fixtures/sites';

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
    expect(code).toMatch(/tauri::Builder/);
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
    expect(md).toMatch(/## 부록\. 메시지 참조 색인/);
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
    expect(section(md, '현재 진행 상황')).toMatch(/먼저 결론부터 말씀드리면/);
    // Advice ("~확인해야 합니다") and descriptions of other projects are not the user's tasks.
    expect(section(md, '미완료 작업')).not.toMatch(/동기화 제한도 확인해야 합니다/);
    expect(section(md, '완료한 작업')).not.toMatch(/테마 12개를 자체 제작해 작성했습니다/);
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

