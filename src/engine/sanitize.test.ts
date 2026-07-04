import { describe, it, expect } from 'vitest';
import { sanitizeGraph } from './sanitize';

describe('sanitizeGraph', () => {
  it('passes a valid graph through unchanged', () => {
    const graph = {
      nodes: [{ id: 'a', type: 'invert', position: { x: 10, y: 20 }, config: { k: 1 } }],
      edges: [{ id: 'e1', source: 'a', sourceHandle: 'out', target: 'a', targetHandle: 'in' }],
    };
    expect(sanitizeGraph(graph)).toEqual(graph);
  });

  it('drops nodes missing an id or type', () => {
    const { nodes } = sanitizeGraph({
      nodes: [
        { type: 'invert', position: { x: 0, y: 0 } }, // no id
        { id: 'b', position: { x: 0, y: 0 } }, // no type
        { id: 'c', type: 'invert', position: { x: 1, y: 2 }, config: {} },
      ],
      edges: [],
    });
    expect(nodes.map((n) => n.id)).toEqual(['c']);
  });

  it('defaults a missing/invalid position and config', () => {
    const { nodes } = sanitizeGraph({
      nodes: [{ id: 'a', type: 'invert' }],
      edges: [],
    });
    expect(nodes[0].position).toEqual({ x: 0, y: 0 });
    expect(nodes[0].config).toEqual({});
  });

  it('drops edges referencing a missing node or missing handles', () => {
    const { edges } = sanitizeGraph({
      nodes: [{ id: 'a', type: 'invert', position: { x: 0, y: 0 }, config: {} }],
      edges: [
        { id: 'e1', source: 'a', sourceHandle: 'out', target: 'ghost', targetHandle: 'in' }, // missing node
        { id: 'e2', source: 'a', target: 'a', targetHandle: 'in' }, // no sourceHandle
        { id: 'e3', source: 'a', sourceHandle: 'out', target: 'a', targetHandle: 'in' }, // ok
      ],
    });
    expect(edges.map((e) => e.id)).toEqual(['e3']);
  });

  it('tolerates junk input', () => {
    expect(sanitizeGraph(null)).toEqual({ nodes: [], edges: [] });
    expect(sanitizeGraph({ nodes: 'nope', edges: 42 })).toEqual({ nodes: [], edges: [] });
  });
});
