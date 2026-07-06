import { describe, it, expect } from 'vitest';
import { buildNodeMenu, type MenuNode } from './nodeMenu';

const nodes: MenuNode[] = [
  { type: 'zeta', label: 'Zeta', category: 'Adjust' },
  { type: 'alpha', label: 'Alpha', category: 'Adjust' },
  { type: 'imageInput', label: 'Image Input', category: 'Input' },
  {
    type: 'flux',
    label: 'Flux',
    category: 'AI (Replicate)',
    group: 'Generate',
    description: 'text to image',
  },
  { type: 'sam', label: 'SAM 2', category: 'AI (Replicate)', group: 'Segment' },
  { type: 'blip', label: 'BLIP', category: 'AI (Replicate)', group: 'Describe' },
  { type: 'test.thing', label: 'Test', category: 'test' },
];

// The generative-AI subset (Flux) carries the genAI flag; utilities don't.
const nodesWithGenAI: MenuNode[] = nodes.map((n) =>
  n.type === 'flux' ? { ...n, genAI: true } : n,
);

describe('buildNodeMenu', () => {
  it('orders categories by priority and excludes test nodes', () => {
    const menu = buildNodeMenu(nodes);
    expect(menu.map((c) => c.category)).toEqual(['Input', 'Adjust', 'AI (Replicate)']);
  });

  it('sorts items alphabetically within a group', () => {
    const menu = buildNodeMenu(nodes);
    const adjust = menu.find((c) => c.category === 'Adjust')!;
    expect(adjust.groups[0].items.map((i) => i.label)).toEqual(['Alpha', 'Zeta']);
  });

  it('orders capability groups deliberately (Generate before Segment before Describe)', () => {
    const menu = buildNodeMenu(nodes);
    const ai = menu.find((c) => c.category === 'AI (Replicate)')!;
    expect(ai.groups.map((g) => g.group)).toEqual(['Generate', 'Segment', 'Describe']);
  });

  it('filters by label, description, category and group', () => {
    expect(buildNodeMenu(nodes, 'zeta')).toHaveLength(1);
    // matches Flux by its description text
    const byDesc = buildNodeMenu(nodes, 'text to image');
    expect(byDesc[0].groups[0].items[0].label).toBe('Flux');
    // group name match
    expect(buildNodeMenu(nodes, 'segment')[0].groups[0].items[0].label).toBe('SAM 2');
    expect(buildNodeMenu(nodes, 'nomatch')).toHaveLength(0);
  });

  it('hides generative-AI nodes when showGenAI is false, keeps AI utilities', () => {
    const menu = buildNodeMenu(nodesWithGenAI, '', false);
    const ai = menu.find((c) => c.category === 'AI (Replicate)');
    const labels = ai?.groups.flatMap((g) => g.items.map((i) => i.label)) ?? [];
    expect(labels).not.toContain('Flux'); // generative — hidden
    expect(labels).toEqual(expect.arrayContaining(['SAM 2', 'BLIP'])); // utilities — kept
    // Non-AI nodes are unaffected.
    expect(menu.some((c) => c.category === 'Adjust')).toBe(true);
  });

  it('shows generative-AI nodes when showGenAI is true (default)', () => {
    const labels = buildNodeMenu(nodesWithGenAI, '', true)
      .flatMap((c) => c.groups)
      .flatMap((g) => g.items.map((i) => i.label));
    expect(labels).toContain('Flux');
  });
});
