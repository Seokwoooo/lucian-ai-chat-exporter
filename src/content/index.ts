// Isolated-world content script (tech doc §4): picks the adapter for the current site, collects
// the full conversation and streams it to the service worker in chunks over a long-lived port.
// It adds no UI to the page and does nothing until the extension asks for a conversation.

import { COLLECT_PORT, type AssetRequest, type FromContent, type ToContent } from '../shared/messages';
import { detectSite, extractConversationId } from '../shared/sites';
import type { Conversation, SiteId } from '../shared/types';
import { bytesToBase64, mapLimit, sniffImageMime } from '../shared/util';
import { chatgptAdapter } from './adapters/chatgpt';
import { claudeAdapter } from './adapters/claude';
import { geminiAdapter } from './adapters/gemini';
import { grokAdapter } from './adapters/grok';
import { ExtractError, type AdapterContext, type SiteAdapter } from './adapters/types';
import { Bridge } from './bridge';

declare global {
  interface Window {
    __lucianContentLoaded?: boolean;
  }
}

const ADAPTERS: Record<SiteId, SiteAdapter> = {
  chatgpt: chatgptAdapter,
  claude: claudeAdapter,
  gemini: geminiAdapter,
  grok: grokAdapter,
};

const MAX_ASSET_BYTES = 25 * 1024 * 1024;
const CHUNK_MESSAGES = 200;
const CHUNK_CHARS = 3_000_000;

if (!window.__lucianContentLoaded) {
  window.__lucianContentLoaded = true;
  const bridge = new Bridge();
  void bridge.handshake();
  let busy = false;
  let lastConversationId: string | null = null;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'lucian-ping') {
      const site = detectSite(location.href);
      sendResponse({ ok: true, site, conversationId: site ? extractConversationId(site, location.href) : null, busy });
    }
    return false;
  });

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== COLLECT_PORT) return;
    const post = (m: FromContent) => {
      try {
        port.postMessage(m);
      } catch {
        /* port closed (service worker restarted); nothing to do */
      }
    };
    const site = detectSite(location.href);
    const adapter = site ? ADAPTERS[site] : null;
    const ctx: AdapterContext = {
      url: location.href,
      bridge,
      timer: { networkMs: 0, parseMs: 0 },
      progress: (label, done, total) => post({ type: 'progress', label, done, total }),
    };

    port.onMessage.addListener(async (msg: ToContent) => {
      if (!adapter || !site) {
        post({ type: 'error', code: 'NOT_SUPPORTED' });
        return;
      }
      if (msg.type === 'collect') {
        if (busy) {
          post({ type: 'error', code: 'BUSY' });
          return;
        }
        busy = true; // tech doc §21.1 in-flight flag
        try {
          ctx.url = location.href;
          const conversationId = extractConversationId(site, location.href);
          if (!conversationId) throw new ExtractError('NOT_CONVERSATION');
          lastConversationId = conversationId;
          const conv = await collect(adapter, ctx, conversationId);
          streamConversation(conv, post);
        } catch (e) {
          const code = e instanceof ExtractError ? e.code : 'UNKNOWN';
          post({ type: 'error', code, message: e instanceof Error ? e.message : String(e) });
        } finally {
          busy = false;
        }
      } else if (msg.type === 'assets') {
        await fetchAssets(adapter, ctx, lastConversationId ?? '', msg.items, post);
        post({ type: 'assets-done' });
      }
    });
  });
}

async function collect(adapter: SiteAdapter, ctx: AdapterContext, conversationId: string): Promise<Conversation> {
  let conv: Conversation;
  try {
    conv = await adapter.getAllChatsForTopic(ctx, conversationId);
    if (!conv.messages.length) throw new ExtractError('EMPTY');
  } catch (apiError) {
    // Internal APIs change; fall back to the rendered page so the user still gets a result,
    // and record the reason so the verification report can say how the data was obtained.
    try {
      conv = await adapter.domFallback(ctx, conversationId);
      conv.extraction.warnings.push(`api-failed:${apiError instanceof ExtractError ? apiError.code : 'UNKNOWN'}`);
    } catch {
      throw apiError;
    }
  }
  conv.extraction.domUserTurns = adapter.countDomUserTurns();
  conv.extraction.networkMs = Math.round(ctx.timer.networkMs);
  conv.extraction.parseMs = Math.round(ctx.timer.parseMs);
  return conv;
}

function streamConversation(conv: Conversation, post: (m: FromContent) => void): void {
  const { messages, otherBranchMessages, ...meta } = conv;
  post({ type: 'meta', conversation: meta });
  let chunk: typeof messages = [];
  let chars = 0;
  for (const m of messages) {
    chunk.push(m);
    for (const c of m.contents) chars += (c.content?.length ?? 0) + 64;
    if (chunk.length >= CHUNK_MESSAGES || chars >= CHUNK_CHARS) {
      post({ type: 'messages', messages: chunk });
      chunk = [];
      chars = 0;
    }
  }
  if (chunk.length) post({ type: 'messages', messages: chunk });
  const branches = otherBranchMessages ?? [];
  for (let i = 0; i < branches.length; i += 20) post({ type: 'branches', branches: branches.slice(i, i + 20) });
  post({ type: 'done' });
}

async function fetchBytes(url: string): Promise<{ bytes: Uint8Array; mime?: string }> {
  const sameOrigin = new URL(url, location.href).origin === location.origin;
  const modes: RequestCredentials[] = sameOrigin ? ['include'] : ['omit', 'include'];
  let lastErr: unknown;
  for (const credentials of modes) {
    try {
      const res = await fetch(url, { credentials });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const len = Number(res.headers.get('content-length') ?? 0);
      if (len > MAX_ASSET_BYTES) throw new Error('too-large');
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength > MAX_ASSET_BYTES) throw new Error('too-large');
      return { bytes: buf, mime: res.headers.get('content-type') ?? undefined };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('fetch failed');
}

async function fetchAssets(
  adapter: SiteAdapter,
  ctx: AdapterContext,
  conversationId: string,
  items: AssetRequest[],
  post: (m: FromContent) => void,
): Promise<void> {
  let done = 0;
  await mapLimit(items, 4, async (item) => {
    try {
      let url = item.url;
      if ((!url || url.startsWith('chatgpt-file://')) && item.fileId && adapter.resolveAssetUrl) {
        url = await adapter.resolveAssetUrl({ key: item.key, url: item.url, fileId: item.fileId }, conversationId, ctx);
      }
      if (!url || !/^(https?:|data:)/.test(url)) throw new Error('no-url');
      let bytes: Uint8Array;
      let mime: string | undefined;
      if (url.startsWith('data:')) {
        const m = url.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
        if (!m) throw new Error('bad-data-url');
        mime = m[1];
        bytes = m[2] ? Uint8Array.from(atob(m[3]), (c) => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(m[3]));
      } else {
        ({ bytes, mime } = await fetchBytes(url));
      }
      const sniffed = item.kind === 'image' ? sniffImageMime(bytes) : undefined;
      if (item.kind === 'image' && !sniffed) throw new Error('not-an-image');
      post({ type: 'asset', key: item.key, ok: true, mime: sniffed ?? mime?.split(';')[0], base64: bytesToBase64(bytes), size: bytes.byteLength });
    } catch (e) {
      post({ type: 'asset', key: item.key, ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      done++;
      post({ type: 'progress', label: 'assets', done, total: items.length });
    }
  });
}
