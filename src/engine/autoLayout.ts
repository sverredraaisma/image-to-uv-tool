// Pure auto-layout for the node graph: a layered (Sugiyama-style) arrangement
// that places every node to the right of its inputs and reduces edge crossings
// with a few barycenter sweeps. Kept free of React / the store so it is
// directly unit-testable.

export interface LayoutOptions {
  /** Horizontal gap between successive layers (columns). */
  colSpacing?: number;
  /** Vertical gap between nodes within a layer. */
  rowSpacing?: number;
  originX?: number;
  originY?: number;
}

interface IdNode {
  id: string;
}
interface IdEdge {
  source: string;
  target: string;
}

/** Cycle-safe topological order (Kahn); leftover nodes in a cycle are appended
 *  in stable input order so the layout never throws on an unexpected loop. */
function topoOrder(ids: string[], adj: Map<string, string[]>, indeg: Map<string, number>): string[] {
  const deg = new Map(indeg);
  const queue = ids.filter((id) => (deg.get(id) ?? 0) === 0);
  const out: string[] = [];
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    for (const t of adj.get(id) ?? []) {
      deg.set(t, (deg.get(t) ?? 0) - 1);
      if ((deg.get(t) ?? 0) === 0) queue.push(t);
    }
  }
  for (const id of ids) if (!seen.has(id)) out.push(id);
  return out;
}

/** Reorder one layer by the average position of each node's neighbours in the
 *  adjacent layer (barycenter heuristic). Nodes with no neighbours keep their
 *  current relative position; ties are broken stably. */
function sortByBarycenter(
  layer: string[],
  neighbors: Map<string, string[]>,
  neighborIndex: Map<string, number>,
): void {
  const cur = new Map(layer.map((id, i) => [id, i]));
  const bary = new Map<string, number>();
  for (const id of layer) {
    const idxs = (neighbors.get(id) ?? [])
      .map((n) => neighborIndex.get(n))
      .filter((v): v is number => v !== undefined);
    bary.set(id, idxs.length ? idxs.reduce((a, b) => a + b, 0) / idxs.length : cur.get(id)!);
  }
  layer.sort((a, b) => bary.get(a)! - bary.get(b)! || cur.get(a)! - cur.get(b)!);
}

/**
 * Compute a tidy position for every node from the graph's connections:
 * columns follow the longest path from a source, and rows are ordered to
 * minimise crossings. Isolated / source nodes sit in the first column. The
 * result maps node id → {x, y}; ids absent from `nodes` are ignored.
 */
export function autoLayout(
  nodes: IdNode[],
  edges: IdEdge[],
  opts: LayoutOptions = {},
): Record<string, { x: number; y: number }> {
  const colSpacing = opts.colSpacing ?? 360;
  const rowSpacing = opts.rowSpacing ?? 200;
  const originX = opts.originX ?? 0;
  const originY = opts.originY ?? 0;

  const ids = nodes.map((n) => n.id);
  const idSet = new Set(ids);

  const preds = new Map<string, string[]>();
  const succs = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const id of ids) {
    preds.set(id, []);
    succs.set(id, []);
    indeg.set(id, 0);
  }
  for (const e of edges) {
    if (e.source === e.target || !idSet.has(e.source) || !idSet.has(e.target)) continue;
    succs.get(e.source)!.push(e.target);
    preds.get(e.target)!.push(e.source);
    indeg.set(e.target, indeg.get(e.target)! + 1);
  }

  // Layer = longest path from a source, via a topological pass.
  const order = topoOrder(ids, succs, indeg);
  const layer = new Map<string, number>();
  for (const id of order) {
    const ps = preds.get(id)!;
    layer.set(id, ps.length ? Math.max(...ps.map((p) => layer.get(p) ?? 0)) + 1 : 0);
  }
  for (const id of ids) if (!layer.has(id)) layer.set(id, 0);

  const maxLayer = ids.reduce((m, id) => Math.max(m, layer.get(id)!), 0);
  const layers: string[][] = Array.from({ length: maxLayer + 1 }, () => []);
  for (const id of ids) layers[layer.get(id)!].push(id); // stable: keeps input order

  // A few down/up sweeps settle the row ordering to reduce crossings.
  const indexIn = (l: string[]) => new Map(l.map((id, i) => [id, i]));
  for (let sweep = 0; sweep < 4; sweep++) {
    for (let L = 1; L <= maxLayer; L++) sortByBarycenter(layers[L], preds, indexIn(layers[L - 1]));
    for (let L = maxLayer - 1; L >= 0; L--) sortByBarycenter(layers[L], succs, indexIn(layers[L + 1]));
  }

  // Vertically centre every column around a shared midline for a balanced look.
  const maxRows = layers.reduce((m, l) => Math.max(m, l.length), 1);
  const positions: Record<string, { x: number; y: number }> = {};
  for (let L = 0; L <= maxLayer; L++) {
    const col = layers[L];
    const offset = ((maxRows - col.length) * rowSpacing) / 2;
    col.forEach((id, i) => {
      positions[id] = { x: originX + L * colSpacing, y: originY + offset + i * rowSpacing };
    });
  }
  return positions;
}
