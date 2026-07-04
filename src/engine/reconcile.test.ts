import { describe, it, expect } from 'vitest';
import { reconcileRuntime, type GraphSnapshot } from './reconcile';
import type { NodeRuntime } from '../types';

const node = (id: string, config: Record<string, unknown> = {}) => ({
  id,
  type: 't',
  position: { x: 0, y: 0 },
  config,
});
const edge = (source: string, target: string) => ({
  id: `${source}-${target}`,
  source,
  sourceHandle: 'out',
  target,
  targetHandle: 'in',
});
const upToDate = (text: string): NodeRuntime => ({
  status: 'upToDate',
  outputs: { out: { kind: 'text', text } },
});

describe('reconcileRuntime', () => {
  it('keeps results for nodes unchanged between current and target', () => {
    const graph: GraphSnapshot = { nodes: [node('a'), node('b')], edges: [edge('a', 'b')] };
    const prev = { a: upToDate('A'), b: upToDate('B') };
    const out = reconcileRuntime(prev, graph, graph);
    expect(out.a).toBe(prev.a); // same reference — preserved
    expect(out.b).toBe(prev.b);
  });

  it('invalidates a node whose config changed and everything downstream of it', () => {
    const current: GraphSnapshot = { nodes: [node('a', { v: 1 }), node('b'), node('c')], edges: [edge('a', 'b'), edge('b', 'c')] };
    const target: GraphSnapshot = { nodes: [node('a', { v: 2 }), node('b'), node('c')], edges: [edge('a', 'b'), edge('b', 'c')] };
    const prev = { a: upToDate('A'), b: upToDate('B'), c: upToDate('C') };
    const out = reconcileRuntime(prev, current, target);
    expect(out.a.status).toBe('outOfDate');
    expect(out.b.status).toBe('outOfDate'); // downstream of a
    expect(out.c.status).toBe('outOfDate'); // downstream of b
  });

  it('invalidates only the affected branch, preserving an independent one', () => {
    const graph = (v: number): GraphSnapshot => ({
      nodes: [node('a1'), node('b1'), node('a2', { v }), node('b2')],
      edges: [edge('a1', 'b1'), edge('a2', 'b2')],
    });
    const prev = { a1: upToDate('A1'), b1: upToDate('B1'), a2: upToDate('A2'), b2: upToDate('B2') };
    const out = reconcileRuntime(prev, graph(1), graph(2));
    expect(out.a1).toBe(prev.a1); // untouched branch preserved
    expect(out.b1).toBe(prev.b1);
    expect(out.a2.status).toBe('outOfDate'); // changed
    expect(out.b2.status).toBe('outOfDate'); // downstream of change
  });

  it('invalidates a node whose incoming edges changed', () => {
    const current: GraphSnapshot = { nodes: [node('a'), node('b')], edges: [edge('a', 'b')] };
    const target: GraphSnapshot = { nodes: [node('a'), node('b')], edges: [] }; // edge removed
    const prev = { a: upToDate('A'), b: upToDate('B') };
    const out = reconcileRuntime(prev, current, target);
    expect(out.a).toBe(prev.a);
    expect(out.b.status).toBe('outOfDate');
  });

  it('drops runtime for nodes not present in the target graph', () => {
    const current: GraphSnapshot = { nodes: [node('a'), node('b')], edges: [] };
    const target: GraphSnapshot = { nodes: [node('a')], edges: [] };
    const prev = { a: upToDate('A'), b: upToDate('B') };
    const out = reconcileRuntime(prev, current, target);
    expect(Object.keys(out)).toEqual(['a']);
  });

  it('does not preserve a non-upToDate (e.g. running/error) status', () => {
    const graph: GraphSnapshot = { nodes: [node('a')], edges: [] };
    const prev = { a: { status: 'running', outputs: {} } as NodeRuntime };
    const out = reconcileRuntime(prev, graph, graph);
    expect(out.a.status).toBe('outOfDate');
  });
});
