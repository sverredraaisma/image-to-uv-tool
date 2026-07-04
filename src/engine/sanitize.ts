import type { GraphEdge, GraphNode, NodeConfig } from '../types';

/**
 * Defensively normalise an untrusted graph (loaded from a file or old
 * localStorage). Nodes missing an id/type are dropped; a missing/invalid
 * position or config is defaulted; edges referencing a dropped node or missing
 * handles are removed. Valid graphs pass through unchanged, so it round-trips
 * exportGraph() output.
 */
export function sanitizeGraph(raw: unknown): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const obj = (raw ?? {}) as { nodes?: unknown; edges?: unknown };

  const nodes: GraphNode[] = [];
  for (const item of Array.isArray(obj.nodes) ? obj.nodes : []) {
    const n = item as { id?: unknown; type?: unknown; position?: { x?: unknown; y?: unknown }; config?: unknown };
    if (typeof n.id !== 'string' || typeof n.type !== 'string') continue;
    const px = n.position?.x;
    const py = n.position?.y;
    nodes.push({
      id: n.id,
      type: n.type,
      position: typeof px === 'number' && typeof py === 'number' ? { x: px, y: py } : { x: 0, y: 0 },
      config: n.config && typeof n.config === 'object' ? (n.config as NodeConfig) : {},
    });
  }

  const ids = new Set(nodes.map((n) => n.id));
  const edges: GraphEdge[] = [];
  for (const item of Array.isArray(obj.edges) ? obj.edges : []) {
    const e = item as {
      id?: unknown;
      source?: unknown;
      sourceHandle?: unknown;
      target?: unknown;
      targetHandle?: unknown;
    };
    if (typeof e.id !== 'string') continue;
    if (typeof e.source !== 'string' || typeof e.target !== 'string') continue;
    if (typeof e.sourceHandle !== 'string' || typeof e.targetHandle !== 'string') continue;
    if (!ids.has(e.source) || !ids.has(e.target)) continue;
    edges.push({
      id: e.id,
      source: e.source,
      sourceHandle: e.sourceHandle,
      target: e.target,
      targetHandle: e.targetHandle,
    });
  }

  return { nodes, edges };
}
