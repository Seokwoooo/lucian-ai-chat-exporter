// HTTP 429 handling (v1.3.10). chatgpt.com answered a long chat's repeated full requests with 429
// and "Retry-After: 35" (2026-10-22); the extension gave up after 4.5 s and read the page instead,
// which scrolled the chat for ~40 s and kept 16 of 42 messages.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectConversation } from '../../src/content/collect';
import { ExtractError, RATE_LIMIT_TRIES, fetchWithRetry, retryAfterMs, type AdapterContext, type SiteAdapter } from '../../src/content/adapters/types';
import type { Conversation } from '../../src/shared/types';

function ctx(): AdapterContext & { waits: Array<[number, number | undefined]> } {
  const waits: Array<[number, number | undefined]> = [];
  return {
    url: 'https://chatgpt.com/c/x',
    bridge: null as never,
    timer: { networkMs: 0, parseMs: 0 },
    waits,
    progress: (label, done, total) => {
      if (label === 'wait') waits.push([done, total]);
    },
  };
}

/** Answers fetch() with the given responses in order (the last one repeats). */
function answer(...responses: Array<() => Response>) {
  let i = 0;
  const fn = vi.fn(async () => responses[Math.min(i++, responses.length - 1)]());
  vi.stubGlobal('fetch', fn);
  return fn;
}
const limited = (retryAfter?: string) => () => new Response('{"detail":"Too many requests"}', { status: 429, headers: retryAfter ? { 'retry-after': retryAfter } : {} });
const ok = () => new Response('{"ok":true}', { status: 200 });

afterEach(() => vi.unstubAllGlobals());

describe('retryAfterMs', () => {
  it('reads delay-seconds and HTTP dates', () => {
    expect(retryAfterMs('35')).toBe(35_000);
    expect(retryAfterMs(' 0.5 ')).toBe(500);
    const now = Date.parse('2026-10-22T01:00:00Z');
    expect(retryAfterMs('Thu, 22 Oct 2026 01:00:20 GMT', now)).toBe(20_000);
    expect(retryAfterMs('Thu, 22 Oct 2026 00:59:00 GMT', now)).toBe(0);
    expect(retryAfterMs('soon')).toBeUndefined();
    expect(retryAfterMs('')).toBeUndefined();
    expect(retryAfterMs(null)).toBeUndefined();
  });
});

describe('fetchWithRetry and HTTP 429', () => {
  it('conversation requests wait out Retry-After, counting down, then retry', async () => {
    const fetch = answer(limited('0.05'), ok);
    const c = ctx();
    const res = await fetchWithRetry(c, 'https://chatgpt.com/backend-api/conversation/x', { rateLimitWaitMs: 90_000 });
    expect(res.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(c.waits.length).toBeGreaterThan(0);
    expect(c.waits.at(-1)).toEqual([1, 1]); // the countdown ends at "retrying"
  });

  it(`gives up after ${RATE_LIMIT_TRIES} limited answers and says how long the site asked to wait`, async () => {
    const fetch = answer(limited('0.05'));
    const err = await fetchWithRetry(ctx(), 'https://x.test/a', { rateLimitWaitMs: 90_000 }).catch((e) => e);
    expect(err).toBeInstanceOf(ExtractError);
    expect(err.code).toBe('RATE_LIMIT');
    expect(err.retryAfterSec).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(RATE_LIMIT_TRIES);
  });

  it('does not wait at all when the saved copy already holds everything on the page', async () => {
    const fetch = answer(limited('35'), ok);
    const c = { ...ctx(), savedCopyIsCurrent: () => true };
    const t0 = Date.now();
    const err = await fetchWithRetry(c, 'https://chatgpt.com/backend-api/conversation/x', { rateLimitWaitMs: 90_000 }).catch((e) => e);
    expect(err.code).toBe('RATE_LIMIT');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(c.waits).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('does not start a wait longer than the budget', async () => {
    const fetch = answer(limited('120'), ok);
    const c = ctx();
    const err = await fetchWithRetry(c, 'https://x.test/a', { rateLimitWaitMs: 90_000 }).catch((e) => e);
    expect(err.code).toBe('RATE_LIMIT');
    expect(err.retryAfterSec).toBe(120);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(c.waits).toEqual([]);
  });

  it('optional requests (no wait budget) fail fast without a countdown', async () => {
    const fetch = answer(limited('35'), ok);
    const c = ctx();
    const err = await fetchWithRetry(c, 'https://x.test/title', { retries: 0 }).catch((e) => e);
    expect(err.code).toBe('RATE_LIMIT');
    expect(err.retryAfterSec).toBe(35);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(c.waits).toEqual([]);
  });

  it('keeps the other mappings: 5xx retried, 401 → AUTH, 404 → NOT_FOUND, 400 → NETWORK', async () => {
    answer(() => new Response('', { status: 503 }), ok);
    expect((await fetchWithRetry(ctx(), 'https://x.test/a')).status).toBe(200);
    answer(() => new Response('', { status: 401 }));
    expect((await fetchWithRetry(ctx(), 'https://x.test/a').catch((e) => e)).code).toBe('AUTH');
    answer(() => new Response('', { status: 404 }));
    expect((await fetchWithRetry(ctx(), 'https://x.test/a').catch((e) => e)).code).toBe('NOT_FOUND');
    const f = answer(() => new Response('', { status: 400 }));
    expect((await fetchWithRetry(ctx(), 'https://x.test/a').catch((e) => e)).code).toBe('NETWORK');
    expect(f).toHaveBeenCalledTimes(1);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    expect((await fetchWithRetry(ctx(), 'https://x.test/a', { retries: 0 }).catch((e) => e)).code).toBe('NETWORK');
  });
});

describe('collectConversation: when the page is read instead of the API', () => {
  const conv = (method: 'api' | 'dom'): Conversation => ({
    title: 't',
    pageId: 'x',
    fromUrl: 'https://chatgpt.com/c/x',
    site: 'chatgpt',
    siteName: 'ChatGPT',
    pageType: 'fullPage',
    messages: [{ id: 'm1', role: 'user', contents: [{ type: 'text', content: 'q' }] }],
    extraction: { method, sourceNodeCount: 1, missingNodeIds: [], skipped: [], warnings: [], fetchedAt: 0 },
  });
  const adapter = (apiError: unknown) => {
    const domFallback = vi.fn(async () => conv('dom'));
    const a = {
      site: 'chatgpt',
      getAllChatsForTopic: async () => {
        throw apiError;
      },
      domFallback,
      countDomUserTurns: () => 1,
      actionBars: () => [],
    } as unknown as SiteAdapter;
    return { a, domFallback };
  };

  for (const code of ['RATE_LIMIT', 'AUTH', 'NETWORK'] as const) {
    it(`${code}: no page reading (no scrolling); the error goes to the service worker`, async () => {
      const { a, domFallback } = adapter(new ExtractError(code, 'x', code === 'RATE_LIMIT' ? 35 : undefined));
      const err = await collectConversation(a, ctx(), 'x').catch((e) => e);
      expect(err.code).toBe(code);
      if (code === 'RATE_LIMIT') expect(err.retryAfterSec).toBe(35);
      expect(domFallback).not.toHaveBeenCalled();
    });
  }

  it('an answer the adapter no longer reads (PARSE, EMPTY, a parser bug) still falls back to the page', async () => {
    for (const e of [new ExtractError('PARSE', 'mapping missing'), new ExtractError('EMPTY'), new TypeError("Cannot read properties of undefined (reading 'parts')")]) {
      const { a, domFallback } = adapter(e);
      const out = await collectConversation(a, ctx(), 'x');
      expect(domFallback).toHaveBeenCalledTimes(1);
      expect(out.extraction.method).toBe('dom');
      expect(out.extraction.warnings[0]).toMatch(/^api-failed:(PARSE|EMPTY|UNKNOWN)$/);
    }
  });

  it('an API answer without messages is EMPTY and falls back', async () => {
    const domFallback = vi.fn(async () => conv('dom'));
    const a = { site: 'chatgpt', getAllChatsForTopic: async () => ({ ...conv('api'), messages: [] }), domFallback, countDomUserTurns: () => undefined, actionBars: () => [] } as unknown as SiteAdapter;
    const out = await collectConversation(a, ctx(), 'x');
    expect(out.extraction.warnings).toEqual(['api-failed:EMPTY']);
  });
});
