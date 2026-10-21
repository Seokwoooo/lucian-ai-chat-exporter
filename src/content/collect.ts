// Collection policy: the service API first; the rendered page only when the API answered in a
// shape the adapter no longer reads.

import { FETCH_FAILURES } from '../shared/saved-copy';
import type { Conversation } from '../shared/types';
import { ExtractError, type AdapterContext, type SiteAdapter } from './adapters/types';

/**
 * Reading the page cannot fix FETCH_FAILURES (the site limited or refused the request, or the
 * network failed): doing so scrolled the user's chat for ~40 s and kept 16 of its 42 messages
 * (chatgpt.com answered 429, 2026-10-22). These end the collection; the service worker then uses
 * the copy an earlier run saved, if there is one.
 */
export async function collectConversation(adapter: SiteAdapter, ctx: AdapterContext, conversationId: string): Promise<Conversation> {
  let conv: Conversation;
  try {
    conv = await adapter.getAllChatsForTopic(ctx, conversationId);
    if (!conv.messages.length) throw new ExtractError('EMPTY');
  } catch (apiError) {
    const code = apiError instanceof ExtractError ? apiError.code : 'UNKNOWN';
    if (FETCH_FAILURES.has(code)) throw apiError;
    // The API changed shape: read the rendered page so the user still gets a result, and record
    // why so the verification report can say how the data was obtained.
    try {
      conv = await adapter.domFallback(ctx, conversationId);
      conv.extraction.warnings.push(`api-failed:${code}`);
    } catch {
      throw apiError;
    }
  }
  conv.extraction.domUserTurns = adapter.countDomUserTurns();
  conv.extraction.networkMs = Math.round(ctx.timer.networkMs);
  conv.extraction.parseMs = Math.round(ctx.timer.parseMs);
  return conv;
}
