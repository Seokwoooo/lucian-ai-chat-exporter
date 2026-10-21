// The page's newest turns: server ids and the last answer's text (v1.3.10). When the saved copy
// holds all of them and its last answer reads the same, a 429 is not waited out and the copy is used
// at once. Markup mirrors what the four sites carried
// on 2026-10-22 (checked against their APIs); text and ids are synthetic.

import { Window } from 'happy-dom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { latestTurns } from '../../src/content/dom-fallback';
import { copyIsCurrent, copyTail, plainKey } from '../../src/shared/saved-copy';
import type { Conversation } from '../../src/shared/types';

const win = new Window({ url: 'https://chatgpt.com/c/abc' });
const saved: Record<string, unknown> = {};
const GLOBALS = ['window', 'document', 'Node', 'Element', 'HTMLElement', 'getComputedStyle'] as const;

beforeAll(() => {
  for (const k of GLOBALS) {
    saved[k] = (globalThis as Record<string, unknown>)[k];
    const v = (win as unknown as Record<string, unknown>)[k];
    (globalThis as Record<string, unknown>)[k] = typeof v === 'function' && k === 'getComputedStyle' ? v.bind(win) : k === 'window' ? win : v;
  }
});

afterAll(() => {
  for (const k of GLOBALS) (globalThis as Record<string, unknown>)[k] = saved[k];
});

const page = (html: string) => {
  win.document.body.innerHTML = html;
};

const CHATGPT = `<main><div class="thread">
  <div data-chatgpt-search-unit-key="u-1" data-chatgpt-search-message-ids="n-u1"><div data-user-message-bubble="true"><div class="whitespace-pre-wrap">질문</div></div></div>
  <div data-chatgpt-search-unit-key="a-1" data-chatgpt-search-message-ids="n-t1 n-a1"><div class="markdown"><p>답변</p></div></div>
  <div data-chatgpt-search-unit-key="u-2" data-chatgpt-search-message-ids="n-u2"><div data-user-message-bubble="true"><div class="whitespace-pre-wrap">다음 질문</div></div></div>
  <div data-chatgpt-search-unit-key="a-2" data-chatgpt-search-message-ids="n-a2"><div class="markdown"><p>다음 답변은 <a href="https://example.com/x?utm_source=y">예시 링크</a>와 함께 끝납니다. 확인해 보세요!</p></div></div>
</div></main>`;

// claude.ai, 2026-10-22: a question row's key is its uuid; an answer row's key is its question's
// uuid + "-hub-reply" (the answer's own uuid is not on the page).
const CLAUDE = `<div data-index="0"><div data-turn-key="c-u1"><div data-testid="user-message">질문</div></div></div>
<div data-index="1" data-last-message="true"><div data-testid="assistant-message" data-turn-key="c-u1-hub-reply" data-is-streaming="false"><div class="font-claude-response">답변입니다</div><div data-testid="message-actions"></div></div></div>`;

const GEMINI = `<div class="conversation-container" id="9f1e0c2b7a6d5e4f"><user-query><div class="query-text">질문</div></user-query><model-response><message-content id="message-content-id-r_9f1e0c2b7a6d5e4f"><div class="markdown">답변</div></message-content></model-response></div>`;

const GROK = `<div id="response-g-u1" class="items-end"><div class="message-bubble">질문</div></div><div id="response-g-a1" class="items-start"><div class="message-bubble">답변</div></div>`;

describe('latestTurns', () => {
  it('reads the server ids each site puts on its messages, and the last answer as text', () => {
    page(CHATGPT);
    expect(latestTurns('chatgpt')?.ids.sort()).toEqual(['n-a1', 'n-a2', 'n-t1', 'n-u1', 'n-u2']);
    expect(latestTurns('chatgpt')?.answer).toBe(plainKey('다음 답변은 예시 링크와 함께 끝납니다. 확인해 보세요!'));
    page(CLAUDE);
    expect(latestTurns('claude')).toEqual({ ids: ['c-u1'], answer: '답변입니다' });
    page(GEMINI);
    expect(latestTurns('gemini')).toEqual({ ids: ['r_9f1e0c2b7a6d5e4f'], answer: '답변' });
    page(GROK);
    expect(latestTurns('grok')?.ids.sort()).toEqual(['g-a1', 'g-u1']);
  });

  it('is null when the page carries no ids or no messages, or the answer shows no text', () => {
    page('<div data-message-author-role="user"><div class="whitespace-pre-wrap">q</div></div>');
    expect(latestTurns('chatgpt')).toBeNull();
    page('');
    expect(latestTurns('grok')).toBeNull();
    page(GROK.replace('<div class="message-bubble">답변</div>', '<div class="message-bubble"><img src="blob:x" alt=""></div>'));
    expect(latestTurns('grok')).toBeNull();
  });

  it('is null when the list is scrolled up (newest turns unmounted below)', () => {
    page(`<div id="scroller" style="overflow-y: auto">${CHATGPT}</div>`);
    const scroller = win.document.getElementById('scroller')!;
    Object.defineProperty(scroller, 'scrollHeight', { value: 40_000, configurable: true });
    Object.defineProperty(scroller, 'clientHeight', { value: 800 });
    const last = [...win.document.querySelectorAll('[data-chatgpt-search-unit-key]')].pop()!;
    (last as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () => ({ top: 700, bottom: 760, left: 0, right: 0, width: 0, height: 60, x: 0, y: 700 }) as DOMRect;
    expect(latestTurns('chatgpt')).toBeNull();
    Object.defineProperty(scroller, 'scrollHeight', { value: 1_200, configurable: true }); // at the end
    expect(latestTurns('chatgpt')?.ids.length).toBe(5);
  });

  it('is null when one of the newest turns carries no ids (it cannot be compared)', () => {
    page(CHATGPT.replace(' data-chatgpt-search-message-ids="n-u2"', ''));
    expect(latestTurns('chatgpt')).toBeNull();
  });

  it('is null when the newest message is a question (its answer is missing or drawn without ids, e.g. an image)', () => {
    page(CHATGPT.replace(/\n {2}<div data-chatgpt-search-unit-key="a-2"[^\n]*/, '\n  <div><img src="blob:x" alt=""></div>'));
    expect(latestTurns('chatgpt')).toBeNull();
  });

  // chatgpt.com, 2026-10-22: a long-running answer ("Worked for 34m") is drawn after the question as
  // a work log with only a work-activity id that several turns share.
  const turn = (answer = '') => `<div data-talvt-turn-state="complete"><div><div data-chatgpt-search-unit-key="u-3" data-chatgpt-search-message-ids="n-u3"><div data-user-message-bubble="true"><div class="whitespace-pre-wrap">세 번째 질문</div></div></div></div>
    <div style="display: contents"><span data-chatgpt-agent-turn-start="" style="display: none"></span><div data-local-conversation-item-target-ids="w-1%3Aexec-1">Worked for 34m</div></div>${answer}</div>`;

  it('ChatGPT: a work log after the last question cannot be compared; one before the answer can', () => {
    page(CHATGPT.replace('</div></main>', `${turn()}</div></main>`));
    expect(latestTurns('chatgpt')).toBeNull();
    const answered = turn('<div data-chatgpt-search-unit-key="a-3" data-chatgpt-search-message-ids="n-a3"><div class="markdown"><p>답변</p></div></div>');
    page(CHATGPT.replace('</div></main>', `${answered}</div></main>`));
    expect(latestTurns('chatgpt')?.ids.sort()).toEqual(['n-a2', 'n-a3', 'n-u2', 'n-u3']);
  });

  it('a turn still being written cannot be compared (ChatGPT turn state, Claude streaming row)', () => {
    page(CHATGPT.replace('<div class="thread">', '<div class="thread"><div data-talvt-turn-state="streaming">'));
    expect(latestTurns('chatgpt')).toBeNull();
    page(CLAUDE.replace('data-is-streaming="false"', 'data-is-streaming="true"'));
    expect(latestTurns('claude')).toBeNull();
  });

  it('Claude: trusts the row the site marks as the last message', () => {
    page(CLAUDE.replace(' data-last-message="true"', '') + '<div data-index="2" data-last-message="true"><div data-turn-key="c-u2"></div></div>');
    // The marked newest row holds no rendered message: the page is not showing the end.
    expect(latestTurns('claude')).toBeNull();
  });
});

describe('copyIsCurrent', () => {
  const LAST = '다음 답변은 [예시 링크](https://example.com/x?utm_source=y)와 함께 끝납니다. 확인해 보세요!';
  const conv: Conversation = {
    title: 't',
    pageId: 'x',
    fromUrl: 'https://chatgpt.com/c/x',
    site: 'chatgpt',
    siteName: 'ChatGPT',
    pageType: 'fullPage',
    messages: [
      { id: 'n-u1', ids: ['n-u1'], role: 'user', contents: [{ type: 'text', content: '질문' }] },
      { id: 'n-a1', ids: ['n-a1'], role: 'assistant', contents: [{ type: 'markdown', content: '답변' }] },
      { id: 'n-u2', ids: ['n-u2'], role: 'user', contents: [{ type: 'text', content: '다음 질문' }] },
      { id: 'n-a2', ids: ['n-a2'], role: 'assistant', contents: [{ type: 'thinking', content: '생각' }, { type: 'markdown', content: LAST }] },
    ],
    // A thinking node the document leaves out still belongs to the path.
    extraction: { method: 'api', sourceNodeCount: 4, missingNodeIds: [], skipped: [{ id: 'n-t1', reason: 'empty' }], warnings: [], fetchedAt: 0 },
  };

  it('holds when every newest id on the page is in the copy (skipped nodes included) and the last answer reads the same', () => {
    page(CHATGPT);
    expect(copyTail(conv).answer).toBe(plainKey('다음 답변은 예시 링크와 함께 끝납니다. 확인해 보세요!').slice(-40));
    expect(copyIsCurrent(latestTurns('chatgpt'), copyTail(conv))).toBe(true);
  });

  it('fails for a newer, regenerated or edited turn, an unfinished copy, or no page ids', () => {
    page(CHATGPT.replace('n-a2', 'n-a3')); // the last answer regenerated
    expect(copyIsCurrent(latestTurns('chatgpt'), copyTail(conv))).toBe(false);
    page(CHATGPT);
    expect(copyIsCurrent(latestTurns('chatgpt'), { ...copyTail(conv), inProgress: true })).toBe(false);
    expect(copyIsCurrent(null, copyTail(conv))).toBe(false);
    page(CHATGPT.replace('n-u2', 'n-u3'));
    expect(copyIsCurrent(latestTurns('chatgpt'), copyTail(conv))).toBe(false);
    expect(copyIsCurrent({ ids: ['n-u2'], answer: 'x' }, undefined)).toBe(false);
  });

  it('fails when the last answer reads differently under the same ids (regenerated on Claude or Gemini)', () => {
    page(CHATGPT.replace('확인해 보세요!', '다른 답으로 끝납니다.'));
    expect(copyIsCurrent(latestTurns('chatgpt'), copyTail(conv))).toBe(false);
    // A copy that does not end with an answer that has text cannot be compared.
    page(CHATGPT);
    const noText: Conversation = { ...conv, messages: [...conv.messages.slice(0, 3), { id: 'n-a2', ids: ['n-a2'], role: 'assistant', contents: [{ type: 'image', imageUrl: 'x' }] }] };
    expect(copyIsCurrent(latestTurns('chatgpt'), copyTail(noText))).toBe(false);
  });

  it('a short answer must read exactly the same', () => {
    const short = (text: string): Conversation => ({ ...conv, site: 'claude', messages: [{ id: 'c-u1', ids: ['c-u1'], role: 'user', contents: [{ type: 'text', content: '질문' }] }, { id: 'c-a9', ids: ['c-a9'], role: 'assistant', contents: [{ type: 'markdown', content: text }] }], extraction: { ...conv.extraction, skipped: [] } });
    page(CLAUDE);
    expect(copyTail(short('**답변**입니다.')).answerWhole).toBe(true);
    expect(copyIsCurrent(latestTurns('claude'), copyTail(short('**답변**입니다.')))).toBe(true);
    expect(copyIsCurrent(latestTurns('claude'), copyTail(short('입니다')))).toBe(false);
  });

  it('Gemini: "<response id>:q" user ids match the turn id on the page', () => {
    const g: Conversation = { ...conv, site: 'gemini', messages: [{ id: 'r_9f1e0c2b7a6d5e4f:q', ids: ['r_9f1e0c2b7a6d5e4f:q'], role: 'user', contents: [{ type: 'text', content: 'q' }] }, { id: 'rc_77', ids: ['rc_77'], role: 'assistant', contents: [{ type: 'markdown', content: '답변' }] }], extraction: { ...conv.extraction, skipped: [] } };
    page(GEMINI);
    expect(copyIsCurrent(latestTurns('gemini'), copyTail(g))).toBe(true);
  });
});
