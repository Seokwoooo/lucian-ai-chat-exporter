// DOM fallback used only when a service API answers in a shape the adapter no longer reads (not
// when the site limits or refuses the request: src/content/collect.ts). Selectors live in one table per site so
// a site redesign only requires editing this map. Lazy-rendered history is loaded by scrolling
// the chat container to the top until the message count stops growing; virtualized lists (which
// unmount turns that leave the viewport) are then read while scrolling back down.

import { SITES } from '../shared/sites';
import type { Conversation, ExportMessage, Role, SiteId } from '../shared/types';
import { sleep } from '../shared/util';
import { ExtractError, cleanTitle, renderedElements, titleFromFirstUserMessage, type AdapterContext } from './adapters/types';
import { htmlToMarkdown } from './html-to-md';

interface DomSpec {
  items: string;
  role: (el: Element) => Role;
  content: (el: Element, role: Role) => Element;
  /** Stable id that survives re-rendering (needed for virtualized lists). */
  key?: (el: Element) => string | null;
  /**
   * Server ids of the message an element shows, as the adapter stores them (checked against the
   * API on all four sites, 2026-10-22). Used to tell whether a saved copy already holds the newest
   * messages (src/shared/saved-copy.ts).
   */
  turnIds: (el: Element) => string[];
  /** The row the site marks as the conversation's last message, when it marks one. */
  lastRow?: string;
  /** Parts of an answer the site draws without message ids: when one is the newest thing on the page, it cannot be compared. */
  unidentified?: string;
  /** A turn the site marks as still being written. */
  busy?: string;
}

const ID = /^[\w-]{1,80}$/;
const idsOf = (value: string | null | undefined): string[] => (value ?? '').split(/\s+/).filter((v) => ID.test(v));

export const DOM_SPECS: Record<SiteId, DomSpec> = {
  chatgpt: {
    // Older layout: [data-message-author-role]. Layout seen on chatgpt.com in 2026-10: one
    // [data-chatgpt-search-unit-key] block per message, user bubbles marked
    // [data-user-message-bubble], assistant blocks labelled by an sr-only heading.
    items: '[data-message-author-role], [data-chatgpt-search-unit-key]',
    role: (el) => {
      const r = el.getAttribute('data-message-author-role');
      if (r) return r === 'user' ? 'user' : 'assistant';
      return el.querySelector('[data-user-message-bubble]') ? 'user' : 'assistant';
    },
    content: (el, role) =>
      el.querySelector('.markdown') ??
      (role === 'user' ? el.querySelector('[data-user-message-bubble] .whitespace-pre-wrap') ?? el.querySelector('[data-user-message-bubble]') : null) ??
      (el.hasAttribute('data-message-author-role') ? el.querySelector('.whitespace-pre-wrap') : null) ??
      el,
    key: (el) => el.getAttribute('data-chatgpt-search-unit-key') || el.getAttribute('data-message-id'),
    // 2026-10: each block lists its mapping node ids; the older layout has one data-message-id.
    turnIds: (el) => idsOf(el.closest('[data-chatgpt-search-message-ids]')?.getAttribute('data-chatgpt-search-message-ids') ?? el.closest('[data-message-id]')?.getAttribute('data-message-id')),
    // 2026-10-22: the work log of a long-running answer ("Worked for 34m") follows the question
    // with only a work-activity id, shared by several turns, so a regenerated run looks the same.
    unidentified: '[data-local-conversation-item-target-ids]',
    busy: '[data-talvt-turn-state]:not([data-talvt-turn-state="complete"])',
  },
  claude: {
    // claude.ai in 2026-10 renders a virtualized transcript: [data-testid="assistant-message"]
    // replaced .font-claude-response, and every message sits under a [data-turn-key] row.
    items: '[data-testid="user-message"], [data-testid="assistant-message"], .font-claude-response, .font-claude-message',
    role: (el) => (el.matches('[data-testid="user-message"]') ? 'user' : 'assistant'),
    content: (el) => el,
    key: (el) => {
      const k = el.closest('[data-turn-key]')?.getAttribute('data-turn-key') ?? el.closest('[data-testid="transcript-row"]')?.getAttribute('data-index');
      return k ? `${el.matches('[data-testid="user-message"]') ? 'u' : 'a'}:${k}` : null;
    },
    // data-turn-key is the message uuid; the row of the newest message carries data-last-message.
    turnIds: (el) => idsOf(el.closest('[data-turn-key]')?.getAttribute('data-turn-key')),
    lastRow: '[data-last-message="true"]',
  },
  gemini: {
    items: 'user-query, model-response',
    role: (el) => (el.tagName.toLowerCase() === 'user-query' ? 'user' : 'assistant'),
    content: (el, role) =>
      role === 'user'
        ? el.querySelector('.query-text') ?? el
        : el.querySelector('message-content .markdown') ?? el.querySelector('message-content') ?? el,
    // Each turn sits in a .conversation-container whose id is the response id without "r_".
    turnIds: (el) => idsOf(el.closest('.conversation-container')?.id).map((id) => (id.startsWith('r_') ? id : `r_${id}`)),
  },
  grok: {
    items: '.message-bubble',
    role: (el) => (el.closest('[class*="items-end"]') ? 'user' : 'assistant'),
    content: (el) => el,
    turnIds: (el) => idsOf(el.closest('[id^="response-"]')?.id.slice('response-'.length)),
  },
};

function outermost(list: Element[]): Element[] {
  const set = new Set(list);
  return list.filter((el) => {
    let p = el.parentElement;
    while (p) {
      if (set.has(p)) return false;
      p = p.parentElement;
    }
    return true;
  });
}

/**
 * Puts the user back where they were. Loading history adds content above (the transcript doubled
 * from 22k to 44k px on chatgpt.com, 2026-10-22), so the same scrollTop showed an earlier part of
 * the chat: keep the distance from the bottom instead.
 */
function keepPosition(scroller: HTMLElement): () => void {
  const fromBottom = scroller.scrollHeight - scroller.scrollTop;
  return () => {
    scroller.scrollTop = Math.max(0, scroller.scrollHeight - fromBottom);
  };
}

function scrollableAncestor(el: Element | null): HTMLElement | null {
  let p = el?.parentElement ?? null;
  while (p && p !== document.body) {
    const style = getComputedStyle(p);
    if (/(auto|scroll)/.test(style.overflowY) && p.scrollHeight > p.clientHeight + 10) return p;
    p = p.parentElement;
  }
  return (document.scrollingElement as HTMLElement | null) ?? null;
}

/** How far below `el` the scrollable content goes: small when the page shows the end of the chat. */
function contentBelow(el: Element): number {
  const scroller = scrollableAncestor(el);
  if (!scroller) return 0;
  const bottom = el.getBoundingClientRect().bottom;
  const top = scroller === document.scrollingElement ? -scroller.scrollTop : scroller.getBoundingClientRect().top;
  return scroller.scrollHeight - (bottom - top + scroller.scrollTop);
}

/** A virtualized list scrolled up leaves the newest turns unmounted, with their height as padding. */
const END_SLACK_PX = 2000;

/** True when `b` comes after `a` in the page and is not inside it. */
const follows = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) && !a.contains(b);

/**
 * Server ids of the newest messages on the page (the last rendered turns), or null whenever that
 * cannot be told for sure: the list is scrolled up, a turn is still being written, the newest
 * message is a question (its answer is missing or drawn without ids: chatgpt.com images and work
 * logs, 2026-10-22, so a regenerated answer would go unnoticed), or one of the newest turns carries
 * no ids. Null means "wait for the site", never "use the copy". Read only while a job runs.
 */
export function latestTurnIds(site: SiteId): string[] | null {
  const spec = DOM_SPECS[site];
  const els = outermost(renderedElements(spec.items));
  const last = els[els.length - 1];
  if (!last || spec.role(last) !== 'assistant') return null;
  const marked = spec.lastRow ? document.querySelector(spec.lastRow) : null;
  const atEnd = marked ? marked.contains(last) || last.contains(marked) || !!last.closest(spec.lastRow!) : contentBelow(last) < END_SLACK_PX;
  if (!atEnd) return null;
  if (spec.busy && renderedElements(spec.busy).length) return null;
  const idless = spec.unidentified ? renderedElements(spec.unidentified).pop() : undefined;
  if (idless && follows(last, idless)) return null;
  const ids = new Set<string>();
  for (const el of els.slice(-4)) {
    const own = spec.turnIds(el);
    if (!own.length) return null;
    for (const id of own) ids.add(id);
  }
  return [...ids];
}

/** Scrolls up until no more history renders (bounded to keep the fallback responsive). */
async function loadLazyHistory(spec: DomSpec, ctx: AdapterContext): Promise<void> {
  const scroller = scrollableAncestor(renderedElements(spec.items)[0] ?? null);
  if (!scroller) return;
  const restore = keepPosition(scroller);
  let last = renderedElements(spec.items).length;
  let stable = 0;
  const deadline = Date.now() + 45_000;
  for (let i = 0; i < 120 && Date.now() < deadline && stable < 3; i++) {
    scroller.scrollTop = 0;
    await sleep(700);
    const count = renderedElements(spec.items).length;
    ctx.progress('messages', count);
    if (count > last) {
      last = count;
      stable = 0;
    } else {
      stable++;
    }
  }
  restore();
}

interface DomItem {
  role: Role;
  md: string;
}

/**
 * Reads every message element once, in document order, keyed by a stable id. Elements without a
 * site key are keyed by identity, which is stable as long as the list is not virtualized.
 */
class DomCollector {
  readonly order: string[] = [];
  readonly items = new Map<string, DomItem>();
  private readonly ids = new WeakMap<Element, string>();
  private seq = 0;

  constructor(private readonly spec: DomSpec) {}

  scan(): number {
    // Only the conversation on screen: earlier ones can stay mounted but hidden (see renderedElements).
    const elements = outermost(renderedElements(this.spec.items));
    let anchor = -1;
    for (const el of elements) {
      let key = this.spec.key?.(el) ?? this.ids.get(el);
      if (!key) {
        key = `el-${++this.seq}`;
        this.ids.set(el, key);
      }
      const known = this.items.has(key);
      if (!known) {
        const role = this.spec.role(el);
        this.items.set(key, { role, md: htmlToMarkdown(this.spec.content(el, role)) });
        this.order.splice(anchor + 1, 0, key);
        anchor++;
      } else {
        anchor = this.order.indexOf(key);
      }
    }
    return elements.length;
  }
}

/** Walks a virtualized list from top to bottom so turns that are unmounted get read too. */
async function scanDownwards(collector: DomCollector, spec: DomSpec): Promise<void> {
  const scroller = scrollableAncestor(renderedElements(spec.items)[0] ?? null);
  if (!scroller) return;
  const restore = keepPosition(scroller);
  const deadline = Date.now() + 60_000;
  scroller.scrollTop = 0;
  await sleep(300);
  for (let i = 0; i < 400 && Date.now() < deadline; i++) {
    collector.scan();
    if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) break;
    scroller.scrollTop += Math.max(200, scroller.clientHeight * 0.8);
    await sleep(250);
  }
  collector.scan();
  restore();
}

export async function domFallbackExtract(site: SiteId, ctx: AdapterContext, conversationId: string): Promise<Conversation> {
  const spec = DOM_SPECS[site];
  await loadLazyHistory(spec, ctx);
  const t0 = performance.now();
  const collector = new DomCollector(spec);
  collector.scan();
  if (spec.key) await scanDownwards(collector, spec);
  const messages: ExportMessage[] = [];
  const missing: string[] = [];
  const missingKinds: string[] = [];
  collector.order.forEach((key, i) => {
    const { role, md } = collector.items.get(key)!;
    const id = `dom-${i + 1}`;
    if (!md) {
      missing.push(id);
      missingKinds.push(`${role}:screen`);
      return;
    }
    messages.push({ id, ids: [id], role, contents: [{ type: role === 'user' ? 'text' : 'markdown', content: md }] });
  });
  ctx.timer.parseMs += performance.now() - t0;
  if (!messages.length) throw new ExtractError('EMPTY', 'no messages in DOM');
  const conv: Conversation = {
    title: cleanTitle(document.title, SITES[site].name),
    pageId: conversationId,
    fromUrl: ctx.url,
    site,
    siteName: SITES[site].name,
    pageType: 'fullPage',
    messages,
    extraction: {
      method: 'dom',
      sourceNodeCount: collector.order.length,
      missingNodeIds: missing,
      missingKinds,
      skipped: [],
      warnings: [],
      fetchedAt: Date.now(),
    },
  };
  if (!conv.title || conv.title.toLowerCase() === SITES[site].name.toLowerCase()) conv.title = titleFromFirstUserMessage(conv);
  return conv;
}
