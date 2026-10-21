// When the site limits or refuses the conversation request, or the network failed, the service
// worker builds the file from the copy an earlier run saved (lucianDB, 7 days) instead of
// reading the page, and the verification says how old that copy is (v1.3.10).
//
// The user never decides anything: when the page shows that the copy already holds the newest
// messages (every server id on the last rendered turns is in it, and the last answer reads the
// same), a 429 is not waited out and the copy is used at once; otherwise the extension waits for
// fresh data by itself.

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
  /**
   * How the copy's last answer ends (`plainKey`, last ANSWER_KEY characters); absent when the copy
   * does not end with an answer that has text. A regenerated answer keeps its question's id on
   * Claude and Gemini (2026-10-22), so the text is what tells the versions apart.
   */
  answer?: string;
  /** `answer` is the whole answer (short answers must then read exactly the same). */
  answerWhole?: boolean;
}

/** The page's newest turns (src/content/dom-fallback.ts `latestTurns`). */
export interface PageTail {
  /** Server ids on the last rendered turns. */
  ids: string[];
  /** The last answer as the page shows it, as a `plainKey`. */
  answer: string;
}

/** Ids per list kept in a CopyTail: the page's newest turns are among the last ones. */
const TAIL_IDS = 400;
/** Characters of the last answer kept in a CopyTail. */
const ANSWER_KEY = 40;

/** Letters and digits only, in lower case: what a text says, whatever markup is around it. */
export function plainKey(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Markdown reduced to what the page shows of it: no image links, link targets, fence lines or tags. */
function shownText(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(?:`{3,}|~{3,}).*$/gm, '')
    .replace(/<[^>]+>/g, '');
}

function lastAnswerKey(conv: Conversation): string {
  const last = conv.messages[conv.messages.length - 1];
  if (last?.role !== 'assistant') return '';
  const text = [...last.contents].reverse().find((c) => c.type === 'markdown' && c.content?.trim())?.content ?? '';
  return plainKey(shownText(text));
}

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
  const key = lastAnswerKey(conv);
  return {
    ids: [...ids],
    inProgress: conv.extraction.warnings.includes('answer-in-progress'),
    answer: key ? key.slice(-ANSWER_KEY) : undefined,
    answerWhole: key ? key.length <= ANSWER_KEY : undefined,
  };
}

/**
 * True when the page shows the end of the chat, every message there is in the copy and the last
 * answer reads like the copy's, i.e. nothing newer was said, regenerated or edited since. Anything
 * unknown is false: the extension then waits for fresh data rather than use a copy that might be behind.
 */
export function copyIsCurrent(page: PageTail | null | undefined, copy: CopyTail | undefined): boolean {
  if (!copy || copy.inProgress || !copy.answer || !page?.ids.length || !page.answer) return false;
  const have = new Set(copy.ids);
  if (!page.ids.every((id) => have.has(id))) return false;
  return copy.answerWhole ? page.answer === copy.answer : page.answer.includes(copy.answer);
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
