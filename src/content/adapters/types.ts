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
    /** RATE_LIMIT: how long the site asked to wait (Retry-After), when it said so. */
    public retryAfterSec?: number,
  ) {
    super(message ?? code);
  }
}

export interface AdapterContext {
  url: string;
  bridge: Bridge;
  /** 'wait': waiting out a 429 — `done` of `total` seconds have passed. */
  progress: (label: 'messages' | 'pages' | 'wait', done: number, total?: number) => void;
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
  /**
   * Action toolbars under finished assistant answers (copy, retry…) where the in-page Lucian button
   * is added. The site renders them only once an answer is complete.
   */
  actionBars(): Element[];
  /**
   * Element of `bar` the Lucian button goes in front of, so it sits right after the site's own
   * buttons rather than past a spacer (Gemini). Default: appended at the end.
   */
  actionAnchor?(bar: Element): Element | null;
}

export interface FetchJsonOptions extends RequestInit {
  timeoutMs?: number;
  /** Extra attempts after a network error, a 5xx, or (when not waiting it out) a 429. */
  retries?: number;
  /**
   * Longest total time to wait out HTTP 429 answers, honouring Retry-After. Set for the requests
   * that carry the conversation itself; optional requests (titles, file links) keep the default 0:
   * a short backoff within `retries`, then failure.
   */
  rateLimitWaitMs?: number;
}

/**
 * chatgpt.com answered a long chat's third or fourth full request within a few minutes with 429
 * and "Retry-After: 35" (2026-10-22); giving up after 4.5 s and reading the page instead kept 16
 * of its 42 messages. The conversation requests wait up to this long instead.
 */
export const RATE_LIMIT_WAIT_MS = 90_000;
/** Answers to try before giving up on a rate-limited request (the first one included). */
export const RATE_LIMIT_TRIES = 3;
/** Wait when a 429 names no Retry-After: 3 s, then 6 s. */
const RATE_LIMIT_BACKOFF_MS = 3_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Retry-After as milliseconds: delay-seconds or an HTTP date (RFC 9110 §10.2.3). */
export function retryAfterMs(value: string | null | undefined, now = Date.now()): number | undefined {
  const s = value?.trim();
  if (!s) return undefined;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const at = Date.parse(s);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/** Waits `ms`, reporting each second passed so the popup and the page panel can count down. */
async function waitOut(ctx: AdapterContext | null, ms: number): Promise<void> {
  const total = Math.max(1, Math.ceil(ms / 1000));
  const end = Date.now() + ms;
  for (let left = ms; left > 0; left = end - Date.now()) {
    ctx?.progress('wait', total - Math.ceil(left / 1000), total);
    await sleep(Math.min(1000, left));
  }
  ctx?.progress('wait', total, total);
}

/** fetch wrapper that maps HTTP failures to ExtractError codes and retries transient errors. */
export async function fetchWithRetry(
  ctx: AdapterContext | null,
  url: string,
  init: FetchJsonOptions = {},
): Promise<Response> {
  const { timeoutMs = 60_000, retries = 1, rateLimitWaitMs = 0, ...rest } = init;
  let failures = 0;
  let limited = 0;
  let waited = 0;
  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const t0 = performance.now();
    let res: Response;
    try {
      res = await fetch(url, { credentials: 'include', ...rest, signal: controller.signal });
    } catch (e) {
      // Offline, DNS, connection reset, or our own timeout.
      if (failures++ < retries) {
        await sleep(800 * failures);
        continue;
      }
      throw new ExtractError('NETWORK', e instanceof Error ? e.message : String(e));
    } finally {
      clearTimeout(timer);
      if (ctx) ctx.timer.networkMs += performance.now() - t0;
    }
    if (res.ok) return res;
    if (res.status === 401 || res.status === 403) throw new ExtractError('AUTH', `HTTP ${res.status}`);
    if (res.status === 404) throw new ExtractError('NOT_FOUND', `HTTP ${res.status}`);
    if (res.status === 429) {
      limited++;
      const asked = retryAfterMs(res.headers.get('retry-after'));
      const error = new ExtractError('RATE_LIMIT', 'HTTP 429', asked != null ? Math.ceil(asked / 1000) : undefined);
      if (rateLimitWaitMs > 0) {
        const wait = asked ?? RATE_LIMIT_BACKOFF_MS * limited;
        if (limited >= RATE_LIMIT_TRIES || waited + wait > rateLimitWaitMs) throw error;
        waited += wait;
        await waitOut(ctx, wait);
        continue;
      }
      if (failures++ < retries) {
        await sleep(1500 * failures);
        continue;
      }
      throw error;
    }
    if (res.status >= 500 && failures++ < retries) {
      await sleep(800 * failures);
      continue;
    }
    throw new ExtractError('NETWORK', `HTTP ${res.status}`);
  }
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

/**
 * Elements of the conversation on screen. Single-page sites keep earlier conversations mounted but
 * hidden (`display: none`) after in-app navigation (seen on chatgpt.com in 2026-10), so a plain
 * querySelectorAll also returns another conversation's turns. Turns scrolled out of view still count.
 */
export function renderedElements(selector: string): Element[] {
  return Array.from(document.querySelectorAll(selector)).filter((el) => el.checkVisibility());
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
