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

  it('honours origin and gap options, spacing columns by node width', () => {
    const pos = autoLayout(n('a', 'b'), [e('a', 'b')], {
      originX: 10,
      originY: 20,
      colGap: 100,
      sizes: { a: { width: 200, height: 80 }, b: { width: 200, height: 80 } },
    });
    expect(pos.a.x).toBe(10); // originX
    expect(pos.b.x).toBe(10 + 200 + 100); // originX + a's width + colGap
  });

  it('spaces the next column by the widest node, so large nodes do not overlap', () => {
    const wide = autoLayout(n('a', 'b'), [e('a', 'b')], {
      originX: 0,
      colGap: 40,
      sizes: { a: { width: 500, height: 100 }, b: { width: 100, height: 100 } },
    });
    expect(wide.b.x).toBe(500 + 40); // b starts past a's full width + gap

    // A narrower a ⇒ b sits further left. Confirms width actually drives spacing.
    const narrow = autoLayout(n('a', 'b'), [e('a', 'b')], {
      originX: 0,
      colGap: 40,
      sizes: { a: { width: 150, height: 100 }, b: { width: 100, height: 100 } },
    });
    expect(narrow.b.x).toBeLessThan(wide.b.x);
  });

  it('stacks a column by real heights so tall nodes do not overlap', () => {
    const pos = autoLayout(n('r', 'p', 'q'), [e('r', 'p'), e('r', 'q')], {
      rowGap: 20,
      sizes: { p: { width: 100, height: 300 }, q: { width: 100, height: 120 } },
    });
    expect(pos.p.x).toBe(pos.q.x); // same column
    const upper = pos.p.y <= pos.q.y ? 'p' : 'q';
    const upperH = upper === 'p' ? 300 : 120;
    const lowerY = upper === 'p' ? pos.q.y : pos.p.y;
    // The lower node begins at or below the upper node's full height (+ gap).
    expect(lowerY).toBeGreaterThanOrEqual((upper === 'p' ? pos.p.y : pos.q.y) + upperH);
  });

  it('pushes a shallow side-input as far right as possible (as-late-as-possible)', () => {
    // Long chain a→x→y→c with a short side-input b→c. b should sit next to c
    // (one column before it), not bunched at the far left with a.
    const edges = [e('a', 'x'), e('x', 'y'), e('y', 'c'), e('b', 'c')];
    const pos = autoLayout(n('a', 'x', 'y', 'c', 'b'), edges);
    expect(pos.b.x).toBeGreaterThan(pos.a.x);
    expect(pos.b.x).toBe(pos.y.x); // the column just before c

    // longestPath left-packs it back next to the other source instead.
    const packed = autoLayout(n('a', 'x', 'y', 'c', 'b'), edges, { align: 'longestPath' });
    expect(packed.b.x).toBe(packed.a.x);
  });
});
