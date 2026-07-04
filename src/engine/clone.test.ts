import { describe, it, expect } from 'vitest';
import { cloneFragment } from './clone';
import type { GraphEdge, GraphNode } from '../types';

const node = (id: string, x = 0, y = 0, config: Record<string, unknown> = {}): GraphNode => ({
  id,
  type: 't',
  position: { x, y },
  config,
});
const edge = (source: string, target: string): GraphEdge => ({
  id: `${source}-${target}`,
  source,
  sourceHandle: 'out',
  target,
  targetHandle: 'in',
});

describe('cloneFragment', () => {
  let counter = 0;
  const genId = (p: string) => `${p}_${counter++}`;

  it('remaps ids, offsets positions, and rewires internal edges', () => {
    counter = 0;
    const nodes = [node('a', 10, 10, { v: 1 }), node('b', 20, 20), node('c', 30, 30)];
    const edges = [edge('a', 'b'), edge('b', 'c')];
    const out = cloneFragment(nodes, edges, new Set(['a', 'b']), genId, { x: 5, y: 7 });

    expect(out.nodes).toHaveLength(2);
    expect(out.nodes.map((n) => n.id)).not.toContain('a'); // fresh ids
    expect(out.nodes[0].position).toEqual({ x: 15, y: 17 }); // offset applied
    // internal edge a->b is carried and remapped; b->c (c excluded) is dropped
    expect(out.edges).toHaveLength(1);
    expect(out.edges[0].source).toBe(out.idMap.get('a'));
    expect(out.edges[0].target).toBe(out.idMap.get('b'));
  });

  it('deep-clones config so edits do not leak back to the source', () => {
    counter = 0;
    const src = node('a', 0, 0, { nested: { k: 1 } });
    const out = cloneFragment([src], [], new Set(['a']), genId);
    (out.nodes[0].config.nested as { k: number }).k = 99;
    expect((src.config.nested as { k: number }).k).toBe(1);
  });

  it('preserves the bypassed flag', () => {
    counter = 0;
    const src: GraphNode = { ...node('a'), bypassed: true };
    const out = cloneFragment([src], [], new Set(['a']), genId);
    expect(out.nodes[0].bypassed).toBe(true);
  });
});
