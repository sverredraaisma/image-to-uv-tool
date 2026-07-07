// Pure auto-layout for the node graph: a layered (Sugiyama-style) arrangement
// that places every node to the right of its inputs and reduces edge crossings
// with a few barycenter sweeps. Kept free of React / the store so it is
// directly unit-testable.

export interface LayoutOptions {
  /** Horizontal gap between one column's right edge and the next column. */
  colGap?: number;
  /** Vertical gap between stacked nodes within a column. */
  rowGap?: number;
  originX?: number;
  originY?: number;
  /**
   * Measured node sizes (id → px). Columns are spaced by the widest node in each
   * column and rows by each node's own height, so large nodes no longer overlap.
   * Nodes without an entry fall back to `defaultWidth` / `defaultHeight`.
   */
  sizes?: Record<string, { width: number; height: number }>;
  defaultWidth?: number;
  defaultHeight?: number;
  /**
   * Column assignment. `asLateAsPossible` (default) pushes each node as far right
   * — as close to its consumers — as its dependencies allow, which spreads a
   * graph out and keeps side-inputs next to where they're used. `longestPath`
   * left-packs each node against its inputs.
   */
  align?: 'asLateAsPossible' | 'longestPath';
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
 * Compute a tidy position for every node from the graph's connections: nodes are
 * grouped into columns (by dependency depth) and rows (ordered to minimise
 * crossings). Column x and row y account for each node's actual size, so large
 * nodes don't overlap their neighbours. The result maps node id → {x, y}; ids
 * absent from `nodes` are ignored.
 */
export function autoLayout(
  nodes: IdNode[],
  edges: IdEdge[],
  opts: LayoutOptions = {},
): Record<string, { x: number; y: number }> {
  const colGap = opts.colGap ?? 140;
  const rowGap = opts.rowGap ?? 60;
  const originX = opts.originX ?? 0;
  const originY = opts.originY ?? 0;
  const defaultWidth = opts.defaultWidth ?? 240;
  const defaultHeight = opts.defaultHeight ?? 140;
  const sizes = opts.sizes ?? {};
  const align = opts.align ?? 'asLateAsPossible';
  const widthOf = (id: string) => sizes[id]?.width || defaultWidth;
  const heightOf = (id: string) => sizes[id]?.height || defaultHeight;

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

  const order = topoOrder(ids, succs, indeg);

  // As-soon-as-possible depth: longest path from a source. This also sets the
  // total column count (the critical-path length).
  const asap = new Map<string, number>();
  for (const id of order) {
    const ps = preds.get(id)!;
    asap.set(id, ps.length ? Math.max(...ps.map((p) => asap.get(p) ?? 0)) + 1 : 0);
  }
  for (const id of ids) if (!asap.has(id)) asap.set(id, 0);
  const maxLayer = ids.reduce((m, id) => Math.max(m, asap.get(id)!), 0);

  // Final column per node. As-late-as-possible = maxLayer − (longest path to a
  // sink): every edge still points strictly rightward, but each node slides as
  // far right as it can, next to whatever consumes it.
  const layer = new Map<string, number>();
  if (align === 'asLateAsPossible') {
    const toSink = new Map<string, number>();
    for (let i = order.length - 1; i >= 0; i--) {
      const id = order[i];
      const ss = succs.get(id)!;
      toSink.set(id, ss.length ? Math.max(...ss.map((s) => (toSink.get(s) ?? 0) + 1)) : 0);
    }
    for (const id of ids) layer.set(id, maxLayer - (toSink.get(id) ?? 0));
  } else {
    for (const id of ids) layer.set(id, asap.get(id)!);
  }

  const layers: string[][] = Array.from({ length: maxLayer + 1 }, () => []);
  for (const id of ids) layers[layer.get(id)!].push(id); // stable: keeps input order

  // A few down/up sweeps settle the row ordering to reduce crossings.
  const indexIn = (l: string[]) => new Map(l.map((id, i) => [id, i]));
  for (let sweep = 0; sweep < 4; sweep++) {
    for (let L = 1; L <= maxLayer; L++) sortByBarycenter(layers[L], preds, indexIn(layers[L - 1]));
    for (let L = maxLayer - 1; L >= 0; L--) sortByBarycenter(layers[L], succs, indexIn(layers[L + 1]));
  }

  // Column x = running sum of the widest node per column + the gap.
  const colX: number[] = [];
  let x = originX;
  for (let L = 0; L <= maxLayer; L++) {
    colX[L] = x;
    const colWidth = layers[L].reduce((m, id) => Math.max(m, widthOf(id)), 0) || defaultWidth;
    x += colWidth + colGap;
  }

  // Row y = stacked actual heights, each column centred on a shared midline.
  const colHeight = layers.map(
    (col) => col.reduce((s, id) => s + heightOf(id), 0) + rowGap * Math.max(0, col.length - 1),
  );
  const maxColHeight = colHeight.reduce((m, hh) => Math.max(m, hh), 0);

  const positions: Record<string, { x: number; y: number }> = {};
  for (let L = 0; L <= maxLayer; L++) {
    let y = originY + (maxColHeight - colHeight[L]) / 2;
    for (const id of layers[L]) {
      positions[id] = { x: colX[L], y };
      y += heightOf(id) + rowGap;
    }
  }
  return positions;
}
