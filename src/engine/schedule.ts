// Pure scheduler helpers: resolving a node's inputs from the graph, and picking
// the next auto-run node that is ready. No store/registry dependency, so both
// are directly unit-testable.

import type { ComputeResult, DataValue, GraphEdge, NodeRuntime, PortSpec } from '../types';
import { upstreamNodeIds } from './graph';

const statusOf = (runtime: Record<string, NodeRuntime>, id: string) => runtime[id]?.status ?? 'outOfDate';

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
  nodes: { id: string; type: string; bypassed?: boolean }[],
  edges: GraphEdge[],
  runtime: Record<string, NodeRuntime>,
  isAuto: (node: { id: string; type: string; bypassed?: boolean }) => boolean,
): string | undefined {
  return findReadyAutoNodes(nodes, edges, runtime, isAuto)[0];
}

/**
 * All out-of-date auto-run nodes whose upstream are up to date. They are pairwise
 * independent (none is upstream of another, or it wouldn't be ready), so the
 * caller may run them concurrently.
 */
export function findReadyAutoNodes(
  nodes: { id: string; type: string; bypassed?: boolean }[],
  edges: GraphEdge[],
  runtime: Record<string, NodeRuntime>,
  isAuto: (node: { id: string; type: string; bypassed?: boolean }) => boolean,
): string[] {
  const ready: string[] = [];
  for (const n of nodes) {
    if (!isAuto(n)) continue;
    if (statusOf(runtime, n.id) !== 'outOfDate') continue;
    if (upstreamNodeIds(n.id, edges).every((u) => statusOf(runtime, u) === 'upToDate')) ready.push(n.id);
  }
  return ready;
}

const kindForPort = (t: PortSpec['type']): DataValue['kind'] =>
  t === 'text' ? 'text' : t === 'stl' ? 'stl' : 'image';

/**
 * Outputs for a muted (bypassed) node: forward the first type-compatible input
 * value to each output port, so the node behaves as a wire without being
 * unwired. Outputs with no compatible input are left empty.
 */
export function bypassOutputs(
  inputPorts: PortSpec[],
  outputPorts: PortSpec[],
  inputs: Record<string, DataValue | DataValue[] | undefined>,
): ComputeResult {
  const result: ComputeResult = {};
  for (const o of outputPorts) {
    const want = kindForPort(o.type);
    for (const p of inputPorts) {
      const raw = inputs[p.id];
      const val = Array.isArray(raw) ? raw[0] : raw;
      if (val && val.kind === want) {
        result[o.id] = val;
        break;
      }
    }
  }
  return result;
}
