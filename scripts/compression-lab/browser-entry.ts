// Runs the compression lab inside a logged-in chatgpt.com tab, on the user's own conversations.
// Conversations are fetched with the page's own session (same request the extension makes),
// kept in this tab's memory only, and only aggregate scores are returned. Build with
// `npm run lab:browser` and paste dist-lab/lab.js into the DevTools console of chatgpt.com.

import type { Conversation } from '../../src/shared/types';
import { parseChatGPTConversation } from '../../src/content/adapters/chatgpt';
import { formatSummary, runLab, type LabRow, type LabSummary } from './lab';

interface LabState {
  phase: string;
  listed: number;
  fetched: number;
  kept: number;
  errors: number;
  convs: Conversation[];
  rows: LabRow[];
  summary?: LabSummary;
  outputs: Map<string, string>;
  progress: string;
}

const state: LabState = { phase: 'idle', listed: 0, fetched: 0, kept: 0, errors: 0, convs: [], rows: [], outputs: new Map(), progress: '' };

async function headers(): Promise<Record<string, string>> {
  const s = await fetch('/api/auth/session', { credentials: 'include' }).then((r) => r.json());
  return s?.accessToken ? { Authorization: `Bearer ${s.accessToken}` } : {};
}

async function collect(maxListed: number, keep: number, minChars: number): Promise<void> {
  state.phase = 'listing';
  const h = await headers();
  const ids: string[] = [];
  for (let offset = 0; offset < maxListed; offset += 100) {
    const r = await fetch(`/backend-api/conversations?offset=${offset}&limit=100&order=updated`, { headers: h, credentials: 'include' }).then((x) => x.json());
    const items: Array<{ id: string }> = r?.items ?? [];
    ids.push(...items.map((i) => i.id));
    if (items.length < 100) break;
  }
  state.listed = ids.length;
  state.phase = 'fetching';
  for (const id of ids) {
    if (state.kept >= keep) break;
    try {
      const data = await fetch(`/backend-api/conversation/${id}`, { headers: h, credentials: 'include' }).then((x) => x.json());
      state.fetched++;
      const conv = parseChatGPTConversation(data, { conversationId: id, url: `${location.origin}/c/${id}` });
      const chars = conv.messages.reduce((s, m) => s + m.contents.reduce((t, c) => t + (c.type === 'thinking' ? 0 : (c.content ?? '').length), 0), 0);
      if (chars >= minChars) {
        state.convs.push(conv);
        state.kept++;
      }
    } catch {
      state.errors++;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  state.phase = 'collected';
}

const api = {
  /** Starts fetching up to `maxListed` recent conversations, keeping `keep` with ≥ `minChars` visible characters. */
  collect(maxListed = 300, keep = 30, minChars = 40_000): string {
    void collect(maxListed, keep, minChars).catch((e) => {
      state.phase = `error: ${e instanceof Error ? e.message : e}`;
    });
    return 'started';
  },
  /** Starts the lab on the collected conversations. */
  run(ratios = [0.05, 0.1, 0.2], algorithms?: string[]): string {
    state.phase = 'running';
    state.rows = [];
    void runLab(state.convs, {
      ratios,
      algorithms,
      minTokens: 12_000,
      onProgress: (d, t) => (state.progress = `${d}/${t}`),
      keepOutputs: (k, v) => state.outputs.set(k, v),
    }).then(
      (r) => {
        state.rows = r.rows;
        state.summary = r.summary;
        state.phase = 'done';
      },
      (e) => (state.phase = `error: ${e instanceof Error ? e.message : e}`),
    );
    return 'running';
  },
  /** Counts only — no titles, ids or text. */
  status() {
    return {
      phase: state.phase,
      listed: state.listed,
      fetched: state.fetched,
      kept: state.kept,
      errors: state.errors,
      progress: state.progress,
      sizes: state.convs.map((c) => ({ messages: c.messages.length, chars: c.messages.reduce((s, m) => s + m.contents.reduce((t, x) => t + (x.type === 'thinking' ? 0 : (x.content ?? '').length), 0), 0) })),
    };
  },
  summary(): string {
    return state.summary ? formatSummary(state.summary) : state.phase;
  },
  rows(): LabRow[] {
    return state.rows;
  },
  /** One output for manual review: conversation index, budget ratio, algorithm name. */
  output(conv: number, ratio: number, algo: string): string | undefined {
    return state.outputs.get(`${conv}:${ratio}:${algo}`);
  },
};

(window as unknown as { __lucianLab: typeof api }).__lucianLab = api;
