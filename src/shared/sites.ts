import type { SiteId } from './types';

export interface SiteInfo {
  id: SiteId;
  name: string;
  home: string;
}

export const SITES: Record<SiteId, SiteInfo> = {
  chatgpt: { id: 'chatgpt', name: 'ChatGPT', home: 'https://chatgpt.com/' },
  claude: { id: 'claude', name: 'Claude', home: 'https://claude.ai/' },
  gemini: { id: 'gemini', name: 'Gemini', home: 'https://gemini.google.com/' },
  grok: { id: 'grok', name: 'Grok', home: 'https://grok.com/' },
};

/**
 * "chatgpt.com", "grok.com" — where a conversation was exported from. Documents show this instead of
 * the service and model names (v1.3.8: model slugs such as "grok-4" were confusing as a source).
 */
export function sourceDomain(conv: { site: SiteId; fromUrl?: string }): string {
  try {
    const host = new URL(conv.fromUrl ?? '').hostname.replace(/^www\./, '');
    if (detectSite(`https://${host}/`) === conv.site) return host;
  } catch {
    /* not a URL: fall back to the service's home */
  }
  const home = SITES[conv.site]?.home;
  return home ? new URL(home).hostname : String(conv.site);
}

export function detectSite(url: string | undefined): SiteId | null {
  if (!url) return null;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  if (host === 'chatgpt.com' || host === 'chat.openai.com') return 'chatgpt';
  if (host === 'claude.ai') return 'claude';
  if (host === 'gemini.google.com') return 'gemini';
  if (host === 'grok.com') return 'grok';
  return null;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/**
 * Extracts the conversation id from a page URL (tech doc §5.1 v9, §7.1 G9, §6 G3, §9 B9).
 * Returns null when the page is not an individual conversation (e.g. the home screen).
 */
export function extractConversationId(site: SiteId, url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const path = u.pathname;
  switch (site) {
    case 'chatgpt': {
      // /c/{uuid}, /g/{gizmo}/c/{uuid}, project chats /g/g-p-.../c/{uuid}
      const m = path.match(/\/c\/([0-9a-f-]{20,})/i);
      return m ? m[1] : null;
    }
    case 'claude': {
      const m = path.match(new RegExp(`/chat/(${UUID})`, 'i'));
      return m ? m[1] : null;
    }
    case 'gemini': {
      // /app/{hex}, /u/1/app/{hex}, /gem/{gemId}/{hex}
      const app = path.match(/\/app\/([0-9a-f]{8,})/i);
      if (app) return app[1];
      const gem = path.match(/\/gem\/[^/]+\/([0-9a-f]{8,})/i);
      return gem ? gem[1] : null;
    }
    case 'grok': {
      const m = path.match(/\/(?:c|chat)\/([0-9a-z-]{8,})/i);
      if (m) return m[1];
      const q = u.searchParams.get('chat') || u.searchParams.get('conversation');
      return q && /^[0-9a-z-]{8,}$/i.test(q) ? q : null;
    }
  }
}
