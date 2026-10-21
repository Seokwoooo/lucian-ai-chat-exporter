// Gemini adapter (tech doc §6): batchexecute RPC `hNvQHb` with WIZ_global_data values
// (FdrFJe → f.sid, cfb2h → bl, SNlM0e → at), the observed `_reqid` (+100000) and x-goog-ext-*
// headers, and cursor pagination until the whole history is loaded.

import type { GeminiGlobalData } from '../../shared/bridge-protocol';
import { SITES } from '../../shared/sites';
import type { Conversation, ExportContent, ExportMessage, SkippedNode } from '../../shared/types';
import { domFallbackExtract } from '../dom-fallback';
import {
  ExtractError,
  cleanTitle,
  RATE_LIMIT_WAIT_MS,
  fetchWithRetry,
  renderedElements,
  titleFromFirstUserMessage,
  type AdapterContext,
  type SiteAdapter,
} from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export const GEMINI_RPC_READ_CHAT = 'hNvQHb';
export const GEMINI_PAGE_SIZE = 10;
const MAX_PAGES = 2000;

/** Tech doc §6.3 U2: strips the )]}' guard and splits the length-prefixed frames. */
export function parseBatchExecute(text: string): Json[] {
  let body = text.replace(/^\s+/, '');
  if (body.startsWith(")]}'")) body = body.slice(4);
  const frames: Json[] = [];
  // Frames are "<length>\n<json>\n". JSON payloads never contain raw newlines, so a line based
  // pass is reliable; lengths are only used as a fallback when a line fails to parse.
  const lines = body.split('\n');
  let pendingLen: number | null = null;
  let buffer = '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^\d+$/.test(trimmed) && !buffer) {
      pendingLen = Number(trimmed);
      continue;
    }
    buffer = buffer ? `${buffer}\n${line}` : line;
    try {
      frames.push(JSON.parse(buffer));
      buffer = '';
      pendingLen = null;
    } catch {
      if (pendingLen != null && buffer.length > pendingLen + 16) buffer = ''; // give up on a broken frame
    }
  }
  return frames;
}

/** Tech doc §6.3 oZ: finds the hNvQHb payload and returns the page items (oldest first) and cursor. */
export function extractReadChatPage(frames: Json[]): { items: Json[]; continueCursor: string | null } | null {
  for (const frame of frames) {
    if (!Array.isArray(frame)) continue;
    for (const entry of frame) {
      if (!Array.isArray(entry) || entry[0] !== 'wrb.fr' || entry[1] !== GEMINI_RPC_READ_CHAT) continue;
      if (typeof entry[2] !== 'string') return { items: [], continueCursor: null };
      let payload: Json;
      try {
        payload = JSON.parse(entry[2]);
      } catch {
        throw new ExtractError('PARSE', 'hNvQHb payload');
      }
      const items: Json[] = Array.isArray(payload?.[0]) ? [...payload[0]] : [];
      items.reverse(); // the RPC lists the newest turn first
      const cursor = typeof payload?.[1] === 'string' && payload[1] ? payload[1] : null;
      return { items, continueCursor: cursor };
    }
  }
  return null;
}

const IMAGE_HOST = /^https:\/\/lh3\.googleusercontent\.com\//;
const PLACEHOLDER = /https?:\/\/googleusercontent\.com\/[a-z_]+_content\/\d+(?:_\d+)*\s*/g;

function collectImageUrls(value: Json, skipIndex?: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (v: Json, depth: number) => {
    if (depth > 12) return;
    if (typeof v === 'string') {
      if (IMAGE_HOST.test(v) && !seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
    }
  };
  if (Array.isArray(value)) value.forEach((v, i) => i !== skipIndex && walk(v, 0));
  return out;
}

function tsOf(v: Json): number | undefined {
  if (Array.isArray(v) && typeof v[0] === 'number') return v[0] * 1000 + Math.floor((typeof v[1] === 'number' ? v[1] : 0) / 1e6);
  return undefined;
}

function modelOf(candidate: Json[]): string | undefined {
  for (let i = candidate.length - 1; i >= Math.max(0, candidate.length - 20); i--) {
    const v = candidate[i];
    if (typeof v === 'string' && /^\d+(\.\d+)?\s?(Pro|Flash|Ultra|Nano|Thinking)/i.test(v)) return v;
  }
  return undefined;
}

/** Tech doc §6.4 FC: converts one turn into a user and an assistant message. */
export function convertGeminiTurn(turn: Json): { messages: ExportMessage[]; missing: string[]; missingKinds: string[]; skipped: SkippedNode[]; visible: number } {
  const messages: ExportMessage[] = [];
  const missing: string[] = [];
  const missingKinds: string[] = [];
  const skipped: SkippedNode[] = [];
  let visible = 0;
  const ids = Array.isArray(turn?.[0]) ? turn[0] : [];
  const responseId: string = typeof ids[1] === 'string' ? ids[1] : `turn-${Math.random().toString(36).slice(2)}`;
  const answer = turn?.[3];
  const time = tsOf(turn?.[4]) ?? tsOf(answer?.[1]);

  const promptText = turn?.[2]?.[0]?.[0];
  const userContents: ExportContent[] = [];
  if (typeof promptText === 'string' && promptText.length) userContents.push({ type: 'text', content: promptText });
  for (const url of collectImageUrls(turn?.[2], undefined)) userContents.push({ type: 'image', imageUrl: url, linkType: 'private' });
  if (userContents.length) {
    visible++;
    messages.push({ id: `${responseId}:q`, ids: [`${responseId}:q`], role: 'user', created_at: time, contents: userContents });
  } else if (turn?.[2] != null) {
    visible++;
    missing.push(`${responseId}:q`);
    missingKinds.push('user:prompt');
  }

  if (Array.isArray(answer)) {
    const cands: Json[] = Array.isArray(answer[0]) ? answer[0] : [];
    const chosen = typeof answer[3] === 'string' ? answer[3] : undefined;
    const cand = (chosen && cands.find((c) => Array.isArray(c) && c[0] === chosen)) || cands[0];
    if (Array.isArray(cand)) {
      visible++;
      const raw = typeof cand[1]?.[0] === 'string' ? cand[1][0] : '';
      const text = raw.replace(PLACEHOLDER, '').trim();
      const contents: ExportContent[] = [];
      if (text) contents.push({ type: 'markdown', content: text });
      for (const url of collectImageUrls(cand, 1)) contents.push({ type: 'image', imageUrl: url, linkType: 'private' });
      const id = typeof cand[0] === 'string' ? cand[0] : `${responseId}:a`;
      if (contents.length) {
        messages.push({ id, ids: [id], role: 'assistant', model: modelOf(cand), created_at: time, contents });
      } else {
        missing.push(id);
        missingKinds.push('assistant:answer');
      }
    } else {
      skipped.push({ id: responseId, reason: 'no-candidate' });
    }
  } else {
    skipped.push({ id: responseId, reason: 'answer-pending' });
  }
  return { messages, missing, missingKinds, skipped, visible };
}

export function buildGeminiConversation(items: Json[], opts: { conversationId: string; url: string; title: string; pages: number }): Conversation {
  const messages: ExportMessage[] = [];
  const missing: string[] = [];
  const missingKinds: string[] = [];
  const skipped: SkippedNode[] = [];
  let visible = 0;
  const seen = new Set<string>();
  for (const turn of items) {
    const key = JSON.stringify(turn?.[0] ?? null);
    if (seen.has(key)) continue; // pages may overlap
    seen.add(key);
    const r = convertGeminiTurn(turn);
    messages.push(...r.messages);
    missing.push(...r.missing);
    missingKinds.push(...r.missingKinds);
    skipped.push(...r.skipped);
    visible += r.visible;
  }
  const conv: Conversation = {
    title: opts.title,
    pageId: opts.conversationId,
    fromUrl: opts.url,
    site: 'gemini',
    siteName: SITES.gemini.name,
    createAt: messages[0]?.created_at,
    lastUpdateAt: messages[messages.length - 1]?.created_at,
    pageType: 'fullPage',
    model: [...messages].reverse().find((m) => m.model)?.model,
    messages,
    extraction: { method: 'api', sourceNodeCount: visible, missingNodeIds: missing, missingKinds, skipped, pages: opts.pages, warnings: [], fetchedAt: Date.now() },
  };
  if (!conv.title) conv.title = titleFromFirstUserMessage(conv);
  return conv;
}

/** Fallback when the bridge is unavailable: read WIZ_global_data values from inline scripts. */
function scrapeGlobalData(): GeminiGlobalData {
  const out: GeminiGlobalData = {};
  const scripts = document.querySelectorAll('script');
  for (const s of Array.from(scripts)) {
    const text = s.textContent ?? '';
    if (!text.includes('WIZ_global_data') && !text.includes('SNlM0e')) continue;
    out.at ??= text.match(/"SNlM0e":"([^"]+)"/)?.[1];
    out.sid ??= text.match(/"FdrFJe":"([^"]+)"/)?.[1];
    out.bl ??= text.match(/"cfb2h":"([^"]+)"/)?.[1];
  }
  out.hl = document.documentElement.lang || undefined;
  return out;
}

function domTitle(): string {
  const selectors = [
    '[data-test-id="conversation"].selected .conversation-title',
    '.conversation.selected .conversation-title',
    'conversations-list a[aria-current="page"]',
    '[data-test-id="conversation-title"]',
  ];
  for (const sel of selectors) {
    const t = document.querySelector(sel)?.textContent?.trim();
    if (t) return t;
  }
  const t = cleanTitle(document.title, 'Gemini');
  return t && t.toLowerCase() !== 'gemini' ? t : '';
}

export const geminiAdapter: SiteAdapter = {
  site: 'gemini',

  async getAllChatsForTopic(ctx: AdapterContext, conversationId: string) {
    const bridged = await ctx.bridge.request<GeminiGlobalData>('getGeminiGlobalData');
    const scraped = bridged?.at ? undefined : scrapeGlobalData();
    const g: GeminiGlobalData = { ...(scraped ?? {}), ...(bridged ?? {}) };
    if (!g.at) throw new ExtractError('AUTH', 'Gemini request token (SNlM0e) not found');
    const latest = await ctx.bridge.request<number | null>('getGeminiLatestReqId');
    let reqId = typeof latest === 'number' && latest > 0 ? latest + 100_000 : 100_000 + Math.floor(Math.random() * 800_000);
    const ext = (await ctx.bridge.request<Record<string, string>>('getGeminiExtHeaders')) ?? {};
    const account = location.pathname.match(/^\/u\/\d+/)?.[0] ?? '';
    const hl = (g.hl || navigator.language || 'en').split('-')[0];

    const fetchPage = async (cursor: string | null) => {
      const params = new URLSearchParams({
        rpcids: GEMINI_RPC_READ_CHAT,
        'source-path': location.pathname,
        hl,
        _reqid: String(reqId),
        rt: 'c',
      });
      if (g.bl) params.set('bl', g.bl);
      if (g.sid) params.set('f.sid', g.sid);
      reqId += 100_000;
      const form = new URLSearchParams();
      const args = JSON.stringify([`c_${conversationId}`, GEMINI_PAGE_SIZE, cursor, 1, [0], [4], null, 1]);
      form.append('f.req', JSON.stringify([[[GEMINI_RPC_READ_CHAT, args, null, 'generic']]]));
      form.append('at', g.at!);
      const res = await fetchWithRetry(ctx, `${location.origin}${account}/_/BardChatUi/data/batchexecute?${params}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'X-Same-Domain': '1', ...ext },
        body: form.toString(),
        retries: 1,
        timeoutMs: 60_000,
        rateLimitWaitMs: RATE_LIMIT_WAIT_MS,
      });
      const text = await res.text();
      const t0 = performance.now();
      const page = extractReadChatPage(parseBatchExecute(text));
      ctx.timer.parseMs += performance.now() - t0;
      if (!page) throw new ExtractError('PARSE', 'hNvQHb frame missing');
      return page;
    };

    // Tech doc §6.4 hZ: request pages with the cursor and prepend older items.
    const all: Json[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    for (;;) {
      const page = await fetchPage(cursor);
      pages++;
      ctx.progress('pages', pages);
      if (!page.items.length) break;
      all.unshift(...page.items);
      ctx.progress('messages', all.length * 2);
      // The documented loop also stops when a page is shorter than the page size. We keep
      // following the cursor instead, because a server-side cap below our page size would
      // otherwise end collection early and silently drop older turns.
      cursor = page.continueCursor;
      if (!cursor || seenCursors.has(cursor) || pages >= MAX_PAGES) break;
      seenCursors.add(cursor);
    }
    const t0 = performance.now();
    const conv = buildGeminiConversation(all, { conversationId, url: ctx.url, title: domTitle(), pages });
    ctx.timer.parseMs += performance.now() - t0;
    if (pages >= MAX_PAGES) conv.extraction.warnings.push('max-pages-reached');
    return conv;
  },

  countDomUserTurns() {
    const n = renderedElements('user-query').length;
    return n > 0 ? n : undefined;
  },

  actionBars() {
    return [...document.querySelectorAll('model-response message-actions .buttons-container-v2')];
  },

  // The toolbar is [thumbs, copy, more] then a flex `.spacer` that fills the row (checked
  // 2026-10-21): appended after it, the button stood alone at the far right.
  actionAnchor(bar) {
    return bar.querySelector(':scope > .spacer');
  },

  domFallback(ctx, conversationId) {
    return domFallbackExtract('gemini', ctx, conversationId);
  },
};
