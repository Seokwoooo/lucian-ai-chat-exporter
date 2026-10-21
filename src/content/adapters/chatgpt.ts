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
import { cleanUrl, hostLabel, mapLimit, toEpochMs, urlKey } from '../../shared/util';
import { domFallbackExtract } from '../dom-fallback';
import {
  ExtractError,
  RATE_LIMIT_WAIT_MS,
  fetchJson,
  readCookie,
  renderedElements,
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
    // Newer models run code through "container.exec"; ChatGPT shows those runs only inside the
    // collapsed activity panel (checked on chatgpt.com, 2026-10), so they are reported as skipped
    // like their tool calls. Legacy Code Interpreter ("python") output stays visible.
    if (ct === 'execution_output' && msg.author?.name && msg.author.name !== 'python') return { visible: false, reason: `tool:${msg.author.name}` };
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

// ---------- citations and rich answer markup (chatgpt.com, 2026-10) ----------
//
// Search answers cite with `<Cite ref="turn123456search7"/>` or `<Cite refs={["…","…"]}/>`; the
// ids match `metadata.search_result_groups[].entries[].ref_id` ({turn_index, ref_type, ref_index})
// of the same conversation. Answers can also contain layout components that the UI renders:
// `<Link url title/>`, `<box>`, `<row>`, `<text>`, `<title>`, `<caption>`, `<icon/>`, `<divider/>`.

export interface CitedSource extends SourceRef {
  label: string;
}
export type CitationIndex = Map<string, CitedSource>;

const REF_TOKEN = /turn\d+[a-z_]+\d+/g;

/** Collects every search result with a ref_id in the conversation (any node, visible or not). */
export function buildCitationIndex(mapping: Record<string, ChatGPTNode>): CitationIndex {
  const index: CitationIndex = new Map();
  for (const node of Object.values(mapping)) {
    for (const g of node.message?.metadata?.search_result_groups ?? []) {
      for (const e of g?.entries ?? []) {
        const r = e?.ref_id;
        if (!r || typeof e.url !== 'string' || !/^https?:/i.test(e.url)) continue;
        const key = `turn${r.turn_index}${r.ref_type}${r.ref_index}`;
        if (!index.has(key)) index.set(key, { url: e.url, title: e.title || undefined, snippet: e.snippet || undefined, label: e.attribution || hostLabel(e.url) });
      }
    }
  }
  return index;
}

const LAYOUT_TAGS = new Set(['box', 'row', 'col', 'column', 'stack', 'grid', 'card']);
const INLINE_TAGS = new Set(['text', 'caption', 'badge', 'label']);
const VOID_TAGS = new Set(['icon', 'divider', 'spacer', 'separator']);
const RICH_HINT = /<(?:Cite|Link|MemoryCite)\b|<(?:box|row|col|stack|card)\b[^>\n]*>/;

function decodeEntities(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function attr(attrs: string, name: string): string | undefined {
  const m = attrs.match(new RegExp(`\\b${name}=(?:"([^"]*)"|'([^']*)'|\\{"([^"]*)"\\})`));
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? '') : undefined;
}

function citeLinks(refs: string[], index: CitationIndex | undefined, cited: CitedSource[]): string {
  const seen = new Set<string>();
  const links: string[] = [];
  for (const r of refs) {
    const src = index?.get(r);
    if (!src || seen.has(urlKey(src.url))) continue;
    seen.add(urlKey(src.url));
    cited.push(src);
    links.push(`[${src.label.replace(/[[\]]/g, '')}](${cleanUrl(src.url)})`);
  }
  return links.length ? ` (${links.join(', ')})` : '';
}

/** Rewrites rich markup in a piece of one line (outside inline code) into plain Markdown. */
function richLine(seg: string, index: CitationIndex | undefined, cited: CitedSource[]): string {
  let s = seg;
  s = s.replace(/[ \t]*<Cite\b([^>]*?)\/>/g, (_, attrs: string) => citeLinks(attrs.match(REF_TOKEN) ?? [], index, cited));
  s = s.replace(/[ \t]*<MemoryCite\b[^>]*?\/>/g, '');
  s = s.replace(/<Link\b([^>]*?)\/>/g, (_, attrs: string) => {
    const url = attr(attrs, 'url') ?? attr(attrs, 'href');
    if (!url) return '';
    const title = (attr(attrs, 'title') ?? '').replace(/[[\]]/g, '').trim();
    return `[${title || hostLabel(url)}](${cleanUrl(url)})`;
  });
  s = s.replace(/<Link\b([^>]*?)>([\s\S]*?)<\/Link>/g, (_, attrs: string, inner: string) => {
    const url = attr(attrs, 'url') ?? attr(attrs, 'href');
    const label = inner.replace(/[[\]]/g, '').trim();
    return url ? `[${label || hostLabel(url)}](${cleanUrl(url)})` : inner;
  });
  s = s.replace(/<title\b[^>]*>([\s\S]*?)<\/title>/g, (_, inner: string) => (inner.trim() ? `**${inner.trim()}**` : ''));
  s = s.replace(/<\/?([A-Za-z][\w-]*)\b[^<>]*?\/?>/g, (all, name: string) => {
    if (LAYOUT_TAGS.has(name) || INLINE_TAGS.has(name) || VOID_TAGS.has(name) || name === 'title' || name === 'Link') return '';
    // Unknown capitalized components are UI widgets without text of their own.
    if (/^[A-Z]/.test(name)) return '';
    return all;
  });
  return s;
}

/**
 * Converts ChatGPT's rich answer markup to Markdown: citations become links to the cited pages,
 * layout components are unwrapped and de-indented (so they do not turn into code blocks), and
 * decorative components are dropped. Fenced and inline code are left untouched.
 */
export function convertRichMarkup(text: string, index?: CitationIndex): { text: string; cited: CitedSource[] } {
  const cited: CitedSource[] = [];
  if (!RICH_HINT.test(text)) return { text, cited };
  const out: string[] = [];
  let fence: string | null = null;
  let depth = 0;
  for (const raw of text.split('\n')) {
    const trimmed = raw.trimStart();
    if (fence) {
      out.push(raw);
      if (trimmed.startsWith(fence)) fence = null;
      continue;
    }
    const open = trimmed.match(/^(`{3,}|~{3,})/);
    if (open) {
      fence = open[1];
      out.push(depth > 0 ? trimmed : raw);
      continue;
    }
    const line = depth > 0 ? trimmed : raw;
    // Layout depth: opening tags that are not self-closing minus closing tags on this line.
    for (const m of line.matchAll(/<(\/?)([a-z]+)\b[^<>]*?(\/?)>/g)) {
      if (!LAYOUT_TAGS.has(m[2])) continue;
      if (m[1]) depth = Math.max(0, depth - 1);
      else if (!m[3]) depth++;
    }
    const parts = line.split(/(`+[^`\n]*?`+)/g);
    const converted = parts.map((p, i) => (i % 2 === 1 ? p : richLine(p, index, cited))).join('');
    out.push(converted.trim() ? converted.replace(/[ \t]+$/, '') : '');
  }
  return { text: out.join('\n').replace(/\n{3,}/g, '\n\n').trim(), cited };
}

interface RefResult {
  text: string;
  sources: SourceRef[];
  images: ExportContent[];
}

/** Applies metadata.content_references so inline citation markers become readable links. */
export function applyContentReferences(text: string, refs: Json[] | undefined, index?: CitationIndex): RefResult {
  const sources: SourceRef[] = [];
  const images: ExportContent[] = [];
  if (!Array.isArray(refs) || refs.length === 0) return { text: finishText(text, index, sources), sources, images };

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
    // Answer parts ChatGPT draws as client widgets (2026-10: code blocks with a copy button,
    // category "code_block") are visible text: the reference covers the fenced code itself, and its
    // empty alt used to delete the commands from every document (user report, 2026-10-21).
    if (ref.type === 'client_defined_widget') {
      if (!/[\ue000-\uf8ff]/.test(ref.matched_text)) return ref.matched_text;
      const code = ref.data?.content;
      if (typeof code === 'string' && code.trim()) {
        const lang = typeof ref.data?.language === 'string' && /^[\w+#.-]{1,24}$/.test(ref.data.language) ? ref.data.language : '';
        const fence = '`'.repeat(Math.max(3, ...(code.match(/`+/g) ?? []).map((t: string) => t.length + 1)));
        return `\n${fence}${lang}\n${code.replace(/\n$/, '')}\n${fence}\n`;
      }
    }
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
    } else if (ref.matched_text.trim()) {
      // Searching for whitespace (sources_footnote's " ") would hit the first space of the answer.
      const i = out.indexOf(ref.matched_text);
      if (i >= 0) out = out.slice(0, i) + rep + out.slice(i + ref.matched_text.length);
    }
  }
  return { text: finishText(out, index, sources), sources, images };
}

/** Resolves citation markers left without a content reference, strips the rest, unwraps markup. */
function finishText(text: string, index: CitationIndex | undefined, sources: SourceRef[]): string {
  const cited: CitedSource[] = [];
  const resolved = index?.size
    ? text.replace(/\ue200cite\ue202([^\ue201]*)\ue201/g, (_, body: string) => citeLinks(body.match(REF_TOKEN) ?? [], index, cited))
    : text;
  const rich = convertRichMarkup(stripCitationMarkers(resolved), index);
  for (const c of [...cited, ...rich.cited]) sources.push({ url: c.url, title: c.title, snippet: c.snippet });
  return rich.text;
}

function dedupeSources(list: SourceRef[], exclude: Set<string> = new Set()): SourceRef[] {
  const seen = new Set(exclude);
  const out: SourceRef[] = [];
  for (const s of list) {
    const k = urlKey(s.url);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ ...s, url: cleanUrl(s.url) });
  }
  return out;
}

/** Converts one visible ChatGPT node to content blocks. Returns null when the node is empty. */
export function convertNode(node: ChatGPTNode, index?: CitationIndex): { contents: ExportContent[]; rawHadContent: boolean } {
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

  // GPT-5 style "preamble" messages on the commentary channel are shown only inside the collapsed
  // thinking panel, so they are kept as thinking (JSON/ZIP) rather than as answer text.
  if (role === 'assistant' && ct === 'text' && (msg.channel === 'commentary' || meta.is_thinking_preamble_message)) {
    const { text } = applyContentReferences(joined, meta.content_references, index);
    if (text.trim()) out.push({ type: 'thinking', title: 'commentary', content: text });
    return { contents: out, rawHadContent };
  }

  switch (ct) {
    case 'text': {
      const { text, sources, images } = applyContentReferences(joined, meta.content_references, index);
      if (text.trim()) out.push({ type: 'markdown', content: text });
      out.push(...images);
      // Documents list what the answer cites; the rest of the search results (often 100+ pages the
      // model only looked at) is kept for JSON/ZIP as moreSources.
      for (const c of meta.citations ?? []) if (c?.metadata?.url) sources.push({ url: c.metadata.url, title: c.metadata.title });
      const cited = dedupeSources(sources);
      const searched: SourceRef[] = [];
      for (const g of meta.search_result_groups ?? []) for (const e of g.entries ?? []) if (e?.url) searched.push({ url: e.url, title: e.title, snippet: e.snippet });
      const more = dedupeSources(searched, new Set(cited.map((x) => urlKey(x.url))));
      if (cited.length || more.length) out.push({ type: 'sources', sources: cited, moreSources: more.length ? more : undefined });
      break;
    }
    case 'multimodal_text': {
      for (const p of parts) {
        if (typeof p === 'string') {
          if (p.trim()) out.push({ type: 'markdown', content: finishText(p, index, []) });
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
      if (joined.trim()) out.push({ type: 'markdown', content: finishText(joined, index, []) });
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
  missingKinds: string[];
  skipped: SkippedNode[];
}

/** "assistant:multimodal_text(audio_transcription)" — what a node that could not be converted held. */
function nodeKind(node: ChatGPTNode): string {
  const msg = node.message;
  const role = msg.author?.role === 'user' ? 'user' : 'assistant';
  const ct: string = msg.content?.content_type || 'unknown';
  const parts: Json[] = Array.isArray(msg.content?.parts) ? msg.content.parts : [];
  const objects = [...new Set(parts.filter((p) => p && typeof p === 'object').map((p) => String(p.content_type ?? 'object')))];
  return `${role}:${ct}${objects.length ? `(${objects.join('+')})` : ''}`;
}

function convertPath(nodes: ChatGPTNode[], index?: CitationIndex): PathConversion {
  const messages: ExportMessage[] = [];
  const missing: string[] = [];
  const missingKinds: string[] = [];
  const skipped: SkippedNode[] = [];
  let visible = 0;
  for (const node of nodes) {
    const cls = classifyNode(node);
    if (!cls.visible) {
      if (cls.reason !== 'root') skipped.push({ id: node.id, reason: cls.reason });
      continue;
    }
    const { contents, rawHadContent } = convertNode(node, index);
    if (contents.length === 0) {
      if (rawHadContent) {
        visible++;
        missing.push(node.id);
        missingKinds.push(nodeKind(node));
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
  return { messages, visible, missing, missingKinds, skipped };
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
  const index = buildCitationIndex(mapping);
  const main = convertPath(path, index);

  const otherBranchMessages: BranchMessages[] = [];
  if (opts.includeAllBranches !== false) {
    const mainIds = new Set(path.map((n) => n.id));
    const leaves = listLeaves(mapping, rootId).filter((l) => l !== leafId);
    for (const leaf of leaves.slice(0, 200)) {
      const bpath = restoreConversationPath(mapping, rootId, leaf);
      const div = bpath.findIndex((n) => !mainIds.has(n.id));
      if (div < 0) continue;
      const conv = convertPath(bpath.slice(div), index);
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
      missingKinds: main.missingKinds,
      skipped: main.skipped,
      // Clicked while the answer was still being written (seen on a real gpt-6-pro task, 2026-10).
      warnings: mapping[leafId]?.message?.status === 'in_progress' ? ['answer-in-progress'] : [],
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
      rateLimitWaitMs: RATE_LIMIT_WAIT_MS,
    });
    const t0 = performance.now();
    const conv = parseChatGPTConversation(data, { conversationId, url: ctx.url });
    ctx.timer.parseMs += performance.now() - t0;
    ctx.progress('messages', conv.messages.length);
    await resolveImagePointers(ctx, conv);
    return conv;
  },

  countDomUserTurns() {
    // Lower bound only: the conversation view is virtualized and unmounts off-screen turns.
    const n = Math.max(renderedElements('[data-message-author-role="user"]').length, renderedElements('[data-user-message-bubble]').length);
    return n > 0 ? n : undefined;
  },

  actionBars() {
    // 2026-10: each answer ends with `.turn-action-controls` > row of buttons; user bubbles have
    // their own controls inside `group/user-message`. Older layout: copy-turn-action-button.
    const bars: Element[] = [];
    for (const c of document.querySelectorAll('.turn-action-controls')) {
      if (c.closest('[class*="group/user-message"], [data-message-author-role="user"]')) continue;
      bars.push([...c.children].find((k) => k.tagName === 'DIV' && k.querySelector('button')) ?? c);
    }
    if (!bars.length) {
      for (const b of document.querySelectorAll('[data-testid="copy-turn-action-button"]')) {
        if (!b.closest('[data-message-author-role="user"]') && b.parentElement) bars.push(b.parentElement);
      }
    }
    return bars;
  },

  domFallback(ctx, conversationId) {
    return domFallbackExtract('chatgpt', ctx, conversationId);
  },

  async resolveAssetUrl(req: AssetResolveRequest, conversationId, ctx) {
    if (req.fileId) return resolveFileUrl(ctx, req.fileId, conversationId);
    return req.url;
  },
};
