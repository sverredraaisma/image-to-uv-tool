// Runtime reconciliation for wholesale graph swaps (undo / redo / load).
//
// When the graph is replaced in one shot we must NOT blindly wipe every
// computed result: an AI node's output can be expensive (paid) and slow to
// regenerate. A cached output stays valid as long as the node still exists with
// the same config, the same incoming edges, and none of its ancestors changed.
// Everything else is marked out of date so the scheduler recomputes it.

import type { GraphEdge, GraphNode, NodeRuntime } from '../types';
import { descendants } from './graph';

export interface GraphSnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Order-independent signature of a node's incoming connections. */
function incomingSignature(edges: GraphEdge[], nodeId: string): string {
  return edges
    .filter((e) => e.target === nodeId)
    .map((e) => `${e.source}|${e.sourceHandle}|${e.targetHandle}`)
    .sort()
    .join(',');
}

/**
 * Compute the runtime map for `target` given the runtime we already have for
 * `current`. A node keeps its up-to-date output only if it is unchanged (same
 * config, same incoming edges) and no ancestor changed; otherwise it is reset
 * to `outOfDate` with empty outputs.
 */
export function reconcileRuntime(
  prevRuntime: Record<string, NodeRuntime>,
  current: GraphSnapshot,
  target: GraphSnapshot,
): Record<string, NodeRuntime> {
  const currentById = new Map(current.nodes.map((n) => [n.id, n]));

  const changed = new Set<string>();
  for (const t of target.nodes) {
    const c = currentById.get(t.id);
    if (
      !c ||
      Boolean(c.bypassed) !== Boolean(t.bypassed) ||
      JSON.stringify(c.config) !== JSON.stringify(t.config) ||
      incomingSignature(current.edges, t.id) !== incomingSignature(target.edges, t.id)
    ) {
      changed.add(t.id);
    }
  }
  // A changed node invalidates everything downstream of it in the target graph.
  for (const id of [...changed]) for (const d of descendants(id, target.edges)) changed.add(d);

  const runtime: Record<string, NodeRuntime> = {};
  for (const t of target.nodes) {
    const prev = prevRuntime[t.id];
    if (!changed.has(t.id) && prev && prev.status === 'upToDate') {
      runtime[t.id] = prev; // still valid — preserve the (possibly paid) result
    } else {
      runtime[t.id] = { status: 'outOfDate', outputs: {} };
    }
  }
  return runtime;
}
