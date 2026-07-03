// Pure scheduler helpers: resolving a node's inputs from the graph, and picking
// the next auto-run node that is ready. No store/registry dependency, so both
// are directly unit-testable.

import type { DataValue, GraphEdge, NodeRuntime, PortSpec } from '../types';
import { upstreamNodeIds } from './graph';

const statusOf = (runtime: Record<string, NodeRuntime>, id: string) =>
  runtime[id]?.status ?? 'outOfDate';

/**
 * Resolve a node's input values from the current edges + upstream outputs.
 * `multiple` ports collect an array (undefined values filtered out); single
 * ports take the first available value.
 */
export function gatherInputs(
  inputPorts: PortSpec[],
  edges: GraphEdge[],
  runtime: Record<string, NodeRuntime>,
  nodeId: string,
): Record<string, DataValue | DataValue[] | undefined> {
  const result: Record<string, DataValue | DataValue[] | undefined> = {};
  for (const port of inputPorts) {
    const incoming = edges.filter((e) => e.target === nodeId && e.targetHandle === port.id);
    const values = incoming
      .map((e) => runtime[e.source]?.outputs?.[e.sourceHandle])
      .filter((v): v is DataValue => v !== undefined);
    result[port.id] = port.multiple ? values : values[0];
  }
  return result;
}

/**
 * The next out-of-date auto-run node whose upstream nodes are all up to date,
 * or undefined if none is ready. Drives the auto-run sweep to a fixpoint.
 */
export function findReadyAutoNode(
  nodes: { id: string; type: string }[],
  edges: GraphEdge[],
  runtime: Record<string, NodeRuntime>,
  isAutoRun: (type: string) => boolean,
): string | undefined {
  for (const n of nodes) {
    if (!isAutoRun(n.type)) continue;
    if (statusOf(runtime, n.id) !== 'outOfDate') continue;
    const ready = upstreamNodeIds(n.id, edges).every((u) => statusOf(runtime, u) === 'upToDate');
    if (ready) return n.id;
  }
  return undefined;
}
