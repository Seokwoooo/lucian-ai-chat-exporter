// DOM fallback used only when a service API path fails. Selectors live in one table per site so
// a site redesign only requires editing this map. Lazy-rendered history is loaded by scrolling
// the chat container to the top until the message count stops growing.

import { SITES } from '../shared/sites';
import type { Conversation, ExportMessage, Role, SiteId } from '../shared/types';
import { sleep } from '../shared/util';
import { ExtractError, cleanTitle, titleFromFirstUserMessage, type AdapterContext } from './adapters/types';
import { htmlToMarkdown } from './html-to-md';

interface DomSpec {
  items: string;
  role: (el: Element) => Role;
  content: (el: Element, role: Role) => Element;
}

export const DOM_SPECS: Record<SiteId, DomSpec> = {
  chatgpt: {
    items: '[data-message-author-role]',
    role: (el) => (el.getAttribute('data-message-author-role') === 'user' ? 'user' : 'assistant'),
    content: (el) => el.querySelector('.markdown') ?? el.querySelector('.whitespace-pre-wrap') ?? el,
  },
  claude: {
    items: '[data-testid="user-message"], .font-claude-response, .font-claude-message',
    role: (el) => (el.matches('[data-testid="user-message"]') ? 'user' : 'assistant'),
    content: (el) => el,
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
  const first = document.querySelector(spec.items);
  const scroller = scrollableAncestor(first);
  if (!scroller) return;
  const original = scroller.scrollTop;
  let last = document.querySelectorAll(spec.items).length;
  let stable = 0;
  const deadline = Date.now() + 45_000;
  for (let i = 0; i < 120 && Date.now() < deadline && stable < 3; i++) {
    scroller.scrollTop = 0;
    await sleep(700);
    const count = document.querySelectorAll(spec.items).length;
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

export async function domFallbackExtract(site: SiteId, ctx: AdapterContext, conversationId: string): Promise<Conversation> {
  const spec = DOM_SPECS[site];
  await loadLazyHistory(spec, ctx);
  const t0 = performance.now();
  const elements = outermost(Array.from(document.querySelectorAll(spec.items)));
  const messages: ExportMessage[] = [];
  const missing: string[] = [];
  elements.forEach((el, i) => {
    const role = spec.role(el);
    const md = htmlToMarkdown(spec.content(el, role));
    const id = `dom-${i + 1}`;
    if (!md) {
      missing.push(id);
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
      sourceNodeCount: elements.length,
      missingNodeIds: missing,
      skipped: [],
      warnings: [],
      fetchedAt: Date.now(),
    },
  };
  if (!conv.title || conv.title.toLowerCase() === SITES[site].name.toLowerCase()) conv.title = titleFromFirstUserMessage(conv);
  return conv;
}
