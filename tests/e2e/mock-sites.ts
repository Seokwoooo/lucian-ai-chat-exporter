// Request router that impersonates the four AI sites for the E2E test. Responses use the same
// synthetic fixtures as the adapter unit tests. No real service is contacted.

import { makePng } from '../fixtures/sample-conversation';
import {
  CHATGPT_ID,
  CLAUDE_ID,
  CLAUDE_ORG,
  GEMINI_ID,
  GROK_ID,
  chatgptConversation,
  claudeConversation,
  geminiPage,
  grokPayloads,
} from '../fixtures/sites';
import { makeConversation, toChatGPTPayload } from '../fixtures/synthetic';

export interface MockRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  postData?: string;
}

export interface MockResponse {
  status: number;
  headers?: Record<string, string>;
  body: string | Uint8Array;
}

export const FAKE_TOKEN = 'e2e-not-a-real-token';
/** ChatGPT conversation of ~1M tokens used for the end-to-end performance measurement. */
export const BIG_ID = '6710a3b2-9999-4222-8333-944455556666';
let bigPayload: string | undefined;
export const bigConversationJson = () => (bigPayload ??= JSON.stringify(toChatGPTPayload(makeConversation(1_000_000))));
export const PAGES = {
  chatgpt: `https://chatgpt.com/c/${CHATGPT_ID}`,
  claude: `https://claude.ai/chat/${CLAUDE_ID}`,
  gemini: `https://gemini.google.com/app/${GEMINI_ID}`,
  grok: `https://grok.com/c/${GROK_ID}`,
  big: `https://chatgpt.com/c/${BIG_ID}`,
};

const PNG = makePng(480, 270, [90, 100, 230]);
const PDF_BYTES = new TextEncoder().encode('%PDF-1.4\n% e2e attachment\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const CORS = { 'access-control-allow-origin': '*' };

const json = (data: unknown, status = 200): MockResponse => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
const html = (title: string, body: string, head = ''): MockResponse => ({
  status: 200,
  headers: { 'content-type': 'text/html; charset=utf-8' },
  body: `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`,
});

/** Toolbar shown under a finished ChatGPT answer (2026-10 structure, synthetic). */
const ICON_BTN = (label: string, d: string) =>
  `<button aria-label="${label}" style="width:32px;height:32px;border:0;border-radius:8px;background:none;color:#5d5d5d;display:inline-flex;align-items:center;justify-content:center"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg></button>`;
const ACTIONS_CHATGPT =
  '<div class="mt-1.5 flex turn-action-controls"><div class="flex min-h-5" style="display:flex;align-items:center;gap:2px">' +
  ICON_BTN('Copy', 'M8 8h11v11H8zM5 16V5h11') +
  ICON_BTN('Good response', 'M7 10v10M7 10l4-7a2 2 0 0 1 3 2l-1 5h6l-2 9H7') +
  ICON_BTN('Regenerate', 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5') +
  ICON_BTN('More actions', 'M6 12h.01M12 12h.01M18 12h.01') +
  '</div></div>';

/** Records which endpoints the extension called, for assertions. */
export const calls: string[] = [];

/** Sites whose conversation API answers 500, so the extension falls back to reading the page. */
export const failApi = new Set<string>();
const API_PATHS: Record<string, RegExp> = {
  'chatgpt.com': /^\/backend-api\/conversation\//,
  'claude.ai': /^\/api\/organizations\/[^/]+\/chat_conversations\//,
  'gemini.google.com': /^\/_\/BardChatUi\/data\/batchexecute/,
  'grok.com': /^\/rest\/app-chat\//,
};
const SITE_OF_HOST: Record<string, string> = { 'chatgpt.com': 'chatgpt', 'claude.ai': 'claude', 'gemini.google.com': 'gemini', 'grok.com': 'grok' };

/**
 * An earlier conversation as single-page sites keep it after in-app navigation: still mounted, but
 * inside a `display: none` container (seen on chatgpt.com, 2026-10). Text is synthetic.
 */
export function hiddenEarlierConversation(site: 'chatgpt' | 'claude' | 'gemini' | 'grok'): string {
  const turn = (n: number) =>
    ({
      chatgpt: `<div data-message-author-role="user"><div data-user-message-bubble="true"><div class="whitespace-pre-wrap">이전 대화 질문 ${n}</div></div></div><div data-message-author-role="assistant"><div class="markdown"><p>이전 대화 답변 ${n}</p></div></div>`,
      claude: `<div data-testid="user-message">이전 대화 질문 ${n}</div><div data-testid="assistant-message"><div class="font-claude-response">이전 대화 답변 ${n}</div></div>`,
      gemini: `<user-query>이전 대화 질문 ${n}</user-query><model-response>이전 대화 답변 ${n}</model-response>`,
      grok: `<div class="items-end"><div class="message-bubble">이전 대화 질문 ${n}</div></div><div class="items-start"><div class="message-bubble">이전 대화 답변 ${n}</div></div>`,
    })[site];
  return `<div style="display: none" data-e2e-earlier>${[1, 2, 3].map(turn).join('')}</div>`;
}

export function route(req: MockRequest): MockResponse | null {
  const u = new URL(req.url);
  const key = `${req.method} ${u.host}${u.pathname}`;
  calls.push(key);
  if (failApi.has(SITE_OF_HOST[u.host]) && API_PATHS[u.host]?.test(u.pathname)) return json({ error: 'e2e: API down' }, 500);

  // ---------- ChatGPT ----------
  if (u.host === 'chatgpt.com') {
    if (u.pathname === `/c/${CHATGPT_ID}`) {
      return html(
        'Null 오류 분석 - ChatGPT',
        '<main><div data-message-author-role="user"><div class="whitespace-pre-wrap">q1</div></div><div class="group/user-message"><div class="turn-action-controls"><div class="flex"><button aria-label="Edit">e</button></div></div></div><div data-message-author-role="assistant"><div class="markdown"><p>a1</p></div></div>' +
          ACTIONS_CHATGPT +
          '<div data-message-author-role="user"><div class="whitespace-pre-wrap">q2</div></div><div data-message-author-role="assistant"><div class="markdown"><p>a2</p></div></div>' +
          ACTIONS_CHATGPT +
          '</main>',
        '<script>document.cookie = "oai-did=e2e-device; path=/";</script>',
      );
    }
    if (u.pathname === `/c/${BIG_ID}`) return html('Synthetic 1M - ChatGPT', '<main><div data-message-author-role="user"><div class="whitespace-pre-wrap">q</div></div></main>');
    if (u.pathname === `/backend-api/conversation/${BIG_ID}`) {
      return { status: 200, headers: { 'content-type': 'application/json' }, body: bigConversationJson() };
    }
    if (u.pathname === '/api/auth/session') return json({ accessToken: FAKE_TOKEN, user: { id: 'e2e' } });
    if (u.pathname === `/backend-api/conversation/${CHATGPT_ID}`) {
      if (req.headers['authorization'] !== `Bearer ${FAKE_TOKEN}`) return json({ detail: 'unauthorized' }, 401);
      return json(chatgptConversation());
    }
    if (u.pathname === '/backend-api/files/download/file_000000001') return json({ status: 'success', download_url: 'https://files.oaiusercontent.com/e2e/screen.png?sig=abc' });
    if (u.pathname === '/backend-api/files/download/file-doc-2') return json({ status: 'success', download_url: 'https://files.oaiusercontent.com/e2e/spec.pdf?sig=abc' });
  }
  if (u.host === 'files.oaiusercontent.com') {
    if (u.pathname === '/e2e/screen.png') return { status: 200, headers: { 'content-type': 'image/png', ...CORS }, body: PNG };
    if (u.pathname === '/e2e/spec.pdf') return { status: 200, headers: { 'content-type': 'application/pdf', ...CORS }, body: PDF_BYTES };
  }

  // ---------- Claude ----------
  if (u.host === 'claude.ai') {
    if (u.pathname === `/chat/${CLAUDE_ID}`) {
      return html(
        'React 컴포넌트 리팩터링 - Claude',
        '<div data-testid="user-message">q</div><div data-testid="assistant-message"><div class="font-claude-response">a</div><div data-testid="message-actions"><button aria-label="Copy">c</button></div></div><div data-testid="user-message">q2</div>',
        `<script>document.cookie = "lastActiveOrg=${CLAUDE_ORG}; path=/";</script>`,
      );
    }
    if (u.pathname === '/api/organizations') return json([{ uuid: CLAUDE_ORG, name: 'e2e', capabilities: ['chat'] }]);
    if (u.pathname === `/api/organizations/${CLAUDE_ORG}/chat_conversations/${CLAUDE_ID}`) {
      if (u.searchParams.get('tree') !== 'True' || u.searchParams.get('render_all_tools') !== 'true') return json({ error: 'bad params' }, 400);
      return json(claudeConversation());
    }
    if (u.pathname === `/api/${CLAUDE_ORG}/files/img-1/preview`) return { status: 200, headers: { 'content-type': 'image/png' }, body: PNG };
  }

  // ---------- Gemini ----------
  if (u.host === 'gemini.google.com') {
    if (u.pathname === `/app/${GEMINI_ID}`) {
      return html(
        'Gemini',
        '<user-query>q1</user-query><model-response>a1<message-actions><div class="buttons-container-v2"><button aria-label="Copy">c</button></div></message-actions></model-response><user-query>q2</user-query>',
        '<script>window.WIZ_global_data = {"SNlM0e":"e2e-at-token","FdrFJe":"-1234567890","cfb2h":"boq_assistant-bard-web-server_e2e"};</script>',
      );
    }
    if (u.pathname === '/_/BardChatUi/data/batchexecute' && u.searchParams.get('rpcids') === 'hNvQHb') {
      const form = new URLSearchParams(req.postData ?? '');
      if (form.get('at') !== 'e2e-at-token') return { status: 400, body: 'missing at' };
      const freq = JSON.parse(form.get('f.req') ?? '[]');
      const args = JSON.parse(freq[0][0][1]);
      if (args[0] !== `c_${GEMINI_ID}`) return { status: 400, body: 'bad id' };
      return { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: geminiPage(args[2]) };
    }
  }
  if (u.host === 'lh3.googleusercontent.com' && u.pathname === '/gemini-test-image') {
    return { status: 200, headers: { 'content-type': 'image/png', ...CORS }, body: PNG };
  }

  // ---------- Grok ----------
  if (u.host === 'grok.com') {
    const p = grokPayloads();
    if (u.pathname === `/c/${GROK_ID}`) return html(
        '날씨 API - Grok',
        '<div id="response-u1" class="items-end"><div class="message-bubble">q</div><div class="action-buttons"><div class="flex"><button aria-label="Edit">e</button></div></div></div>' +
          '<div id="response-a1" class="items-start"><div class="message-bubble">a</div><div class="action-buttons"><div class="flex"><button aria-label="Copy">c</button></div></div></div>',
      );
    if (u.pathname === `/rest/app-chat/conversations_v2/${GROK_ID}`) return json(p.detail);
    if (u.pathname === `/rest/app-chat/conversations/${GROK_ID}/response-node`) return json(p.nodes);
    if (u.pathname === `/rest/app-chat/conversations/${GROK_ID}/load-responses` && req.method === 'POST') {
      const ids: string[] = JSON.parse(req.postData ?? '{}').responseIds ?? [];
      return json({ responses: p.responses.responses.filter((r) => ids.includes(r.responseId)) });
    }
  }
  if (u.host === 'assets.grok.com' && u.pathname === '/users/u1/generated/img1/image.jpg') {
    return { status: 200, headers: { 'content-type': 'image/jpeg', ...CORS }, body: PNG };
  }

  if (u.pathname === '/favicon.ico') return { status: 404, body: '' };
  return null;
}
