// Claude adapter (tech doc §7): organization id from the lastActiveOrg cookie, then
// GET /api/organizations/{org}/chat_conversations/{id}?tree=True&rendering_mode=messages&render_all_tools=true
// and walk parent_message_uuid back from current_leaf_message_uuid (R$).

import { SITES } from '../../shared/sites';
import type { Conversation, ExportContent, ExportMessage, SkippedNode, SourceRef, BranchMessages } from '../../shared/types';
import { toEpochMs } from '../../shared/util';
import { domFallbackExtract } from '../dom-fallback';
import { ExtractError, fetchJson, readCookie, type AdapterContext, type SiteAdapter } from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

/** Root sentinel used by Claude for the first message's parent (tech doc §7.2 H9). */
export const CLAUDE_ROOT = '00000000-0000-4000-8000-000000000000';

function absolute(url: string | undefined): string | undefined {
  if (!url || typeof url !== 'string') return undefined;
  if (/^https?:\/\//i.test(url) || url.startsWith('data:')) return url;
  return `https://claude.ai${url.startsWith('/') ? '' : '/'}${url}`;
}

/** Picks the newest leaf when current_leaf_message_uuid is missing (tech doc §7.2 B$). */
export function pickLatestLeaf(messages: Json[]): string | undefined {
  const parents = new Set(messages.map((m) => m.parent_message_uuid).filter(Boolean));
  let best: Json;
  for (const m of messages) {
    if (parents.has(m.uuid)) continue;
    if (!best || (toEpochMs(m.created_at) ?? 0) >= (toEpochMs(best.created_at) ?? 0)) best = m;
  }
  return best?.uuid;
}

/** Tech doc §7.2 R$: current path from the leaf back to the root, oldest first. */
export function selectClaudePath(data: Json): Json[] {
  const all: Json[] = data.chat_messages || [];
  const byId = new Map(all.map((m) => [m.uuid, m]));
  const leaf = byId.has(data.current_leaf_message_uuid) ? data.current_leaf_message_uuid : pickLatestLeaf(all);
  const byIndex = () => [...all].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  if (!leaf) return byIndex();
  const path: Json[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = leaf;
  while (cur && cur !== CLAUDE_ROOT && !seen.has(cur)) {
    const m = byId.get(cur);
    if (!m) break;
    seen.add(cur);
    path.push(m);
    cur = m.parent_message_uuid;
  }
  return path.length > 0 ? path.reverse() : byIndex();
}

const ARTIFACT_LANG: Record<string, string> = {
  'text/markdown': 'markdown',
  'text/html': 'html',
  'image/svg+xml': 'svg',
  'application/vnd.ant.mermaid': 'mermaid',
  'application/vnd.ant.react': 'jsx',
};

function extToLang(path: string | undefined): string | undefined {
  const ext = path?.split('.').pop()?.toLowerCase();
  if (!ext || ext === path) return undefined;
  const map: Record<string, string> = { ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', py: 'python', md: 'markdown', sh: 'bash', yml: 'yaml' };
  return map[ext] ?? ext;
}

function textOf(v: Json): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(textOf).filter(Boolean).join('\n');
  if (v && typeof v === 'object' && typeof v.text === 'string') return v.text;
  return '';
}

function convertBlock(block: Json, sources: SourceRef[]): ExportContent[] {
  const out: ExportContent[] = [];
  switch (block?.type) {
    case 'text': {
      if (typeof block.text === 'string' && block.text.length) out.push({ type: 'markdown', content: block.text });
      for (const c of block.citations ?? []) {
        const url = c?.url ?? c?.metadata?.url ?? c?.source?.url;
        if (typeof url === 'string') sources.push({ url, title: c.title ?? c?.metadata?.title });
      }
      break;
    }
    case 'thinking': {
      const t = typeof block.thinking === 'string' ? block.thinking : textOf(block.summaries);
      if (t.trim()) out.push({ type: 'thinking', content: t });
      break;
    }
    case 'tool_use': {
      const name: string = block.name ?? 'tool';
      const input = block.input ?? {};
      if (name === 'artifacts') {
        if ((input.command === 'create' || input.command === 'rewrite') && typeof input.content === 'string') {
          out.push({
            type: 'artifact',
            title: input.title || input.id || 'Artifact',
            language: input.language || ARTIFACT_LANG[input.type] || undefined,
            content: input.content,
          });
        } else if (input.command === 'update') {
          out.push({
            type: 'tool',
            title: `artifacts · update ${input.id ?? ''}`.trim(),
            content: `--- old\n${input.old_str ?? ''}\n+++ new\n${input.new_str ?? ''}`,
            language: 'diff',
          });
        }
      } else if (name === 'create_file' && typeof input.file_text === 'string') {
        out.push({ type: 'artifact', title: input.path || 'file', language: extToLang(input.path), content: input.file_text });
      } else if ((name === 'repl' || name === 'analysis') && typeof input.code === 'string') {
        out.push({ type: 'code', language: 'javascript', title: name, content: input.code });
      } else if ((name === 'bash_tool' || name === 'bash') && typeof input.command === 'string') {
        out.push({ type: 'code', language: 'bash', title: name, content: input.command });
      } else if (name === 'web_search' && input.query) {
        out.push({ type: 'tool', title: `web_search`, content: String(input.query) });
      } else if (name === 'web_fetch' && input.url) {
        out.push({ type: 'tool', title: 'web_fetch', content: String(input.url) });
      } else {
        out.push({ type: 'tool', title: name, language: 'json', content: JSON.stringify(input, null, 2) });
      }
      break;
    }
    case 'tool_result': {
      const items: Json[] = Array.isArray(block.content) ? block.content : [];
      const texts: string[] = [];
      for (const it of items) {
        if (it?.type === 'knowledge' && typeof it.url === 'string') sources.push({ url: it.url, title: it.title });
        else if (typeof it?.text === 'string') texts.push(it.text);
      }
      const isSearch = block.name === 'web_search' || block.name === 'web_fetch';
      const body = texts.join('\n').trim();
      if (body && !isSearch) out.push({ type: 'tool', title: `${block.name ?? 'tool'} · result`, content: body });
      break;
    }
    default: {
      if (typeof block?.text === 'string' && block.text.trim()) out.push({ type: 'markdown', content: block.text });
    }
  }
  return out;
}

export function convertClaudeMessage(m: Json): ExportContent[] {
  const out: ExportContent[] = [];
  const sources: SourceRef[] = [];
  const blocks: Json[] = Array.isArray(m.content) ? m.content : [];
  if (blocks.length) {
    for (const b of blocks) out.push(...convertBlock(b, sources));
  } else if (typeof m.text === 'string' && m.text.trim()) {
    out.push({ type: 'markdown', content: m.text });
  }
  const files: Json[] = (Array.isArray(m.files_v2) && m.files_v2.length ? m.files_v2 : m.files) ?? [];
  for (const f of files) {
    if (f?.file_kind === 'image') {
      const url = absolute(f.preview_asset?.url ?? f.preview_url ?? f.thumbnail_asset?.url ?? f.thumbnail_url);
      out.push({
        type: 'image',
        imageUrl: url,
        linkType: 'private',
        fileId: f.file_uuid,
        alt: f.file_name,
        width: f.preview_asset?.image_width,
        height: f.preview_asset?.image_height,
      });
    } else if (f) {
      out.push({
        type: 'attachment',
        attachment: { name: f.file_name, fileId: f.file_uuid, url: absolute(f.document_asset?.url), mime_type: f.mime_type },
      });
    }
  }
  for (const a of m.attachments ?? []) {
    if (!a) continue;
    out.push({
      type: 'attachment',
      attachment: { name: a.file_name, mime_type: a.file_type, size: a.file_size, extractedText: a.extracted_content || undefined, fileId: a.id },
    });
  }
  if (sources.length) {
    const seen = new Set<string>();
    out.push({ type: 'sources', sources: sources.filter((s) => (seen.has(s.url) ? false : (seen.add(s.url), true))) });
  }
  return out;
}

function convertList(list: Json[], model: string | undefined) {
  const messages: ExportMessage[] = [];
  const missing: string[] = [];
  const skipped: SkippedNode[] = [];
  let visible = 0;
  let truncated = 0;
  for (const m of list) {
    const contents = convertClaudeMessage(m);
    const hadRaw = (Array.isArray(m.content) && m.content.length > 0) || (typeof m.text === 'string' && m.text.trim().length > 0);
    if (!contents.length) {
      if (hadRaw) {
        visible++;
        missing.push(m.uuid);
      } else skipped.push({ id: m.uuid, reason: 'empty' });
      continue;
    }
    visible++;
    if (m.truncated) truncated++;
    messages.push({
      id: m.uuid,
      ids: [m.uuid],
      role: m.sender === 'human' ? 'user' : 'assistant',
      model: m.sender === 'human' ? undefined : model,
      created_at: toEpochMs(m.created_at),
      updated_at: toEpochMs(m.updated_at),
      truncated: m.truncated ? true : undefined,
      contents,
    });
  }
  return { messages, missing, skipped, visible, truncated };
}

export function parseClaudeConversation(data: Json, opts: { conversationId: string; url: string }): Conversation {
  if (!data || !Array.isArray(data.chat_messages)) throw new ExtractError('PARSE', 'chat_messages missing');
  const path = selectClaudePath(data);
  const model: string | undefined = data.model || undefined;
  const main = convertList(path, model);

  // Other branches: every leaf that is not on the current path.
  const all: Json[] = data.chat_messages;
  const byId = new Map(all.map((m) => [m.uuid, m]));
  const onPath = new Set(path.map((m) => m.uuid));
  const parents = new Set(all.map((m) => m.parent_message_uuid));
  const otherBranchMessages: BranchMessages[] = [];
  for (const leaf of all.filter((m) => !parents.has(m.uuid) && !onPath.has(m.uuid)).slice(0, 200)) {
    const chain: Json[] = [];
    const seen = new Set<string>();
    let cur: Json = leaf;
    while (cur && !onPath.has(cur.uuid) && !seen.has(cur.uuid)) {
      seen.add(cur.uuid);
      chain.push(cur);
      cur = byId.get(cur.parent_message_uuid);
    }
    const conv = convertList(chain.reverse(), model);
    if (conv.messages.length) {
      otherBranchMessages.push({ leafId: leaf.uuid, pathIds: chain.map((m) => m.uuid), create_time: toEpochMs(leaf.created_at) ?? null, messages: conv.messages });
    }
  }

  return {
    title: typeof data.name === 'string' ? data.name.trim() : '',
    pageId: opts.conversationId,
    fromUrl: opts.url,
    site: 'claude',
    siteName: SITES.claude.name,
    createAt: toEpochMs(data.created_at),
    lastUpdateAt: toEpochMs(data.updated_at),
    pageType: 'fullPage',
    model,
    messages: main.messages,
    otherBranchMessages: otherBranchMessages.length ? otherBranchMessages : undefined,
    extraction: {
      method: 'api',
      sourceNodeCount: main.visible,
      missingNodeIds: main.missing,
      skipped: main.skipped,
      truncatedBySource: main.truncated || undefined,
      warnings: [],
      fetchedAt: Date.now(),
    },
  };
}

async function orgCandidates(ctx: AdapterContext): Promise<string[]> {
  const out: string[] = [];
  const cookieOrg = readCookie('lastActiveOrg');
  if (cookieOrg) out.push(cookieOrg);
  try {
    const orgs = await fetchJson<Json[]>(ctx, 'https://claude.ai/api/organizations', { retries: 0, timeoutMs: 20_000 });
    for (const o of Array.isArray(orgs) ? orgs : []) {
      const caps: string[] = o?.capabilities ?? [];
      if (o?.uuid && !out.includes(o.uuid) && (caps.length === 0 || caps.includes('chat'))) out.push(o.uuid);
    }
  } catch (e) {
    if (!out.length) throw e;
  }
  return out;
}

export const claudeAdapter: SiteAdapter = {
  site: 'claude',

  async getAllChatsForTopic(ctx, conversationId) {
    const orgs = await orgCandidates(ctx);
    if (!orgs.length) throw new ExtractError('AUTH', 'organization not found');
    let lastErr: unknown;
    for (const org of orgs) {
      const url =
        `https://claude.ai/api/organizations/${encodeURIComponent(org)}/chat_conversations/${encodeURIComponent(conversationId)}` +
        '?tree=True&rendering_mode=messages&render_all_tools=true';
      try {
        const data = await fetchJson<Json>(ctx, url, { headers: { Accept: '*/*', 'Content-Type': 'application/json' }, timeoutMs: 120_000 });
        const t0 = performance.now();
        const conv = parseClaudeConversation(data, { conversationId, url: ctx.url });
        ctx.timer.parseMs += performance.now() - t0;
        ctx.progress('messages', conv.messages.length);
        return conv;
      } catch (e) {
        lastErr = e;
        if (e instanceof ExtractError && (e.code === 'NOT_FOUND' || e.code === 'AUTH')) continue;
        throw e;
      }
    }
    throw lastErr instanceof Error ? lastErr : new ExtractError('NOT_FOUND');
  },

  countDomUserTurns() {
    const n = document.querySelectorAll('[data-testid="user-message"]').length;
    return n > 0 ? n : undefined;
  },

  domFallback(ctx, conversationId) {
    return domFallbackExtract('claude', ctx, conversationId);
  },
};
