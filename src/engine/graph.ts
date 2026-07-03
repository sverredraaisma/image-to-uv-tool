// Pure graph algorithms over (nodes, edges). No React / no store dependency so
// these are trivially unit-testable.

import type { GraphEdge } from '../types';

/** Immediate upstream (source) node ids feeding into `nodeId`. */
export function upstreamNodeIds(nodeId: string, edges: GraphEdge[]): string[] {
  const set = new Set<string>();
  for (const e of edges) if (e.target === nodeId) set.add(e.source);
  return [...set];
}

/** Immediate downstream (target) node ids fed by `nodeId`. */
export function downstreamNodeIds(nodeId: string, edges: GraphEdge[]): string[] {
  const set = new Set<string>();
  for (const e of edges) if (e.source === nodeId) set.add(e.target);
  return [...set];
}

function collect(
  start: string,
  edges: GraphEdge[],
  next: (id: string, edges: GraphEdge[]) => string[],
): Set<string> {
  const seen = new Set<string>();
  const stack = [...next(start, edges)];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const n of next(id, edges)) if (!seen.has(n)) stack.push(n);
  }
  return seen;
}

/** All transitive descendants of `nodeId` (excludes itself). */
export function descendants(nodeId: string, edges: GraphEdge[]): Set<string> {
  return collect(nodeId, edges, downstreamNodeIds);
}

/** All transitive ancestors of `nodeId` (excludes itself). */
export function ancestors(nodeId: string, edges: GraphEdge[]): Set<string> {
  return collect(nodeId, edges, upstreamNodeIds);
}

/** Is there a directed path from `from` to `to`? */
export function hasPath(from: string, to: string, edges: GraphEdge[]): boolean {
  if (from === to) return true;
  return descendants(from, edges).has(to);
}

/**
 * Would adding an edge source -> target introduce a cycle? A cycle appears if
 * `target` can already reach `source` (or it's a self-loop).
 */
export function wouldCreateCycle(
  source: string,
  target: string,
  edges: GraphEdge[],
): boolean {
  if (source === target) return true;
  return hasPath(target, source, edges);
}

/**
 * Topological order (Kahn's algorithm) of the given node ids, using only edges
 * whose endpoints are both in the set. Throws if a cycle is present.
 */
export function topoSort(nodeIds: Iterable<string>, edges: GraphEdge[]): string[] {
  const nodes = new Set(nodeIds);
  const indegree = new Map<string, number>();
  const out = new Map<string, string[]>();
  for (const id of nodes) {
    indegree.set(id, 0);
    out.set(id, []);
  }
  for (const e of edges) {
    if (!nodes.has(e.source) || !nodes.has(e.target)) continue;
    if (e.source === e.target) continue;
    out.get(e.source)!.push(e.target);
    indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1);
  }
  const queue: string[] = [];
  for (const [id, deg] of indegree) if (deg === 0) queue.push(id);
  queue.sort(); // deterministic ordering
  const result: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    result.push(id);
    const nexts = [...out.get(id)!].sort();
    for (const n of nexts) {
      const d = (indegree.get(n) ?? 0) - 1;
      indegree.set(n, d);
      if (d === 0) queue.push(n);
    }
  }
  if (result.length !== nodes.size) {
    throw new Error('Cycle detected in graph');
  }
  return result;
}
