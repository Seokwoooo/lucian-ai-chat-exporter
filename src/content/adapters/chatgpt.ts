// ChatGPT adapter (tech doc §5): GET /backend-api/conversation/{id}, restore the message tree
// from `mapping`, follow the branch the user is looking at, and resolve image asset pointers.

import type { ChatGPTAuthData } from '../../shared/bridge-protocol';
import { SITES } from '../../shared/sites';
import type {
  BranchMessages,
  Conversation,
  ExportContent,
  ExportMessage,
  SkippedNode,
  SourceRef,
} from '../../shared/types';
import { mapLimit, toEpochMs } from '../../shared/util';
import { domFallbackExtract } from '../dom-fallback';
import {
  ExtractError,
  fetchJson,
  readCookie,
  type AdapterContext,
  type AssetResolveRequest,
  type SiteAdapter,
} from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

interface ChatGPTNode {
  id: string;
  parent?: string | null;
  children?: string[];
  message?: Json;
}

const POINTER_PREFIX = 'chatgpt-file://';

export function pointerToFileId(pointer: string | undefined): string | undefined {
  if (!pointer || typeof pointer !== 'string') return undefined;
  const m = pointer.match(/^(?:file-service|sediment):\/\/(.+)$/);
  return m ? m[1] : undefined;
}

// ---------- tree helpers (tech doc §5.3: CQ / IQ / zQ / BQ / w9) ----------

export function findRoot(mapping: Record<string, ChatGPTNode>): string | undefined {
  if (mapping['client-created-root']) return 'client-created-root';
  for (const [id, node] of Object.entries(mapping)) {
    if (!node.parent || !mapping[node.parent]) return id;
  }
  return undefined;
}

function reachableFrom(mapping: Record<string, ChatGPTNode>, rootId: string): Set<string> {
  const seen = new Set<string>();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id) || !mapping[id]) continue;
    seen.add(id);
    for (const c of mapping[id].children ?? []) stack.push(c);
  }
  return seen;
}

function nodeTime(mapping: Record<string, ChatGPTNode>, id: string): number {
  let cur: string | null | undefined = id;
  const guard = new Set<string>();
  while (cur && mapping[cur] && !guard.has(cur)) {
    guard.add(cur);
    const t = mapping[cur].message?.create_time;
    if (typeof t === 'number') return t;
    cur = mapping[cur].parent;
  }
  return 0;
}

export function listLeaves(mapping: Record<string, ChatGPTNode>, rootId: string): string[] {
  const reach = reachableFrom(mapping, rootId);
  return [...reach].filter((id) => !(mapping[id].children ?? []).some((c) => reach.has(c)));
}

export function latestLeaf(mapping: Record<string, ChatGPTNode>, rootId: string): string | undefined {
  let best: string | undefined;
  let bestT = -Infinity;
  for (const leaf of listLeaves(mapping, rootId)) {
    const t = nodeTime(mapping, leaf);
    if (t > bestT) {
      bestT = t;
      best = leaf;
    }
  }
  return best;
}

export function restoreConversationPath(mapping: Record<string, ChatGPTNode>, rootId: string, leafId: string): ChatGPTNode[] {
  const path: ChatGPTNode[] = [];
  const visited = new Set<string>();
  let current: string | null | undefined = leafId;
  while (current && !visited.has(current)) {
    const node: ChatGPTNode | undefined = mapping[current];
    if (!node) break;
    visited.add(current);
    path.push(node);
    if (current === rootId) break;
    current = node.parent;
  }
  return path.reverse();
}

// ---------- node interpretation (tech doc §5: k9) ----------

type NodeClass = { visible: true } | { visible: false; reason: string };

function classifyNode(node: ChatGPTNode): NodeClass {
  const msg = node.message;
  if (!msg) return { visible: false, reason: 'root' };
  const role = msg.author?.role;
  const meta = msg.metadata ?? {};
  const ct: string = msg.content?.content_type ?? '';
  if (meta.is_visually_hidden_from_conversation) return { visible: false, reason: 'hidden' };
  if (role === 'system') return { visible: false, reason: 'system' };
  if (ct === 'user_editable_context' || ct === 'model_editable_context') return { visible: false, reason: 'context' };
  if (role === 'user') return { visible: true };
  if (role === 'assistant') {
    const recipient: string = msg.recipient ?? 'all';
    if (recipient === 'all' || recipient === 'python' || recipient.startsWith('canmore.')) return { visible: true };
    return { visible: false, reason: `tool-call:${recipient}` };
  }
  if (role === 'tool') {
    if (ct === 'execution_output') return { visible: true };
    if (ct === 'multimodal_text' && hasImageParts(msg)) return { visible: true };
    return { visible: false, reason: `tool:${msg.author?.name ?? ct}` };
  }
  return { visible: false, reason: `role:${role}` };
}

function hasImageParts(msg: Json): boolean {
  return Array.isArray(msg.content?.parts) && msg.content.parts.some((p: Json) => p && typeof p === 'object' && p.asset_pointer);
}

function imageFromPart(p: Json): ExportContent | null {
  const fileId = pointerToFileId(p.asset_pointer);
  if (!fileId) return null;
  return {
    type: 'image',
    imageUrl: `${POINTER_PREFIX}${fileId}`,
    linkType: 'pointer',
    fileId,
    width: typeof p.width === 'number' ? p.width : undefined,
    height: typeof p.height === 'number' ? p.height : undefined,
    alt: p.metadata?.dalle?.prompt ?? undefined,
  };
}

function stripCitationMarkers(text: string): string {
  return text.replace(/[^]*/g, '').replace(/[-]/g, '');
}

interface RefResult {
  text: string;
  sources: SourceRef[];
  images: ExportContent[];
}

/** Applies metadata.content_references so inline citation markers become readable links. */
export function applyContentReferences(text: string, refs: Json[] | undefined): RefResult {
  const sources: SourceRef[] = [];
  const images: ExportContent[] = [];
  if (!Array.isArray(refs) || refs.length === 0) return { text: stripCitationMarkers(text), sources, images };

  const pushSource = (s: Json) => {
    if (s && typeof s.url === 'string' && /^https?:/i.test(s.url)) {
      sources.push({ url: s.url, title: typeof s.title === 'string' ? s.title : undefined, snippet: s.snippet || undefined });
    }
  };

  const replacementFor = (ref: Json): string => {
    for (const it of ref.items ?? []) pushSource(it);
    for (const s of ref.sources ?? []) pushSource(s);
    if (ref.type === 'image_v2' || ref.type === 'image_group') {
      for (const img of ref.images ?? []) {
        const url = img.content_url || img.url || img.thumbnail_url;
        if (typeof url === 'string') images.push({ type: 'image', imageUrl: url, linkType: 'public', alt: img.title || undefined });
      }
      return '';
    }
    if (ref.type === 'hidden' || ref.type === 'sources_footnote') return '';
    if (typeof ref.alt === 'string' && ref.alt.trim()) return ref.alt;
    const first = (ref.items ?? [])[0];
    if (first?.url) return ` ([${first.attribution || first.title || 'source'}](${first.url}))`;
    if (ref.type === 'entity' && typeof ref.name === 'string') return ref.name;
    return '';
  };

  let out = text;
  const withIdx = refs.filter((r) => r && typeof r.matched_text === 'string' && r.matched_text.length > 0);
  withIdx.sort((a, b) => (b.start_idx ?? -1) - (a.start_idx ?? -1));
  for (const ref of withIdx) {
    const rep = replacementFor(ref);
    const s = ref.start_idx;
    const e = ref.end_idx;
    if (typeof s === 'number' && typeof e === 'number' && out.slice(s, e) === ref.matched_text) {
      out = out.slice(0, s) + rep + out.slice(e);
    } else {
      const i = out.indexOf(ref.matched_text);
      if (i >= 0) out = out.slice(0, i) + rep + out.slice(i + ref.matched_text.length);
    }
  }
  return { text: stripCitationMarkers(out), sources, images };
}

function dedupeSources(list: SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  return list.filter((s) => (seen.has(s.url) ? false : (seen.add(s.url), true)));
}

/** Converts one visible ChatGPT node to content blocks. Returns null when the node is empty. */
export function convertNode(node: ChatGPTNode): { contents: ExportContent[]; rawHadContent: boolean } {
  const msg = node.message;
  const role = msg.author?.role;
  const content = msg.content ?? {};
  const ct: string = content.content_type ?? '';
  const meta = msg.metadata ?? {};
  const out: ExportContent[] = [];
  let rawHadContent = false;

  const parts: Json[] = Array.isArray(content.parts) ? content.parts : [];
  const textParts = parts.filter((p) => typeof p === 'string') as string[];
  const joined = textParts.join('\n');
  if (joined.trim()) rawHadContent = true;
  if (parts.some((p) => p && typeof p === 'object')) rawHadContent = true;

  if (role === 'user') {
    for (const p of parts) {
      if (p && typeof p === 'object') {
        const img = imageFromPart(p);
        if (img) out.push(img);
        else if (p.content_type === 'audio_transcription' && p.text) out.push({ type: 'text', content: p.text });
      }
    }
    if (joined.trim()) out.unshift({ type: 'text', content: joined });
    const imageIds = new Set(out.filter((c) => c.fileId).map((c) => c.fileId));
    for (const a of meta.attachments ?? []) {
      if (!a || imageIds.has(a.id)) continue;
      rawHadContent = true;
      out.push({ type: 'attachment', attachment: { name: a.name, mime_type: a.mime_type, size: a.size, fileId: a.id } });
    }
    return { contents: out, rawHadContent };
  }

  const recipient: string = msg.recipient ?? 'all';

  if (role === 'assistant' && recipient.startsWith('canmore.')) {
    const raw = typeof content.text === 'string' ? content.text : joined;
    if (raw.trim()) rawHadContent = true;
    try {
      const data = JSON.parse(raw);
      if (typeof data.content === 'string') {
        const type: string = data.type ?? '';
        out.push({
          type: 'artifact',
          title: data.name || data.title || 'Canvas',
          language: type.startsWith('code/') ? type.slice(5) : type === 'document' ? 'markdown' : undefined,
          content: data.content,
        });
      } else {
        out.push({ type: 'tool', title: recipient, language: 'json', content: JSON.stringify(data, null, 2) });
      }
    } catch {
      if (raw.trim()) out.push({ type: 'tool', title: recipient, content: raw });
    }
    return { contents: out, rawHadContent };
  }

  switch (ct) {
    case 'text': {
      const { text, sources, images } = applyContentReferences(joined, meta.content_references);
      if (text.trim()) out.push({ type: 'markdown', content: text });
      out.push(...images);
      const extra: SourceRef[] = [...sources];
      for (const g of meta.search_result_groups ?? []) for (const e of g.entries ?? []) if (e?.url) extra.push({ url: e.url, title: e.title, snippet: e.snippet });
      for (const c of meta.citations ?? []) if (c?.metadata?.url) extra.push({ url: c.metadata.url, title: c.metadata.title });
      const uniq = dedupeSources(extra);
      if (uniq.length) out.push({ type: 'sources', sources: uniq });
      break;
    }
    case 'multimodal_text': {
      for (const p of parts) {
        if (typeof p === 'string') {
          if (p.trim()) out.push({ type: 'markdown', content: stripCitationMarkers(p) });
        } else if (p && typeof p === 'object') {
          const img = imageFromPart(p);
          if (img) out.push(img);
        }
      }
      break;
    }
    case 'code': {
      const text = typeof content.text === 'string' ? content.text : joined;
      if (text.trim()) {
        rawHadContent = true;
        out.push({ type: 'code', language: content.language && content.language !== 'unknown' ? content.language : 'python', title: 'Code Interpreter', content: text });
      }
      break;
    }
    case 'execution_output': {
      const text = typeof content.text === 'string' ? content.text : '';
      if (text.trim()) {
        rawHadContent = true;
        out.push({ type: 'tool', title: 'Output', content: text });
      }
      for (const m of meta.aggregate_result?.messages ?? []) {
        if (m?.message_type === 'image' && m.image_url) {
          rawHadContent = true;
          const img = imageFromPart({ asset_pointer: m.image_url, width: m.width, height: m.height });
          if (img) out.push(img);
        }
      }
      break;
    }
    case 'thoughts': {
      const thoughts: Json[] = Array.isArray(content.thoughts) ? content.thoughts : [];
      const text = thoughts
        .map((th) => [th.summary ? `**${th.summary}**` : '', th.content ?? ''].filter(Boolean).join('\n\n'))
        .filter(Boolean)
        .join('\n\n');
      if (text.trim()) {
        rawHadContent = true;
        out.push({ type: 'thinking', content: text });
      }
      break;
    }
    case 'reasoning_recap': {
      const text = typeof content.content === 'string' ? content.content : joined;
      if (text.trim()) {
        rawHadContent = true;
        out.push({ type: 'thinking', content: text });
      }
      break;
    }
    case 'tether_quote': {
      const text = typeof content.text === 'string' ? content.text : '';
      if (text.trim()) {
        rawHadContent = true;
        out.push({ type: 'tool', title: content.title || 'Quote', content: text });
        if (content.url) out.push({ type: 'sources', sources: [{ url: content.url, title: content.title }] });
      }
      break;
    }
    default: {
      if (joined.trim()) out.push({ type: 'markdown', content: stripCitationMarkers(joined) });
      else if (typeof content.text === 'string' && content.text.trim()) {
        rawHadContent = true;
        out.push({ type: 'markdown', content: content.text });
      }
    }
  }
  return { contents: out, rawHadContent };
}

interface PathConversion {
  messages: ExportMessage[];
  visible: number;
  missing: string[];
  skipped: SkippedNode[];
}

function convertPath(nodes: ChatGPTNode[]): PathConversion {
  const messages: ExportMessage[] = [];
  const missing: string[] = [];
  const skipped: SkippedNode[] = [];
  let visible = 0;
  for (const node of nodes) {
    const cls = classifyNode(node);
    if (!cls.visible) {
      if (cls.reason !== 'root') skipped.push({ id: node.id, reason: cls.reason });
      continue;
    }
    const { contents, rawHadContent } = convertNode(node);
    if (contents.length === 0) {
      if (rawHadContent) {
        visible++;
        missing.push(node.id);
      } else {
        skipped.push({ id: node.id, reason: 'empty' });
      }
      continue;
    }
    visible++;
    const msg = node.message;
    const role = msg.author?.role === 'user' ? 'user' : 'assistant';
    const created = toEpochMs(msg.create_time);
    const model: string | undefined = msg.metadata?.model_slug || undefined;
    const last = messages[messages.length - 1];
    if (role === 'assistant' && last && last.role === 'assistant') {
      last.contents.push(...contents);
      last.ids!.push(node.id);
      if (!last.model && model) last.model = model;
      if (created) last.updated_at = created;
    } else {
      messages.push({ id: node.id, ids: [node.id], role, model, created_at: created, updated_at: toEpochMs(msg.update_time) ?? created, contents });
    }
  }
  return { messages, visible, missing, skipped };
}

export interface ParseOptions {
  conversationId: string;
  url: string;
  includeAllBranches?: boolean;
}

/** Pure parser for a /backend-api/conversation/{id} payload (tech doc §5.3 LQ). */
export function parseChatGPTConversation(data: Json, opts: ParseOptions): Conversation {
  const mapping: Record<string, ChatGPTNode> = data?.mapping;
  if (!mapping || typeof mapping !== 'object') throw new ExtractError('PARSE', 'mapping missing');
  const rootId = findRoot(mapping);
  if (!rootId) throw new ExtractError('PARSE', 'root missing');
  const leafId = data.current_node && mapping[data.current_node] ? data.current_node : latestLeaf(mapping, rootId);
  if (!leafId) throw new ExtractError('EMPTY');
  const path = restoreConversationPath(mapping, rootId, leafId);
  const main = convertPath(path);

  const otherBranchMessages: BranchMessages[] = [];
  if (opts.includeAllBranches !== false) {
    const mainIds = new Set(path.map((n) => n.id));
    const leaves = listLeaves(mapping, rootId).filter((l) => l !== leafId);
    for (const leaf of leaves.slice(0, 200)) {
      const bpath = restoreConversationPath(mapping, rootId, leaf);
      const div = bpath.findIndex((n) => !mainIds.has(n.id));
      if (div < 0) continue;
      const conv = convertPath(bpath.slice(div));
      if (!conv.messages.length) continue;
      otherBranchMessages.push({
        leafId: leaf,
        pathIds: bpath.map((n) => n.id),
        create_time: toEpochMs(mapping[leaf].message?.create_time) ?? null,
        messages: conv.messages,
      });
    }
  }

  return {
    title: typeof data.title === 'string' && data.title.trim() ? data.title.trim() : '',
    pageId: opts.conversationId,
    fromUrl: opts.url,
    site: 'chatgpt',
    siteName: SITES.chatgpt.name,
    createAt: toEpochMs(data.create_time),
    lastUpdateAt: toEpochMs(data.update_time),
    pageType: 'fullPage',
    model: data.default_model_slug || main.messages.find((m) => m.model)?.model,
    messages: main.messages,
    otherBranchMessages: otherBranchMessages.length ? otherBranchMessages : undefined,
    extraction: {
      method: 'api',
      sourceNodeCount: main.visible,
      missingNodeIds: main.missing,
      skipped: main.skipped,
      warnings: [],
      fetchedAt: Date.now(),
    },
  };
}

// ---------- network ----------

async function authHeaders(ctx: AdapterContext): Promise<Record<string, string>> {
  const bridged = await ctx.bridge.request<ChatGPTAuthData>('getChatGPTAuthHeader');
  let authorization = bridged?.authorization;
  if (!authorization) {
    try {
      const session = await fetchJson<Json>(ctx, `${location.origin}/api/auth/session`, { retries: 0, timeoutMs: 15_000 });
      if (session?.accessToken) authorization = `Bearer ${session.accessToken}`;
    } catch {
      /* fall through: the conversation request will report AUTH if needed */
    }
  }
  const headers: Record<string, string> = { Accept: 'application/json', ...(bridged?.extraHeaders ?? {}) };
  if (authorization) headers['Authorization'] = authorization;
  const deviceId = bridged?.extraHeaders?.['oai-device-id'] ?? readCookie('oai-did');
  if (deviceId) headers['oai-device-id'] = deviceId;
  return headers;
}

let cachedHeaders: { at: number; headers: Record<string, string> } | null = null;

async function getHeaders(ctx: AdapterContext): Promise<Record<string, string>> {
  // Headers live only in memory for a minute; tokens are never persisted.
  if (cachedHeaders && Date.now() - cachedHeaders.at < 60_000) return cachedHeaders.headers;
  const headers = await authHeaders(ctx);
  cachedHeaders = { at: Date.now(), headers };
  return headers;
}

async function resolveFileUrl(ctx: AdapterContext, fileId: string, conversationId: string): Promise<string | undefined> {
  const headers = await getHeaders(ctx);
  const candidates = [
    `${location.origin}/backend-api/files/download/${encodeURIComponent(fileId)}?conversation_id=${encodeURIComponent(conversationId)}&inline=false`,
    `${location.origin}/backend-api/files/${encodeURIComponent(fileId)}/download`,
  ];
  for (const url of candidates) {
    try {
      const data = await fetchJson<Json>(ctx, url, { headers, retries: 0, timeoutMs: 20_000 });
      if (typeof data?.download_url === 'string') {
        return data.download_url.startsWith('/') ? `${location.origin}${data.download_url}` : data.download_url;
      }
    } catch {
      /* try next endpoint */
    }
  }
  return undefined;
}

/** Tech doc §5.4 AQ: turns asset pointers into downloadable URLs with limited concurrency. */
async function resolveImagePointers(ctx: AdapterContext, conv: Conversation): Promise<void> {
  const targets: ExportContent[] = [];
  const all = [...conv.messages, ...(conv.otherBranchMessages ?? []).flatMap((b) => b.messages)];
  for (const m of all) for (const c of m.contents) if (c.type === 'image' && c.linkType === 'pointer' && c.fileId) targets.push(c);
  const byId = new Map<string, ExportContent[]>();
  for (const c of targets) byId.set(c.fileId!, [...(byId.get(c.fileId!) ?? []), c]);
  const ids = [...byId.keys()];
  let unresolved = 0;
  await mapLimit(ids, 4, async (id) => {
    const url = await resolveFileUrl(ctx, id, conv.pageId);
    for (const c of byId.get(id)!) {
      if (url) {
        c.imageUrl = url;
        c.linkType = 'private';
      }
    }
    if (!url) unresolved++;
  });
  if (unresolved) conv.extraction.warnings.push(`image-pointer-unresolved:${unresolved}`);
}

export const chatgptAdapter: SiteAdapter = {
  site: 'chatgpt',

  async getAllChatsForTopic(ctx, conversationId) {
    const headers = await getHeaders(ctx);
    const data = await fetchJson<Json>(ctx, `${location.origin}/backend-api/conversation/${encodeURIComponent(conversationId)}`, {
      method: 'GET',
      headers,
      timeoutMs: 120_000,
    });
    const t0 = performance.now();
    const conv = parseChatGPTConversation(data, { conversationId, url: ctx.url });
    ctx.timer.parseMs += performance.now() - t0;
    ctx.progress('messages', conv.messages.length);
    await resolveImagePointers(ctx, conv);
    return conv;
  },

  countDomUserTurns() {
    const n = document.querySelectorAll('[data-message-author-role="user"]').length;
    return n > 0 ? n : undefined;
  },

  domFallback(ctx, conversationId) {
    return domFallbackExtract('chatgpt', ctx, conversationId);
  },

  async resolveAssetUrl(req: AssetResolveRequest, conversationId, ctx) {
    if (req.fileId) return resolveFileUrl(ctx, req.fileId, conversationId);
    return req.url;
  },
};
