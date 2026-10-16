import { describe, expect, it } from 'vitest';
import { runHandoff } from '../../src/handoff/engine';
import { englishScenario, koreanScenario, unrelatedChangeScenario } from '../fixtures/handoff-scenarios';

/** Returns the body of the "## {prefix}…" section (until the next level-2 heading). */
function section(md: string, prefix: string): string {
  const start = md.indexOf(`\n## ${prefix}`);
  if (start < 0) return '';
  const rest = md.slice(start + 1);
  const end = rest.indexOf('\n## ', 3);
  return end < 0 ? rest : rest.slice(0, end);
}

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
  const decisions = section(md, '2.');
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
    const cons = section(md, '3.');
    expect(cons).toMatch(/jQuery는 사용하지 마세요/);
    expect(cons).toMatch(/2회 반복 강조/);
  });

  it('lists important file paths and the latest code', () => {
    const code = section(md, '9.');
    expect(code).toMatch(/src-tauri\/tauri\.conf\.json/);
    expect(code).toMatch(/src\/main\.rs/);
    expect(code).toMatch(/tauri::Builder/);
  });

  it('separates completed work from open work', () => {
    expect(section(md, '4.')).toMatch(/초기 설정을 완료했습니다/);
    const open = section(md, '6.') + section(md, '7.');
    expect(open).toMatch(/자동 업데이트/);
    expect(open).toMatch(/코드 서명/);
  });

  it('records the failure cause', () => {
    expect(section(md, '8.')).toMatch(/Xcode 명령줄 도구/);
  });

  it('shows the final user instruction as the current state', () => {
    const cur = section(md, '5.');
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
  const decisions = section(md, '2.');
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
    expect(section(md, '3.')).toMatch(/never use Redux/i);
    expect(section(md, '3.')).toMatch(/\[#m3\]/);
  });

  it('carries next steps and the final instruction', () => {
    expect(section(md, '7.')).toMatch(/ticket search resolver/);
    expect(section(md, '5.')).toMatch(/implement the ticket search resolver now/);
  });
});

describe('handoff accuracy — keyword overlap alone does not change decisions', () => {
  const r = runHandoff(unrelatedChangeScenario());
  const decisions = section(r.markdown, '2.');
  it('keeps PostgreSQL active after an unrelated "change" request', () => {
    expect(decisions.split('### ')[0]).toMatch(/PostgreSQL로 결정/);
    expect(decisions).not.toMatch(/변경되거나 폐기된/);
  });
  it('uses full mode for a short conversation', () => {
    expect(r.stats.mode).toBe('full');
    expect(r.markdown).toMatch(/## 11\. 전체 대화 원문/);
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
