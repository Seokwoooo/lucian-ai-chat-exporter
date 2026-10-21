// When the site limits or refuses the conversation request, or the network failed, the service
// worker builds the file from the copy an earlier run saved (lucianDB, 7 days) instead of
// reading the page, and the verification says how old that copy is (v1.3.10).
//
// The user never decides anything: when the page shows that the copy already holds the newest
// messages (every server id on the last rendered turns is in it), a 429 is not waited out and the
// copy is used at once; otherwise the extension waits for fresh data by itself.

import type { ConversationRecord } from './db';
import type { Conversation } from './types';

/**
 * Collection failures that reading the page cannot fix. The content script does not read the page
 * for these (src/content/collect.ts); the service worker uses a saved copy instead, if any.
 */
export const FETCH_FAILURES: ReadonlySet<string> = new Set(['RATE_LIMIT', 'AUTH', 'NETWORK']);

/** What the content script needs to tell whether a saved copy is current (sent with 'collect'). */
export interface CopyTail {
  /** Server ids near the end of the copy's current path (exported, skipped and unreadable nodes). */
  ids: string[];
  /** The copy was taken while the last answer was still being written. */
  inProgress: boolean;
}

/** Ids per list kept in a CopyTail: the page's newest turns are among the last ones. */
const TAIL_IDS = 400;

export function copyTail(conv: Conversation): CopyTail {
  const exported = conv.messages.flatMap((m) => (m.ids?.length ? m.ids : [m.id]));
  const raw = [...exported.slice(-TAIL_IDS), ...conv.extraction.skipped.slice(-TAIL_IDS).map((s) => s.id), ...conv.extraction.missingNodeIds.slice(-TAIL_IDS)];
  const ids = new Set<string>();
  for (const id of raw) {
    if (!id) continue;
    ids.add(id);
    const base = id.split(':')[0]; // Gemini user messages are "<response id>:q"
    if (base) ids.add(base);
  }
  return { ids: [...ids], inProgress: conv.extraction.warnings.includes('answer-in-progress') };
}

/**
 * True when the page shows the end of the chat and every message there is in the copy, i.e. nothing
 * newer was said, regenerated or edited since. Anything unknown is false: the extension then waits
 * for fresh data rather than use a copy that might be behind.
 */
export function copyIsCurrent(pageIds: string[] | null | undefined, copy: CopyTail | undefined): boolean {
  if (!copy || copy.inProgress || !pageIds?.length) return false;
  const have = new Set(copy.ids);
  return pageIds.every((id) => have.has(id));
}

/**
 * The saved conversation to build from after `code`, marked as a saved copy (`current`: the page
 * showed nothing newer); undefined if none fits.
 */
export function savedCopyFor(code: string, rec: ConversationRecord | undefined, retryAfterSec?: number, current?: boolean): Conversation | undefined {
  if (!FETCH_FAILURES.has(code)) return undefined;
  const conv = rec?.conversation;
  // A copy read from the page may lack messages by nature: only a complete API copy stands in.
  if (!conv || conv.extraction.method !== 'api' || !conv.messages.length) return undefined;
  return { ...conv, extraction: { ...conv.extraction, savedCopy: { reason: code, retryAfterSec, current: current || undefined } } };
}
