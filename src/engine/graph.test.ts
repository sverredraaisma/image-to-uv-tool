import { describe, it, expect } from 'vitest';
import type { GraphEdge } from '../types';
import {
  ancestors,
  descendants,
  downstreamNodeIds,
  hasPath,
  topoSort,
  upstreamNodeIds,
  wouldCreateCycle,
} from './graph';

const edge = (source: string, target: string): GraphEdge => ({
  id: `${source}->${target}`,
  source,
  sourceHandle: 'out',
  target,
  targetHandle: 'in',
});

// a -> b -> c ,  a -> d
const edges: GraphEdge[] = [edge('a', 'b'), edge('b', 'c'), edge('a', 'd')];

describe('graph traversal', () => {
  it('finds immediate up/downstream', () => {
    expect(upstreamNodeIds('c', edges)).toEqual(['b']);
    expect(downstreamNodeIds('a', edges).sort()).toEqual(['b', 'd']);
  });

  it('finds transitive descendants and ancestors', () => {
    expect([...descendants('a', edges)].sort()).toEqual(['b', 'c', 'd']);
    expect([...ancestors('c', edges)].sort()).toEqual(['a', 'b']);
  });

  it('detects reachability', () => {
    expect(hasPath('a', 'c', edges)).toBe(true);
    expect(hasPath('c', 'a', edges)).toBe(false);
    expect(hasPath('d', 'c', edges)).toBe(false);
  });
});

describe('cycle detection', () => {
  it('flags an edge that closes a loop', () => {
    expect(wouldCreateCycle('c', 'a', edges)).toBe(true); // c->a would loop a->b->c->a
    expect(wouldCreateCycle('a', 'a', edges)).toBe(true); // self loop
  });
  it('allows safe edges', () => {
    expect(wouldCreateCycle('d', 'c', edges)).toBe(false);
    expect(wouldCreateCycle('c', 'd', edges)).toBe(false);
  });
});

describe('topoSort', () => {
  it('orders dependencies before dependents', () => {
    const order = topoSort(['a', 'b', 'c', 'd'], edges);
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('c'));
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('d'));
  });
  it('throws on a cycle', () => {
    const cyclic = [...edges, edge('c', 'a')];
    expect(() => topoSort(['a', 'b', 'c'], cyclic)).toThrow(/cycle/i);
  });
  it('ignores edges outside the node set', () => {
    const order = topoSort(['b', 'c'], edges);
    expect(order).toEqual(['b', 'c']);
  });
});
