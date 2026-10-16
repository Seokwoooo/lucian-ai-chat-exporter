import type { Conversation, SiteId } from '../../shared/types';
import type { Bridge } from '../bridge';

export type ErrorCode =
  | 'NOT_CONVERSATION'
  | 'AUTH'
  | 'NOT_FOUND'
  | 'RATE_LIMIT'
  | 'NETWORK'
  | 'PARSE'
  | 'EMPTY'
  | 'UNKNOWN';

export class ExtractError extends Error {
  constructor(
    public code: ErrorCode,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export interface AdapterContext {
  url: string;
  bridge: Bridge;
  progress: (label: 'messages' | 'pages', done: number, total?: number) => void;
  /** Accumulates time spent waiting on the network vs. parsing. */
  timer: { networkMs: number; parseMs: number };
}

export interface AssetResolveRequest {
  /** Stable key used by exporters to look the asset up (usually the URL). */
  key: string;
  url?: string;
  fileId?: string;
}

export interface SiteAdapter {
  site: SiteId;
  /** Returns the full conversation normalized to the common model (tech doc §4.1 getAllChatsForTopic). */
  getAllChatsForTopic(ctx: AdapterContext, conversationId: string): Promise<Conversation>;
  /** Number of user turns currently rendered (used for completeness cross-checks). */
  countDomUserTurns(): number | undefined;
  /** Fallback extraction from the rendered page when the API path fails. */
  domFallback(ctx: AdapterContext, conversationId: string): Promise<Conversation>;
  /** Turns a service-specific file reference into a downloadable URL. */
  resolveAssetUrl?(req: AssetResolveRequest, conversationId: string, ctx: AdapterContext): Promise<string | undefined>;
}

export interface FetchJsonOptions extends RequestInit {
  timeoutMs?: number;
  retries?: number;
}

/** fetch wrapper that maps HTTP failures to ExtractError codes and retries transient errors. */
export async function fetchWithRetry(
  ctx: AdapterContext | null,
  url: string,
  init: FetchJsonOptions = {},
): Promise<Response> {
  const { timeoutMs = 60_000, retries = 1, ...rest } = init;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const t0 = performance.now();
    try {
      const res = await fetch(url, { credentials: 'include', ...rest, signal: controller.signal });
      if (ctx) ctx.timer.networkMs += performance.now() - t0;
      if (res.ok) return res;
      if (res.status === 401 || res.status === 403) throw new ExtractError('AUTH', `HTTP ${res.status}`);
      if (res.status === 404) throw new ExtractError('NOT_FOUND', `HTTP ${res.status}`);
      if (res.status === 429) {
        lastErr = new ExtractError('RATE_LIMIT', `HTTP ${res.status}`);
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      if (res.status >= 500) {
        lastErr = new ExtractError('NETWORK', `HTTP ${res.status}`);
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
        continue;
      }
      throw new ExtractError('NETWORK', `HTTP ${res.status}`);
    } catch (e) {
      if (ctx) ctx.timer.networkMs += performance.now() - t0;
      if (e instanceof ExtractError && e.code !== 'NETWORK' && e.code !== 'RATE_LIMIT') throw e;
      lastErr = e instanceof ExtractError ? e : new ExtractError('NETWORK', e instanceof Error ? e.message : String(e));
      if (attempt < retries) await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new ExtractError('NETWORK');
}

export async function fetchJson<T = unknown>(ctx: AdapterContext | null, url: string, init: FetchJsonOptions = {}): Promise<T> {
  const res = await fetchWithRetry(ctx, url, init);
  const text = await res.text();
  const t0 = performance.now();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ExtractError('PARSE', 'invalid JSON');
  } finally {
    if (ctx) ctx.timer.parseMs += performance.now() - t0;
  }
}

export function readCookie(name: string): string | undefined {
  const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : undefined;
}

export function cleanTitle(raw: string | undefined | null, siteName: string): string {
  if (!raw) return '';
  return raw
    .replace(new RegExp(`\\s*[-|–—]\\s*${siteName}\\s*$`, 'i'), '')
    .replace(new RegExp(`^${siteName}\\s*[-|–—]\\s*`, 'i'), '')
    .trim();
}

export function titleFromFirstUserMessage(conv: Pick<Conversation, 'messages'>): string {
  const first = conv.messages.find((m) => m.role === 'user');
  const text = first?.contents.find((c) => c.content)?.content ?? '';
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}
