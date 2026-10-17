import { describe, expect, it } from 'vitest';
import { conceptsOf, greedyCoverage, type CoverItem } from '../../src/handoff/coverage';
import { HANDOFF_VISUAL_CSS, handoffTargets, handoffVisualHtml } from '../../src/shared/handoff-visual';

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

  it('re-reads costs that drop once a shared part is chosen (excerpt + the sentence before it)', () => {
    // Item 1 is "antecedent + excerpt": 10 + 10 tokens until item 0 (the antecedent) is chosen.
    const chosenParts = new Set<number>();
    const parts: Record<number, number[]> = { 0: [0], 1: [0, 1], 2: [2] };
    const items = [item(0, 'queue retry job', 10, 2), item(1, 'queue retry job idempotency header key', 20), item(2, 'misc note', 10)];
    const cost = (it: CoverItem) => parts[it.id].filter((p) => !chosenParts.has(p)).length * 10;
    const onChoose = (it: CoverItem) => parts[it.id].forEach((p) => chosenParts.add(p));
    // With fixed costs the chain still costs 20 after its antecedent is in, and does not fit.
    expect(greedyCoverage(items, () => 1, 20)).toEqual([0, 2]);
    expect(greedyCoverage(items, () => 1, 20, new Set(), { cost, onChoose })).toEqual([0, 1]);
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

  it('draws the arrow from logo to logo at their vertical centre (v1.3.1)', () => {
    // The arc is drawn 1:1 in pixels inside a fixed 120px column between two 56px columns with 30px logos.
    expect(HANDOFF_VISUAL_CSS).toContain('grid-template-columns: 56px 120px 56px');
    expect(HANDOFF_VISUAL_CSS).toMatch(/\.hv-arc \{ width: 120px; height: 30px;/);
    expect(HANDOFF_VISUAL_CSS).toMatch(/\.hv-logo \{[^}]*width: 30px; height: 30px;/);
    expect(HANDOFF_VISUAL_CSS).toContain('align-items: start');
    const html = handoffVisualHtml('claude', (s) => s, 'ko');
    expect(html).toContain('viewBox="0 0 120 30"');
    const nums = (html.match(/class="track" d="([^"]+)"/)?.[1] ?? '').match(/-?\d+(\.\d+)?/g)!.map(Number);
    const [x0, y0, x1, y1] = [nums[0], nums[1], nums[nums.length - 2], nums[nums.length - 1]];
    expect([y0, y1]).toEqual([15, 15]); // logo centre, not the name labels below
    expect(x0).toBeGreaterThan(-13); // the source logo's right edge is at x = -13
    expect(x0).toBeLessThan(0);
    expect(x1).toBeGreaterThan(120);
    expect(x1).toBeLessThan(133); // the destination logo's left edge is at x = 133
  });
});
