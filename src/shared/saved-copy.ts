// When the site limits or refuses the conversation request, or the network fails, the service
// worker builds the file from the copy an earlier run saved (lucianDB, 7 days) instead of
// reading the page, and the verification says how old that copy is (v1.3.10).

import type { ConversationRecord } from './db';
import type { Conversation } from './types';

/**
 * Collection failures that reading the page cannot fix. The content script does not read the page
 * for these (src/content/collect.ts); the service worker uses a saved copy instead, if any.
 */
export const FETCH_FAILURES: ReadonlySet<string> = new Set(['RATE_LIMIT', 'AUTH', 'NETWORK']);

/** The saved conversation to build from after `code`, marked as a saved copy; undefined if none fits. */
export function savedCopyFor(code: string, rec: ConversationRecord | undefined, retryAfterSec?: number): Conversation | undefined {
  if (!FETCH_FAILURES.has(code)) return undefined;
  const conv = rec?.conversation;
  // A copy read from the page may lack messages by nature: only a complete API copy stands in.
  if (!conv || conv.extraction.method !== 'api' || !conv.messages.length) return undefined;
  return { ...conv, extraction: { ...conv.extraction, savedCopy: { reason: code, retryAfterSec } } };
}
