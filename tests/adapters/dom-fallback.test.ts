import { Window } from 'happy-dom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chatgptAdapter } from '../../src/content/adapters/chatgpt';
import type { AdapterContext } from '../../src/content/adapters/types';
import { domFallbackExtract } from '../../src/content/dom-fallback';

// Markup reduced from the chatgpt.com conversation layout observed in 2026-10 (text is synthetic).
const CHATGPT_2026_10 = `
<main><div class="thread">
  <div data-turn-key="t1">
    <div class="group/user-message" data-chatgpt-search-unit-key="u-1" data-chatgpt-search-message-ids="m1">
      <div class="w-full"><div data-user-message-bubble="true"><div class="whitespace-pre-wrap">첫 질문입니다.
둘째 줄</div></div></div>
    </div>
    <div data-chatgpt-search-unit-key="a-1"><h4 class="sr-only" data-conversation-role="assistant">ChatGPT의 말:</h4>
      <button>12초 동안 생각함</button><p>첫 <strong>답변</strong>입니다.</p><pre><code class="language-ts">const a = 1;</code></pre></div>
  </div>
  <div data-turn-key="t2">
    <div class="group/user-message" data-chatgpt-search-unit-key="u-2"><div data-user-message-bubble="true"><div class="whitespace-pre-wrap">두 번째 질문</div></div></div>
    <div data-chatgpt-search-unit-key="a-2"><h4 class="sr-only" data-conversation-role="assistant">ChatGPT의 말:</h4><p>두 번째 답변</p></div>
  </div>
</div></main>`;

// After in-app navigation chatgpt.com (2026-10) keeps the previous conversation mounted inside a
// `display: none` container next to the one on screen. Text is synthetic.
const HIDDEN_PREVIOUS = `
<div style="display: none"><div class="thread">
  <div data-turn-key="p1"><div class="group/user-message" data-chatgpt-search-unit-key="pu-1"><div data-user-message-bubble="true"><div class="whitespace-pre-wrap">이전 대화 질문 1</div></div></div>
    <div data-chatgpt-search-unit-key="pa-1"><h4 class="sr-only" data-conversation-role="assistant">ChatGPT의 말:</h4><p>이전 대화 답변 1</p></div></div>
  <div data-turn-key="p2"><div class="group/user-message" data-chatgpt-search-unit-key="pu-2"><div data-user-message-bubble="true"><div class="whitespace-pre-wrap">이전 대화 질문 2</div></div></div>
    <div data-chatgpt-search-unit-key="pa-2"><h4 class="sr-only" data-conversation-role="assistant">ChatGPT의 말:</h4><p>이전 대화 답변 2</p></div></div>
  <div data-turn-key="p3"><div class="group/user-message" data-chatgpt-search-unit-key="pu-3"><div data-user-message-bubble="true"><div class="whitespace-pre-wrap">이전 대화 질문 3</div></div></div></div>
</div></div>`;

const win = new Window({ url: 'https://chatgpt.com/c/abc' });
const saved: Record<string, unknown> = {};
const GLOBALS = ['window', 'document', 'Node', 'Element', 'HTMLElement', 'getComputedStyle'] as const;

beforeAll(() => {
  for (const k of GLOBALS) {
    saved[k] = (globalThis as Record<string, unknown>)[k];
    const v = (win as unknown as Record<string, unknown>)[k];
    (globalThis as Record<string, unknown>)[k] = typeof v === 'function' && k === 'getComputedStyle' ? v.bind(win) : k === 'window' ? win : v;
  }
  win.document.body.innerHTML = CHATGPT_2026_10;
});

afterAll(() => {
  for (const k of GLOBALS) (globalThis as Record<string, unknown>)[k] = saved[k];
});

describe('ChatGPT DOM fallback (2026-10 layout)', () => {
  it('reads user bubbles and assistant blocks in order without screen-reader labels', async () => {
    const ctx: AdapterContext = { url: 'https://chatgpt.com/c/abc', bridge: {} as AdapterContext['bridge'], timer: { networkMs: 0, parseMs: 0 }, progress: () => undefined };
    const conv = await domFallbackExtract('chatgpt', ctx, 'abc');
    expect(conv.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(conv.messages[0].contents[0].content).toBe('첫 질문입니다.\n둘째 줄');
    const a1 = conv.messages[1].contents[0].content ?? '';
    expect(a1).toContain('첫 **답변**입니다.');
    expect(a1).toContain('```ts\nconst a = 1;\n```');
    expect(a1).not.toContain('ChatGPT의 말');
    expect(a1).not.toContain('생각함');
    expect(conv.extraction.method).toBe('dom');
    expect(chatgptAdapter.countDomUserTurns()).toBe(2);
  });

  it('ignores an earlier conversation that stays mounted but hidden (v1.3.2)', async () => {
    win.document.body.innerHTML = HIDDEN_PREVIOUS + CHATGPT_2026_10;
    // Before the fix this counted 5 and the handoff warned that 3 user messages were missing.
    expect(chatgptAdapter.countDomUserTurns()).toBe(2);
    const ctx: AdapterContext = { url: 'https://chatgpt.com/c/abc', bridge: {} as AdapterContext['bridge'], timer: { networkMs: 0, parseMs: 0 }, progress: () => undefined };
    const conv = await domFallbackExtract('chatgpt', ctx, 'abc');
    expect(conv.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(conv.messages.flatMap((m) => m.contents.map((c) => c.content ?? '')).join('\n')).not.toContain('이전 대화');
  });
});
