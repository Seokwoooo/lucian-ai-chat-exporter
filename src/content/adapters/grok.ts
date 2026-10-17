// Grok adapter (tech doc §9): read the response-node tree, load every response body with
// load-responses, follow the newest branch (createTime) and drop unfinished `partial` nodes.

import { SITES } from '../../shared/sites';
import type { BranchMessages, Conversation, ExportContent, ExportMessage, SkippedNode, SourceRef } from '../../shared/types';
import { cleanUrl, hostLabel, toEpochMs, urlKey } from '../../shared/util';
import { domFallbackExtract } from '../dom-fallback';
import { ExtractError, cleanTitle, fetchJson, renderedElements, titleFromFirstUserMessage, type AdapterContext, type SiteAdapter } from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

const LOAD_CHUNK = 50;
const ASSET_BASE = 'https://assets.grok.com/';

function assetUrl(path: unknown): string | undefined {
  if (typeof path !== 'string' || !path) return undefined;
  if (/^https?:\/\//i.test(path)) return path;
  return ASSET_BASE + path.replace(/^\//, '');
}

/** Replaces Grok's inline citation markup with source links and strips UI-only tags. */
export function cleanGrokMarkdown(text: string, results: SourceRef[], cited: Set<number> = new Set()): string {
  let out = text.replace(/<grok:render\b[^>]*>([\s\S]*?)<\/grok:render>/gi, (_m, inner: string) => {
    const id = inner.match(/<argument\s+name="citation_id">\s*(\d+)\s*<\/argument>/i)?.[1];
    if (id != null) {
      const src = results[Number(id)];
      if (src?.url) {
        cited.add(Number(id));
        return ` ([${hostLabel(src.url)}](${cleanUrl(src.url)}))`;
      }
    }
    return '';
  });
  out = out.replace(/<grok:render\b[^>]*\/>/gi, '');
  out = out.replace(/<xai:[a-z_]+\b[^>]*>[\s\S]*?<\/xai:[a-z_]+>/gi, '');
  return out;
}

export function convertGrokResponse(r: Json): ExportContent[] {
  const out: ExportContent[] = [];
  const results: SourceRef[] = [];
  for (const w of r.webSearchResults ?? []) {
    if (w?.url) results.push({ url: w.url, title: w.title, snippet: w.preview });
  }
  if (typeof r.thinkingTrace === 'string' && r.thinkingTrace.trim()) out.push({ type: 'thinking', content: r.thinkingTrace });
  const cited = new Set<number>();
  const text = typeof r.message === 'string' ? cleanGrokMarkdown(r.message, results, cited).trim() : '';
  if (text) out.push({ type: r.sender === 'human' ? 'text' : 'markdown', content: text });
  for (const p of r.generatedImageUrls ?? []) {
    const url = assetUrl(p);
    if (url) out.push({ type: 'image', imageUrl: url, linkType: 'private' });
  }
  for (const img of r.imageAttachments ?? []) {
    const url = assetUrl(typeof img === 'string' ? img : img?.url ?? img?.imageUrl);
    if (url) out.push({ type: 'image', imageUrl: url, linkType: 'private' });
  }
  const meta: Json[] = r.fileAttachmentsMetadata ?? [];
  const metaById = new Map(meta.map((m) => [m?.fileMetadataId ?? m?.id, m]));
  for (const f of r.fileAttachments ?? []) {
    const id = typeof f === 'string' ? f : f?.fileMetadataId ?? f?.id;
    const m = metaById.get(id) ?? (typeof f === 'object' ? f : undefined);
    const mime: string | undefined = m?.fileMimeType ?? m?.mimeType;
    if (mime?.startsWith('image/') && m?.fileUri) {
      out.push({ type: 'image', imageUrl: assetUrl(m.fileUri), linkType: 'private', alt: m.fileName });
    } else {
      out.push({ type: 'attachment', attachment: { name: m?.fileName ?? String(id ?? 'file'), mime_type: mime, fileId: id, url: assetUrl(m?.fileUri) } });
    }
  }
  // Documents list the cited results; the other search results stay in JSON/ZIP (moreSources).
  if (results.length) {
    const seen = new Set<string>();
    const pick = (list: SourceRef[]) =>
      list.filter((x) => (seen.has(urlKey(x.url)) ? false : (seen.add(urlKey(x.url)), true))).map((x) => ({ ...x, url: cleanUrl(x.url) }));
    const sources = pick(results.filter((_, i) => cited.has(i)));
    const more = pick(results.filter((_, i) => !cited.has(i)));
    out.push({ type: 'sources', sources, moreSources: more.length ? more : undefined });
  }
  return out;
}

export interface GrokParseInput {
  conversationId: string;
  url: string;
  title?: string;
  createTime?: string;
  nodes: Json[];
  responses: Json[];
}

/** Picks the newest leaf by createTime and returns the path from root (tech doc §9 P9). */
export function selectGrokPath(nodes: Json[], byId: Map<string, Json>): string[] {
  const parentOf = new Map<string, string | undefined>();
  const hasChild = new Set<string>();
  for (const n of nodes) {
    parentOf.set(n.responseId, n.parentResponseId || undefined);
    if (n.parentResponseId) hasChild.add(n.parentResponseId);
  }
  const leaves = nodes.map((n) => n.responseId).filter((id) => !hasChild.has(id));
  let leaf: string | undefined;
  let best = -Infinity;
  for (const id of leaves) {
    const t = toEpochMs(byId.get(id)?.createTime) ?? 0;
    if (t >= best) {
      best = t;
      leaf = id;
    }
  }
  if (!leaf) return [];
  const path: string[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = leaf;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    path.push(cur);
    cur = parentOf.get(cur);
  }
  return path.reverse();
}

function convertIds(ids: string[], byId: Map<string, Json>) {
  const messages: ExportMessage[] = [];
  const missing: string[] = [];
  const skipped: SkippedNode[] = [];
  let visible = 0;
  for (const id of ids) {
    const r = byId.get(id);
    if (!r) {
      visible++;
      missing.push(id);
      continue;
    }
    if (r.partial) {
      skipped.push({ id, reason: 'partial' });
      continue;
    }
    visible++;
    const contents = convertGrokResponse(r);
    if (!contents.length) {
      missing.push(id);
      continue;
    }
    messages.push({
      id,
      ids: [id],
      role: r.sender === 'human' ? 'user' : 'assistant',
      model: r.sender === 'human' ? undefined : r.model || undefined,
      created_at: toEpochMs(r.createTime),
      contents,
    });
  }
  return { messages, missing, skipped, visible };
}

export function parseGrokConversation(input: GrokParseInput): Conversation {
  const byId = new Map<string, Json>(input.responses.filter((r) => r?.responseId).map((r) => [r.responseId, r]));
  let pathIds = selectGrokPath(input.nodes, byId);
  if (!pathIds.length) {
    pathIds = [...byId.values()].sort((a, b) => (toEpochMs(a.createTime) ?? 0) - (toEpochMs(b.createTime) ?? 0)).map((r) => r.responseId);
  }
  const main = convertIds(pathIds, byId);

  const onPath = new Set(pathIds);
  const hasChild = new Set(input.nodes.map((n) => n.parentResponseId).filter(Boolean));
  const parentOf = new Map(input.nodes.map((n) => [n.responseId, n.parentResponseId]));
  const otherBranchMessages: BranchMessages[] = [];
  for (const n of input.nodes) {
    if (hasChild.has(n.responseId) || onPath.has(n.responseId)) continue;
    const chain: string[] = [];
    let cur: string | undefined = n.responseId;
    const seen = new Set<string>();
    while (cur && !onPath.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      chain.push(cur);
      cur = parentOf.get(cur);
    }
    const conv = convertIds(chain.reverse(), byId);
    if (conv.messages.length) otherBranchMessages.push({ leafId: n.responseId, pathIds: chain, create_time: toEpochMs(byId.get(n.responseId)?.createTime) ?? null, messages: conv.messages });
    if (otherBranchMessages.length >= 200) break;
  }

  const conv: Conversation = {
    title: input.title ?? '',
    pageId: input.conversationId,
    fromUrl: input.url,
    site: 'grok',
    siteName: SITES.grok.name,
    createAt: toEpochMs(input.createTime) ?? main.messages[0]?.created_at,
    lastUpdateAt: main.messages[main.messages.length - 1]?.created_at,
    pageType: 'fullPage',
    model: [...main.messages].reverse().find((m) => m.model)?.model,
    messages: main.messages,
    otherBranchMessages: otherBranchMessages.length ? otherBranchMessages : undefined,
    extraction: { method: 'api', sourceNodeCount: main.visible, missingNodeIds: main.missing, skipped: main.skipped, warnings: [], fetchedAt: Date.now() },
  };
  if (!conv.title) conv.title = titleFromFirstUserMessage(conv);
  return conv;
}

export const grokAdapter: SiteAdapter = {
  site: 'grok',

  async getAllChatsForTopic(ctx: AdapterContext, conversationId: string) {
    const base = `${location.origin}/rest/app-chat/conversations`;
    const id = encodeURIComponent(conversationId);
    let title = '';
    let createTime: string | undefined;
    try {
      const detail = await fetchJson<Json>(ctx, `${location.origin}/rest/app-chat/conversations_v2/${id}`, { retries: 0, timeoutMs: 20_000 });
      title = detail?.conversation?.title ?? '';
      createTime = detail?.conversation?.createTime;
    } catch {
      /* title is optional */
    }
    if (!title) title = cleanTitle(document.title, 'Grok');

    const nodeData = await fetchJson<Json>(ctx, `${base}/${id}/response-node?includeThreads=true`, { timeoutMs: 60_000 });
    const nodes: Json[] = Array.isArray(nodeData?.responseNodes) ? nodeData.responseNodes : [];
    if (!nodes.length) throw new ExtractError('EMPTY', 'no response nodes');
    const ids = [...new Set(nodes.map((n) => n.responseId).filter(Boolean))] as string[];
    const responses: Json[] = [];
    for (let i = 0; i < ids.length; i += LOAD_CHUNK) {
      const chunk = ids.slice(i, i + LOAD_CHUNK);
      const data = await fetchJson<Json>(ctx, `${base}/${id}/load-responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ responseIds: chunk }),
        timeoutMs: 120_000,
      });
      if (Array.isArray(data?.responses)) responses.push(...data.responses);
      ctx.progress('messages', responses.length, ids.length);
    }
    const t0 = performance.now();
    const conv = parseGrokConversation({ conversationId, url: ctx.url, title, createTime, nodes, responses });
    ctx.timer.parseMs += performance.now() - t0;
    return conv;
  },

  countDomUserTurns() {
    const bubbles = renderedElements('div[class*="items-end"] .message-bubble');
    return bubbles.length > 0 ? bubbles.length : undefined;
  },

  actionBars() {
    // Assistant rows are `[id^=response-]` without `items-end` (user rows are right-aligned).
    const bars: Element[] = [];
    for (const row of document.querySelectorAll('[id^="response-"]')) {
      if (row.classList.contains('items-end')) continue;
      const bar = row.querySelector('.action-buttons');
      if (bar) bars.push(bar.firstElementChild ?? bar);
    }
    return bars;
  },

  domFallback(ctx, conversationId) {
    return domFallbackExtract('grok', ctx, conversationId);
  },
};
