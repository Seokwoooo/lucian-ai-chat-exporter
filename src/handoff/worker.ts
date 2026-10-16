// Dedicated Web Worker that runs the handoff engine off the main thread. It reads the stored
// conversation and the previous analysis cache from IndexedDB, so only the conversation key
// crosses the thread boundary.

import { getConversation, getHandoffCache, putHandoffCache } from '../shared/db';
import { decodeCache, encodeCache } from './cache-codec';
import { runHandoff } from './engine';

export interface WorkerRequest {
  type: 'handoff';
  conversationKey: string;
}

export type WorkerMessage =
  | { type: 'phase'; phase: string }
  | { type: 'progress'; fraction: number }
  | {
      type: 'done';
      markdown: string;
      lang: 'ko' | 'en';
      stats: ReturnType<typeof runHandoff>['stats'];
      timings: ReturnType<typeof runHandoff>['timings'] & { loadMs: number; cacheSaveMs: number };
    }
  | { type: 'error'; message: string };

const post = (m: WorkerMessage) => (self as unknown as Worker).postMessage(m);

self.addEventListener('message', async (event: MessageEvent<WorkerRequest>) => {
  if (event.data?.type !== 'handoff') return;
  try {
    const key = event.data.conversationKey;
    const t0 = performance.now();
    const [conv, cacheRec] = await Promise.all([getConversation(key), getHandoffCache(key)]);
    if (!conv) throw new Error('conversation not found');
    const cache = decodeCache(cacheRec);
    const loadMs = performance.now() - t0;
    let last = -1;
    const res = runHandoff(conv, {
      cache,
      onPhase: (phase) => post({ type: 'phase', phase }),
      // Worker messages are delivered while the worker keeps computing; send whole percents only.
      onProgress: (fraction) => {
        const p = Math.floor(fraction * 100);
        if (p !== last) {
          last = p;
          post({ type: 'progress', fraction });
        }
      },
    });
    const t1 = performance.now();
    await putHandoffCache(encodeCache(key, res.cache)).catch(() => undefined);
    post({ type: 'done', markdown: res.markdown, lang: res.lang, stats: res.stats, timings: { ...res.timings, loadMs, cacheSaveMs: performance.now() - t1 } });
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
});
