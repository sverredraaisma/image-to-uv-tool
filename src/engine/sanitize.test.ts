import { describe, it, expect } from 'vitest';
import { sanitizeGraph, type SanitizeOptions } from './sanitize';
import type { PortSpec } from '../types';

// A tiny port registry for the semantic-validation tests.
const PORTS: Record<string, { inputs: PortSpec[]; outputs: PortSpec[] }> = {
  gen: { inputs: [], outputs: [{ id: 'out', label: 'o', type: 'image' }] },
  edit: {
    inputs: [{ id: 'in', label: 'i', type: 'image' }],
    outputs: [{ id: 'out', label: 'o', type: 'image' }],
  },
  textNode: {
    inputs: [{ id: 'in', label: 'i', type: 'text' }],
    outputs: [{ id: 'out', label: 'o', type: 'text' }],
  },
  merge: {
    inputs: [{ id: 'in', label: 'i', type: 'image', multiple: true }],
    outputs: [{ id: 'out', label: 'o', type: 'image' }],
  },
};
const opts: SanitizeOptions = {
  getPorts: (node) => PORTS[node.type] ?? null,
  isCompatible: (a, b) => a === b,
};

describe('sanitizeGraph', () => {
  it('passes a valid graph through unchanged', () => {
    const graph = {
      nodes: [
        { id: 'a', type: 'gen', position: { x: 10, y: 20 }, config: { k: 1 } },
        { id: 'b', type: 'edit', position: { x: 30, y: 40 }, config: {} },
      ],
      edges: [{ id: 'e1', source: 'a', sourceHandle: 'out', target: 'b', targetHandle: 'in' }],
    };
    expect(sanitizeGraph(graph, opts)).toEqual(graph);
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

  it('collapses duplicate node ids to the first', () => {
    const { nodes } = sanitizeGraph({
      nodes: [
        { id: 'a', type: 'gen', position: { x: 1, y: 1 }, config: { v: 1 } },
        { id: 'a', type: 'edit', position: { x: 2, y: 2 }, config: { v: 2 } },
      ],
      edges: [],
    });
    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe('gen');
  });

  it('defaults a missing/invalid position and config', () => {
    const { nodes } = sanitizeGraph({
      nodes: [{ id: 'a', type: 'invert' }],
      edges: [],
    });
    expect(nodes[0].position).toEqual({ x: 0, y: 0 });
    expect(nodes[0].config).toEqual({});
  });

  it('defaults NaN/Infinity positions', () => {
    const { nodes } = sanitizeGraph({
      nodes: [{ id: 'a', type: 'invert', position: { x: NaN, y: Infinity }, config: {} }],
      edges: [],
    });
    expect(nodes[0].position).toEqual({ x: 0, y: 0 });
  });

  it('drops edges referencing a missing node or missing handles', () => {
    const { edges } = sanitizeGraph({
      nodes: [
        { id: 'a', type: 'gen', position: { x: 0, y: 0 }, config: {} },
        { id: 'b', type: 'edit', position: { x: 0, y: 0 }, config: {} },
      ],
      edges: [
        { id: 'e1', source: 'a', sourceHandle: 'out', target: 'ghost', targetHandle: 'in' }, // missing node
        { id: 'e2', source: 'a', target: 'b', targetHandle: 'in' }, // no sourceHandle
        { id: 'e3', source: 'a', sourceHandle: 'out', target: 'b', targetHandle: 'in' }, // ok
      ],
    });
    expect(edges.map((e) => e.id)).toEqual(['e3']);
  });

  it('rejects self-loops and cycles', () => {
    const { edges } = sanitizeGraph(
      {
        nodes: [
          { id: 'a', type: 'edit', position: { x: 0, y: 0 }, config: {} },
          { id: 'b', type: 'edit', position: { x: 0, y: 0 }, config: {} },
        ],
        edges: [
          { id: 'self', source: 'a', sourceHandle: 'out', target: 'a', targetHandle: 'in' }, // self-loop
          { id: 'e1', source: 'a', sourceHandle: 'out', target: 'b', targetHandle: 'in' }, // ok
          { id: 'e2', source: 'b', sourceHandle: 'out', target: 'a', targetHandle: 'in' }, // closes a cycle
        ],
      },
      opts,
    );
    expect(edges.map((e) => e.id)).toEqual(['e1']);
  });

  it('drops exact duplicate edges and duplicate edge ids', () => {
    const { edges } = sanitizeGraph(
      {
        nodes: [
          { id: 'a', type: 'gen', position: { x: 0, y: 0 }, config: {} },
          { id: 'b', type: 'merge', position: { x: 0, y: 0 }, config: {} },
        ],
        edges: [
          { id: 'e1', source: 'a', sourceHandle: 'out', target: 'b', targetHandle: 'in' },
          { id: 'e2', source: 'a', sourceHandle: 'out', target: 'b', targetHandle: 'in' }, // duplicate endpoints
          { id: 'e1', source: 'a', sourceHandle: 'out', target: 'b', targetHandle: 'in' }, // duplicate id
        ],
      },
      opts,
    );
    expect(edges.map((e) => e.id)).toEqual(['e1']);
  });

  it('rejects type-incompatible edges when node defs are known', () => {
    const { edges } = sanitizeGraph(
      {
        nodes: [
          { id: 'a', type: 'gen', position: { x: 0, y: 0 }, config: {} }, // image out
          { id: 'b', type: 'textNode', position: { x: 0, y: 0 }, config: {} }, // text in
        ],
        edges: [{ id: 'e1', source: 'a', sourceHandle: 'out', target: 'b', targetHandle: 'in' }],
      },
      opts,
    );
    expect(edges).toHaveLength(0);
  });

  it('rejects edges to nonexistent port handles', () => {
    const { edges } = sanitizeGraph(
      {
        nodes: [
          { id: 'a', type: 'gen', position: { x: 0, y: 0 }, config: {} },
          { id: 'b', type: 'edit', position: { x: 0, y: 0 }, config: {} },
        ],
        edges: [{ id: 'e1', source: 'a', sourceHandle: 'nope', target: 'b', targetHandle: 'in' }],
      },
      opts,
    );
    expect(edges).toHaveLength(0);
  });

  it('keeps only the first edge into a single-value input, but all into a multiple input', () => {
    const single = sanitizeGraph(
      {
        nodes: [
          { id: 'a', type: 'gen', position: { x: 0, y: 0 }, config: {} },
          { id: 'a2', type: 'gen', position: { x: 0, y: 0 }, config: {} },
          { id: 'b', type: 'edit', position: { x: 0, y: 0 }, config: {} }, // single 'in'
        ],
        edges: [
          { id: 'e1', source: 'a', sourceHandle: 'out', target: 'b', targetHandle: 'in' },
          { id: 'e2', source: 'a2', sourceHandle: 'out', target: 'b', targetHandle: 'in' },
        ],
      },
      opts,
    );
    expect(single.edges.map((e) => e.id)).toEqual(['e1']);

    const multi = sanitizeGraph(
      {
        nodes: [
          { id: 'a', type: 'gen', position: { x: 0, y: 0 }, config: {} },
          { id: 'a2', type: 'gen', position: { x: 0, y: 0 }, config: {} },
          { id: 'b', type: 'merge', position: { x: 0, y: 0 }, config: {} }, // multiple 'in'
        ],
        edges: [
          { id: 'e1', source: 'a', sourceHandle: 'out', target: 'b', targetHandle: 'in' },
          { id: 'e2', source: 'a2', sourceHandle: 'out', target: 'b', targetHandle: 'in' },
        ],
      },
      opts,
    );
    expect(multi.edges.map((e) => e.id)).toEqual(['e1', 'e2']);
  });

  it('keeps edges for unknown node types (structural checks only)', () => {
    const { edges } = sanitizeGraph(
      {
        nodes: [
          { id: 'a', type: 'unknownPlugin', position: { x: 0, y: 0 }, config: {} },
          { id: 'b', type: 'unknownPlugin', position: { x: 0, y: 0 }, config: {} },
        ],
        edges: [{ id: 'e1', source: 'a', sourceHandle: 'out', target: 'b', targetHandle: 'in' }],
      },
      opts,
    );
    expect(edges).toHaveLength(1);
  });

  it('tolerates junk input', () => {
    expect(sanitizeGraph(null)).toEqual({ nodes: [], edges: [] });
    expect(sanitizeGraph({ nodes: 'nope', edges: 42 })).toEqual({ nodes: [], edges: [] });
  });
});
