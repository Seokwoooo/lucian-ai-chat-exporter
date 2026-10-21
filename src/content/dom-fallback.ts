// DOM fallback used only when a service API path fails. Selectors live in one table per site so
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
}

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
  },
  gemini: {
    items: 'user-query, model-response',
    role: (el) => (el.tagName.toLowerCase() === 'user-query' ? 'user' : 'assistant'),
    content: (el, role) =>
      role === 'user'
        ? el.querySelector('.query-text') ?? el
        : el.querySelector('message-content .markdown') ?? el.querySelector('message-content') ?? el,
  },
  grok: {
    items: '.message-bubble',
    role: (el) => (el.closest('[class*="items-end"]') ? 'user' : 'assistant'),
    content: (el) => el,
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

function scrollableAncestor(el: Element | null): HTMLElement | null {
  let p = el?.parentElement ?? null;
  while (p && p !== document.body) {
    const style = getComputedStyle(p);
    if (/(auto|scroll)/.test(style.overflowY) && p.scrollHeight > p.clientHeight + 10) return p;
    p = p.parentElement;
  }
  return (document.scrollingElement as HTMLElement | null) ?? null;
}

/** Scrolls up until no more history renders (bounded to keep the fallback responsive). */
async function loadLazyHistory(spec: DomSpec, ctx: AdapterContext): Promise<void> {
  const scroller = scrollableAncestor(renderedElements(spec.items)[0] ?? null);
  if (!scroller) return;
  const original = scroller.scrollTop;
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
  scroller.scrollTop = original;
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
  const original = scroller.scrollTop;
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
  scroller.scrollTop = original;
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
