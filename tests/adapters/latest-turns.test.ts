// The page's newest turns, as server ids (v1.3.10). When every one of them is in the saved copy,
// a 429 is not waited out and the copy is used at once. Markup mirrors what the four sites carried
// on 2026-10-22 (checked against their APIs); text and ids are synthetic.

import { Window } from 'happy-dom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { latestTurnIds } from '../../src/content/dom-fallback';
import { copyIsCurrent, copyTail } from '../../src/shared/saved-copy';
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
  <div data-chatgpt-search-unit-key="a-1" data-chatgpt-search-message-ids="n-t1 n-a1"><p>답변</p></div>
  <div data-chatgpt-search-unit-key="u-2" data-chatgpt-search-message-ids="n-u2"><div data-user-message-bubble="true"><div class="whitespace-pre-wrap">다음 질문</div></div></div>
  <div data-chatgpt-search-unit-key="a-2" data-chatgpt-search-message-ids="n-a2"><p>다음 답변</p></div>
</div></main>`;

const CLAUDE = `<div data-index="0"><div data-turn-key="c-u1"><div data-testid="user-message">질문</div></div></div>
<div data-index="1" data-last-message="true"><div data-turn-key="c-a1"><div data-testid="assistant-message"><div class="font-claude-response">답변</div></div></div></div>`;

const GEMINI = `<div class="conversation-container" id="9f1e0c2b7a6d5e4f"><user-query><div class="query-text">질문</div></user-query><model-response><message-content id="message-content-id-r_9f1e0c2b7a6d5e4f"><div class="markdown">답변</div></message-content></model-response></div>`;

const GROK = `<div id="response-g-u1" class="items-end"><div class="message-bubble">질문</div></div><div id="response-g-a1" class="items-start"><div class="message-bubble">답변</div></div>`;

describe('latestTurnIds', () => {
  it('reads the server ids each site puts on its messages', () => {
    page(CHATGPT);
    expect(latestTurnIds('chatgpt')?.sort()).toEqual(['n-a1', 'n-a2', 'n-t1', 'n-u1', 'n-u2']);
    page(CLAUDE);
    expect(latestTurnIds('claude')?.sort()).toEqual(['c-a1', 'c-u1']);
    page(GEMINI);
    expect(latestTurnIds('gemini')).toEqual(['r_9f1e0c2b7a6d5e4f']);
    page(GROK);
    expect(latestTurnIds('grok')?.sort()).toEqual(['g-a1', 'g-u1']);
  });

  it('is null when the page carries no ids or no messages', () => {
    page('<div data-message-author-role="user"><div class="whitespace-pre-wrap">q</div></div>');
    expect(latestTurnIds('chatgpt')).toBeNull();
    page('');
    expect(latestTurnIds('grok')).toBeNull();
  });

  it('is null when the list is scrolled up (newest turns unmounted below)', () => {
    page(`<div id="scroller" style="overflow-y: auto">${CHATGPT}</div>`);
    const scroller = win.document.getElementById('scroller')!;
    Object.defineProperty(scroller, 'scrollHeight', { value: 40_000, configurable: true });
    Object.defineProperty(scroller, 'clientHeight', { value: 800 });
    const last = [...win.document.querySelectorAll('[data-chatgpt-search-unit-key]')].pop()!;
    (last as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () => ({ top: 700, bottom: 760, left: 0, right: 0, width: 0, height: 60, x: 0, y: 700 }) as DOMRect;
    expect(latestTurnIds('chatgpt')).toBeNull();
    Object.defineProperty(scroller, 'scrollHeight', { value: 1_200, configurable: true }); // at the end
    expect(latestTurnIds('chatgpt')?.length).toBe(5);
  });

  it('is null when one of the newest turns carries no ids (it cannot be compared)', () => {
    page(CHATGPT.replace(' data-chatgpt-search-message-ids="n-u2"', ''));
    expect(latestTurnIds('chatgpt')).toBeNull();
  });

  it('is null when the newest message is a question (its answer is missing or drawn without ids, e.g. an image)', () => {
    page(CHATGPT.replace(/\n {2}<div data-chatgpt-search-unit-key="a-2"[^\n]*/, '\n  <div><img src="blob:x" alt=""></div>'));
    expect(latestTurnIds('chatgpt')).toBeNull();
  });

  // chatgpt.com, 2026-10-22: a long-running answer ("Worked for 34m") is drawn after the question as
  // a work log with only a work-activity id that several turns share.
  const turn = (answer = '') => `<div data-talvt-turn-state="complete"><div><div data-chatgpt-search-unit-key="u-3" data-chatgpt-search-message-ids="n-u3"><div data-user-message-bubble="true"><div class="whitespace-pre-wrap">세 번째 질문</div></div></div></div>
    <div style="display: contents"><span data-chatgpt-agent-turn-start="" style="display: none"></span><div data-local-conversation-item-target-ids="w-1%3Aexec-1">Worked for 34m</div></div>${answer}</div>`;

  it('ChatGPT: a work log after the last question cannot be compared; one before the answer can', () => {
    page(CHATGPT.replace('</div></main>', `${turn()}</div></main>`));
    expect(latestTurnIds('chatgpt')).toBeNull();
    const answered = turn('<div data-chatgpt-search-unit-key="a-3" data-chatgpt-search-message-ids="n-a3"><p>답변</p></div>');
    page(CHATGPT.replace('</div></main>', `${answered}</div></main>`));
    expect(latestTurnIds('chatgpt')?.sort()).toEqual(['n-a2', 'n-a3', 'n-u2', 'n-u3']);
  });

  it('ChatGPT: a turn still being written cannot be compared', () => {
    page(CHATGPT.replace('<div class="thread">', '<div class="thread"><div data-talvt-turn-state="streaming">'));
    expect(latestTurnIds('chatgpt')).toBeNull();
  });

  it('Claude: trusts the row the site marks as the last message', () => {
    page(CLAUDE.replace(' data-last-message="true"', '') + '<div data-index="2" data-last-message="true"><div data-turn-key="c-u2"></div></div>');
    // The marked newest row holds no rendered message: the page is not showing the end.
    expect(latestTurnIds('claude')).toBeNull();
  });
});

describe('copyIsCurrent', () => {
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
      { id: 'n-a2', ids: ['n-a2'], role: 'assistant', contents: [{ type: 'markdown', content: '다음 답변' }] },
    ],
    // A thinking node the document leaves out still belongs to the path.
    extraction: { method: 'api', sourceNodeCount: 4, missingNodeIds: [], skipped: [{ id: 'n-t1', reason: 'empty' }], warnings: [], fetchedAt: 0 },
  };

  it('holds when every newest id on the page is in the copy, skipped nodes included', () => {
    page(CHATGPT);
    expect(copyIsCurrent(latestTurnIds('chatgpt'), copyTail(conv))).toBe(true);
  });

  it('fails for a newer, regenerated or edited turn, an unfinished copy, or no page ids', () => {
    page(CHATGPT.replace('n-a2', 'n-a3')); // the last answer regenerated
    expect(copyIsCurrent(latestTurnIds('chatgpt'), copyTail(conv))).toBe(false);
    page(CHATGPT);
    expect(copyIsCurrent(latestTurnIds('chatgpt'), { ...copyTail(conv), inProgress: true })).toBe(false);
    expect(copyIsCurrent(null, copyTail(conv))).toBe(false);
    page(CHATGPT.replace('n-u2', 'n-u3'));
    expect(copyIsCurrent(latestTurnIds('chatgpt'), copyTail(conv))).toBe(false);
    expect(copyIsCurrent(['n-u2'], undefined)).toBe(false);
  });

  it('Gemini: "<response id>:q" user ids match the turn id on the page', () => {
    const g: Conversation = { ...conv, site: 'gemini', messages: [{ id: 'r_9f1e0c2b7a6d5e4f:q', ids: ['r_9f1e0c2b7a6d5e4f:q'], role: 'user', contents: [{ type: 'text', content: 'q' }] }, { id: 'rc_77', ids: ['rc_77'], role: 'assistant', contents: [{ type: 'markdown', content: 'a' }] }], extraction: { ...conv.extraction, skipped: [] } };
    page(GEMINI);
    expect(copyIsCurrent(latestTurnIds('gemini'), copyTail(g))).toBe(true);
  });
});
