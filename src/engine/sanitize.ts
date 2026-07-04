import type { GraphEdge, GraphNode, NodeConfig, PortSpec, PortType } from '../types';
import { wouldCreateCycle } from './graph';

export interface SanitizeOptions {
  /**
   * Resolve a node type's ports so edges can be validated the same way
   * `addConnection` validates them. Return null for an unknown type (its edges
   * are then only checked structurally, so unknown/plugin nodes stay loadable).
   */
  getPorts?: (type: string) => { inputs: PortSpec[]; outputs: PortSpec[] } | null;
  /** Port-type compatibility (defaults to exact-match when omitted). */
  isCompatible?: (from: PortType, to: PortType) => boolean;
}

/**
 * Defensively normalise an untrusted graph (loaded from a file or old
 * localStorage). Nodes missing an id/type are dropped, duplicate ids collapse to
 * the first, and a missing/invalid position or config is defaulted.
 *
 * Edges are held to the same invariants `addConnection` enforces so a file
 * import can't smuggle in a graph the live editor would never allow: dangling
 * endpoints, duplicate ids/edges, self-loops, cycles, and — when node
 * definitions are supplied via `options.getPorts` — nonexistent port handles,
 * type-incompatible connections, and multiple edges into a single-value input.
 * A valid graph passes through unchanged, so it round-trips exportGraph().
 */
export function sanitizeGraph(
  raw: unknown,
  options: SanitizeOptions = {},
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const { getPorts } = options;
  const compat = options.isCompatible ?? ((a: PortType, b: PortType) => a === b);
  const obj = (raw ?? {}) as { nodes?: unknown; edges?: unknown };

  const nodes: GraphNode[] = [];
  const seenNodeIds = new Set<string>();
  for (const item of Array.isArray(obj.nodes) ? obj.nodes : []) {
    const n = item as {
      id?: unknown;
      type?: unknown;
      position?: { x?: unknown; y?: unknown };
      config?: unknown;
    };
    if (typeof n.id !== 'string' || typeof n.type !== 'string') continue;
    if (seenNodeIds.has(n.id)) continue; // collapse duplicate ids
    seenNodeIds.add(n.id);
    const px = n.position?.x;
    const py = n.position?.y;
    const finitePos = Number.isFinite(px) && Number.isFinite(py);
    nodes.push({
      id: n.id,
      type: n.type,
      position: finitePos ? { x: px as number, y: py as number } : { x: 0, y: 0 },
      config: n.config && typeof n.config === 'object' ? (n.config as NodeConfig) : {},
    });
  }

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const edges: GraphEdge[] = [];
  const seenEdgeIds = new Set<string>();
  const seenEndpoints = new Set<string>();
  const singleInputTaken = new Set<string>();

  for (const item of Array.isArray(obj.edges) ? obj.edges : []) {
    const e = item as {
      id?: unknown;
      source?: unknown;
      sourceHandle?: unknown;
      target?: unknown;
      targetHandle?: unknown;
    };
    if (typeof e.id !== 'string' || seenEdgeIds.has(e.id)) continue;
    if (typeof e.source !== 'string' || typeof e.target !== 'string') continue;
    if (typeof e.sourceHandle !== 'string' || typeof e.targetHandle !== 'string') continue;

    const srcNode = nodeById.get(e.source);
    const tgtNode = nodeById.get(e.target);
    if (!srcNode || !tgtNode) continue; // dangling endpoint

    const endpointKey = `${e.source}|${e.sourceHandle}|${e.target}|${e.targetHandle}`;
    if (seenEndpoints.has(endpointKey)) continue; // exact duplicate edge

    // Self-loops and back-edges: reject anything that closes a cycle against the
    // edges accepted so far.
    if (wouldCreateCycle(e.source, e.target, edges)) continue;

    // Semantic validation when the node types are known.
    const outPorts = getPorts?.(srcNode.type);
    const inPorts = getPorts?.(tgtNode.type);
    if (outPorts) {
      const outPort = outPorts.outputs.find((p) => p.id === e.sourceHandle);
      if (!outPort) continue; // nonexistent output handle
      if (inPorts) {
        const inPort = inPorts.inputs.find((p) => p.id === e.targetHandle);
        if (!inPort) continue; // nonexistent input handle
        if (!compat(outPort.type, inPort.type)) continue; // type-incompatible
        if (!inPort.multiple) {
          const singleKey = `${e.target}|${e.targetHandle}`;
          if (singleInputTaken.has(singleKey)) continue; // second edge into a single input
          singleInputTaken.add(singleKey);
        }
      }
    }

    seenEdgeIds.add(e.id);
    seenEndpoints.add(endpointKey);
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
