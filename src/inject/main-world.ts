// Page MAIN-world request observer (tech doc §3). Registered in the manifest with
// "world": "MAIN" at document_start so it can see the requests the AI site itself sends.
//
// It never modifies, blocks or delays requests: wrappers read the URL and headers of a few
// specific API calls and immediately hand control back to the original fetch/XHR. Captured
// values stay in this page's memory only and are handed to the isolated content script on
// request through the window.postMessage bridge.

import {
  BRIDGE_TYPE,
  CONTENT_ID,
  HANDSHAKE_ACTION,
  INJECT_ID,
  createBridgeMessage,
  isBridgeMessage,
  type BridgeMessage,
  type ChatGPTAuthData,
  type GeminiGlobalData,
} from '../shared/bridge-protocol';

type HeaderMap = Record<string, string>;

declare global {
  interface Window {
    __lucianInjected?: boolean;
    WIZ_global_data?: Record<string, unknown>;
  }
}

(() => {
  if (window.__lucianInjected) return; // re-injection guard (manifest + scripting fallback)
  window.__lucianInjected = true;

  const state = {
    chatgpt: { authorization: undefined as string | undefined, extraHeaders: {} as HeaderMap },
    gemini: { reqId: undefined as number | undefined, extHeaders: {} as HeaderMap },
    grok: { headers: {} as HeaderMap },
  };

  function normalizeUrl(input: unknown): string {
    try {
      if (typeof input === 'string') return new URL(input, location.href).href;
      if (input instanceof URL) return input.href;
      if (input && typeof input === 'object' && 'url' in input) return String((input as Request).url);
    } catch {
      /* ignore */
    }
    return '';
  }

  function normalizeHeaders(h: unknown): HeaderMap {
    const out: HeaderMap = {};
    try {
      if (!h) return out;
      if (h instanceof Headers) {
        h.forEach((v, k) => (out[k.toLowerCase()] = v));
      } else if (Array.isArray(h)) {
        for (const pair of h) if (Array.isArray(pair) && pair.length >= 2) out[String(pair[0]).toLowerCase()] = String(pair[1]);
      } else if (typeof h === 'object') {
        for (const [k, v] of Object.entries(h as Record<string, unknown>)) out[k.toLowerCase()] = String(v);
      }
    } catch {
      /* ignore */
    }
    return out;
  }

  function onTargetMatch(url: string, headers: HeaderMap): void {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return;
    }
    const host = u.hostname;
    if ((host === 'chatgpt.com' || host === 'chat.openai.com') && u.pathname.startsWith('/backend-api/')) {
      const auth = headers['authorization'];
      if (auth && /^bearer\s+\S+/i.test(auth)) state.chatgpt.authorization = auth;
      for (const [k, v] of Object.entries(headers)) {
        if (k.startsWith('oai-') || k.startsWith('chatgpt-')) state.chatgpt.extraHeaders[k] = v;
      }
      return;
    }
    if (host === 'gemini.google.com' && u.pathname.includes('/_/BardChatUi/data/')) {
      const reqid = Number(u.searchParams.get('_reqid'));
      if (Number.isFinite(reqid) && reqid > 0) state.gemini.reqId = reqid;
      for (const [k, v] of Object.entries(headers)) if (k.startsWith('x-goog-ext-')) state.gemini.extHeaders[k] = v;
      return;
    }
    if (host === 'grok.com' && u.pathname.startsWith('/rest/')) {
      for (const [k, v] of Object.entries(headers)) {
        if (k.startsWith('x-') && k !== 'x-requested-with') state.grok.headers[k] = v;
      }
    }
  }

  function isTargetRequest(url: string): boolean {
    return /\/backend-api\/|\/_\/BardChatUi\/data\/|grok\.com\/rest\//.test(url);
  }

  // ---- fetch wrapper (tech doc §3.3) ----
  const originalFetch = window.fetch;
  const wrappedFetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    try {
      const url = normalizeUrl(input);
      if (url && isTargetRequest(url)) {
        const headers = {
          ...(input instanceof Request ? normalizeHeaders(input.headers) : {}),
          ...normalizeHeaders(init?.headers),
        };
        onTargetMatch(url, headers);
      }
    } catch {
      /* observation must never break the page */
    }
    return originalFetch.apply(this as typeof window, [input, init] as [RequestInfo | URL, RequestInit | undefined]);
  };
  try {
    Object.defineProperty(wrappedFetch, 'name', { value: 'fetch' });
    window.fetch = wrappedFetch as typeof window.fetch;
  } catch {
    /* ignore */
  }

  // ---- XHR wrapper (tech doc §3.4) ----
  const xhrMeta = new WeakMap<XMLHttpRequest, { url: string; headers: HeaderMap }>();
  const proto = XMLHttpRequest.prototype;
  const originalOpen = proto.open;
  const originalSetHeader = proto.setRequestHeader;
  const originalSend = proto.send;
  proto.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    try {
      xhrMeta.set(this, { url: normalizeUrl(typeof url === 'string' ? url : url.href), headers: {} });
    } catch {
      /* ignore */
    }
    return (originalOpen as (...a: unknown[]) => void).apply(this, [method, url, ...rest]);
  } as typeof proto.open;
  proto.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string) {
    try {
      const meta = xhrMeta.get(this);
      if (meta) meta.headers[name.toLowerCase()] = value;
    } catch {
      /* ignore */
    }
    return originalSetHeader.call(this, name, value);
  };
  proto.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    try {
      const meta = xhrMeta.get(this);
      if (meta && isTargetRequest(meta.url)) onTargetMatch(meta.url, meta.headers);
    } catch {
      /* ignore */
    }
    return originalSend.call(this, body);
  };

  // ---- bridge handlers (tech doc §3.5) ----
  function geminiGlobalData(): GeminiGlobalData {
    const g = window.WIZ_global_data ?? {};
    const str = (k: string) => (typeof g[k] === 'string' ? (g[k] as string) : undefined);
    return { sid: str('FdrFJe'), bl: str('cfb2h'), at: str('SNlM0e'), hl: document.documentElement.lang || undefined };
  }

  const handlers: Record<string, (data: unknown) => unknown> = {
    [HANDSHAKE_ACTION]: () => ({ ok: true }),
    getChatGPTAuthHeader: (): ChatGPTAuthData => ({
      authorization: state.chatgpt.authorization,
      extraHeaders: { ...state.chatgpt.extraHeaders },
    }),
    getGeminiGlobalData: () => geminiGlobalData(),
    getGeminiLatestReqId: () => state.gemini.reqId ?? null,
    getGeminiExtHeaders: () => ({ ...state.gemini.extHeaders }),
    getGrokHeaders: () => ({ ...state.grok.headers }),
  };

  function respond(req: BridgeMessage, success: boolean, data?: unknown, error?: string): void {
    const res = createBridgeMessage(INJECT_ID, req.action, data, false, req.id);
    res.success = success;
    if (error) res.error = error;
    window.postMessage(res, location.origin);
  }

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!isBridgeMessage(msg) || msg.type !== BRIDGE_TYPE || msg.communicationId !== CONTENT_ID || msg.requestId) return;
    const handler = handlers[msg.action];
    if (!handler) {
      if (msg.needResponse) respond(msg, false, undefined, `unknown action: ${msg.action}`);
      return;
    }
    try {
      const data = handler(msg.data);
      if (msg.needResponse) respond(msg, true, data);
    } catch (e) {
      if (msg.needResponse) respond(msg, false, undefined, e instanceof Error ? e.message : String(e));
    }
  });
})();
