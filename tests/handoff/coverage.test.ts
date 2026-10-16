import { describe, expect, it } from 'vitest';
import { conceptsOf, greedyCoverage, type CoverItem } from '../../src/handoff/coverage';
import { handoffTargets, handoffVisualHtml } from '../../src/shared/handoff-visual';

const item = (id: number, words: string, cost = 10, prior = 1): CoverItem => ({ id, concepts: conceptsOf(words.split(' ')), cost, prior });

describe('budgeted maximum coverage', () => {
  it('adds word pairs to the concepts', () => {
    expect(conceptsOf(['tauri', 'desktop', 'app'])).toEqual(['tauri', 'desktop', 'app', 'tauri desktop', 'desktop app']);
  });

  it('skips a unit whose concepts are already covered', () => {
    const items = [item(0, 'tauri desktop app'), item(1, 'tauri desktop app'), item(2, 'sqlite storage layer')];
    const picked = greedyCoverage(items, () => 1, 30);
    expect(picked).toContain(2);
    expect(picked.filter((i) => i === 0 || i === 1)).toHaveLength(1);
  });

  it('respects the budget and prefers more new information per token', () => {
    const items = [item(0, 'a b', 10), item(1, 'c d e f g h', 12), item(2, 'i j k l', 40)];
    const picked = greedyCoverage(items, () => 1, 25);
    expect(picked).toEqual([1, 0]);
  });

  it('counts concepts covered beforehand as known', () => {
    const items = [item(0, 'redux banned'), item(1, 'graphql schema')];
    const covered = new Set(conceptsOf(['redux', 'banned']));
    expect(greedyCoverage(items, () => 1, 100, covered)).toEqual([1]);
  });

  it('weights concepts and priors', () => {
    const items = [item(0, 'common words', 10, 1), item(1, 'rare term', 10, 1)];
    const w = (c: string) => (c.includes('rare') ? 5 : 1);
    expect(greedyCoverage(items, w, 10)).toEqual([1]);
    expect(greedyCoverage([item(0, 'x y', 10, 3), item(1, 'z w', 10, 1)], () => 1, 10)).toEqual([0]);
  });
});

describe('handoff illustration', () => {
  it('shows the current service first and the other three as destinations', () => {
    expect(handoffTargets('claude')).toEqual(['chatgpt', 'gemini', 'grok']);
    expect(handoffTargets(null)).toEqual(['claude', 'gemini', 'grok']);
    const html = handoffVisualHtml('gemini', (s) => `chrome-extension://x/providers/${s}.svg`, 'ko', 'dark');
    expect(html.indexOf('data-site="gemini"')).toBeLessThan(html.indexOf('data-site="chatgpt"'));
    for (const s of ['chatgpt', 'claude', 'grok']) expect(html).toContain(`providers/${s}.svg`);
    expect(html).toContain('aria-label="Gemini에서 하던 대화를');
    expect(html).toContain('hv-dark');
  });
});
