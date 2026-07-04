// Clone a fragment of the graph (a set of nodes plus the edges among them) with
// fresh ids and offset positions. Pure — `genId` is injected — so group
// duplicate / copy-paste can be unit-tested without the store.

import type { GraphEdge, GraphNode } from '../types';

export function cloneFragment(
  nodes: GraphNode[],
  edges: GraphEdge[],
  ids: Set<string>,
  genId: (prefix: string) => string,
  offset: { x: number; y: number } = { x: 40, y: 40 },
): { nodes: GraphNode[]; edges: GraphEdge[]; idMap: Map<string, string> } {
  const idMap = new Map<string, string>();
  const newNodes: GraphNode[] = [];
  for (const n of nodes) {
    if (!ids.has(n.id)) continue;
    const nid = genId('n');
    idMap.set(n.id, nid);
    newNodes.push({
      ...n,
      id: nid,
      position: { x: n.position.x + offset.x, y: n.position.y + offset.y },
      config: structuredClone(n.config),
    });
  }
  // Only edges fully inside the fragment are carried; edges to the outside are
  // dropped (the pasted copy isn't wired to the originals' neighbours).
  const newEdges: GraphEdge[] = [];
  for (const e of edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) continue;
    newEdges.push({
      id: genId('e'),
      source: idMap.get(e.source)!,
      sourceHandle: e.sourceHandle,
      target: idMap.get(e.target)!,
      targetHandle: e.targetHandle,
    });
  }
  return { nodes: newNodes, edges: newEdges, idMap };
}
