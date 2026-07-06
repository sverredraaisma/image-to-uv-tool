import { describe, it, expect } from 'vitest';
import { autoLayout } from './autoLayout';

const n = (...ids: string[]) => ids.map((id) => ({ id }));
const e = (source: string, target: string) => ({ source, target });

describe('autoLayout', () => {
  it('places a node to the right of its inputs (layer = longest path)', () => {
    const pos = autoLayout(n('a', 'b', 'c'), [e('a', 'b'), e('b', 'c')]);
    expect(pos.a.x).toBeLessThan(pos.b.x);
    expect(pos.b.x).toBeLessThan(pos.c.x);
  });

  it('uses the longest path when a node has inputs at different depths', () => {
    // a→b→d and a→d: d must sit past b, not next to it.
    const pos = autoLayout(n('a', 'b', 'd'), [e('a', 'b'), e('b', 'd'), e('a', 'd')]);
    expect(pos.d.x).toBeGreaterThan(pos.b.x);
  });

  it('stacks independent sources in the same first column', () => {
    const pos = autoLayout(n('a', 'b'), []);
    expect(pos.a.x).toBe(pos.b.x); // same layer
    expect(pos.a.y).not.toBe(pos.b.y); // different rows
  });

  it('separates siblings within a layer vertically', () => {
    const pos = autoLayout(n('root', 'x', 'y'), [e('root', 'x'), e('root', 'y')]);
    expect(pos.x.x).toBe(pos.y.x);
    expect(pos.x.y).not.toBe(pos.y.y);
  });

  it('is deterministic for the same input', () => {
    const nodes = n('a', 'b', 'c', 'd');
    const edges = [e('a', 'b'), e('a', 'c'), e('b', 'd'), e('c', 'd')];
    expect(autoLayout(nodes, edges)).toEqual(autoLayout(nodes, edges));
  });

  it('never throws on a cycle (defensive) and positions every node', () => {
    const pos = autoLayout(n('a', 'b'), [e('a', 'b'), e('b', 'a')]);
    expect(pos.a).toBeDefined();
    expect(pos.b).toBeDefined();
  });

  it('ignores edges that reference unknown nodes', () => {
    const pos = autoLayout(n('a'), [e('a', 'ghost'), e('ghost', 'a')]);
    expect(Object.keys(pos)).toEqual(['a']);
  });

  it('honours origin and spacing options', () => {
    const pos = autoLayout(n('a', 'b'), [e('a', 'b')], {
      originX: 10,
      originY: 20,
      colSpacing: 100,
      rowSpacing: 50,
    });
    expect(pos.a.x).toBe(10);
    expect(pos.b.x).toBe(110);
  });
});
