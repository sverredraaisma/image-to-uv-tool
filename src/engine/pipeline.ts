// Run a pipeline's subgraph: seed the Pipeline Input markers with externally
// supplied values, evaluate every inner node in topological order, and collect
// the values wired into the Pipeline Output markers. Reuses the same input
// resolution and bypass semantics as the live scheduler so a subgraph behaves
// exactly like it does on the canvas.

import type { ComputeContext, ComputeResult, DataValue, GraphEdge, GraphNode, NodeRuntime } from '../types';
import { topoSort } from './graph';
import { getNodeDefSafe } from './registry';
import { nodePorts } from './ports';
import { gatherInputs, bypassOutputs } from './schedule';
import { computeMaybeMapped } from './sequenceMap';

export interface Subgraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Coerce a possibly-`multiple` resolved input down to a single value. */
const single = (v: DataValue | DataValue[] | undefined): DataValue | undefined =>
  Array.isArray(v) ? v[0] : v;

/**
 * Evaluate a subgraph. `inputs` is keyed by Pipeline Input node id (which is
 * the pipeline node's input port id); the result is keyed by Pipeline Output
 * node id (the pipeline node's output port id). Throws on a cycle or if an
 * inner node's compute throws.
 */
export async function evaluateSubgraph(
  graph: Subgraph,
  inputs: Record<string, DataValue | DataValue[] | undefined>,
  ctx: ComputeContext,
): Promise<Record<string, DataValue | undefined>> {
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const runtime: Record<string, NodeRuntime> = {};

  // Seed the input markers with the externally-provided values.
  for (const n of nodes) {
    if (n.type === 'pipelineInput') {
      runtime[n.id] = { status: 'upToDate', outputs: { out: single(inputs[n.id]) } };
    }
  }

  const order = topoSort(new Set(nodes.map((n) => n.id)), edges); // throws on cycle
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const outputs: Record<string, DataValue | undefined> = {};

  for (const id of order) {
    const node = byId.get(id);
    if (!node || node.type === 'pipelineInput') continue; // markers already seeded
    const def = getNodeDefSafe(node.type);
    if (!def) continue; // unknown type — skip, don't crash the whole run
    const ports = nodePorts(node, def);
    const nodeInputs = gatherInputs(ports.inputs, edges, runtime, id);

    if (node.type === 'pipelineOutput') {
      outputs[id] = single(nodeInputs.in); // capture whatever is wired in
      continue;
    }

    const result: ComputeResult = node.bypassed
      ? bypassOutputs(ports.inputs, ports.outputs, nodeInputs)
      : // Frame by frame when a Sequence reaches an image input, exactly as the
        // same node would behave out in the main graph.
        await computeMaybeMapped(def, ports, { ...ctx, inputs: nodeInputs, config: node.config });
    runtime[id] = { status: 'upToDate', outputs: result };
  }
  return outputs;
}
