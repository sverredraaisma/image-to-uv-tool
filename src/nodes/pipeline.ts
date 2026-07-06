// Pipeline node + its Input/Output markers. A pipeline embeds a subgraph in its
// config; its ports are derived (via engine/ports) from the marker nodes inside.
// Opening the node edits the subgraph on the canvas (see the store's
// enterPipeline / exitPipeline). Running it evaluates the subgraph.

import type { ConfigField, NodeDefinition } from '../types';
import { evaluateSubgraph, type Subgraph } from '../engine/pipeline';

const TYPE_OPTIONS: ConfigField = {
  kind: 'select',
  key: 'type',
  label: 'Type',
  options: [
    { value: 'image', label: 'Image' },
    { value: 'mask', label: 'Mask' },
    { value: 'text', label: 'Text' },
    { value: 'stl', label: 'STL' },
  ],
};

const NAME_FIELD: ConfigField = { kind: 'text', key: 'name', label: 'Port name' };

/** Marks an input of the enclosing pipeline; its output port (name + type from
 *  config) becomes an input port on the pipeline node. The value is injected by
 *  the evaluator / editor, so its own compute is only a harmless fallback. */
export const pipelineInputNode: NodeDefinition = {
  type: 'pipelineInput',
  label: 'Pipeline Input',
  category: 'Pipeline',
  description:
    'Marks an input of the enclosing pipeline — becomes an input port on the pipeline node. Only meaningful inside a pipeline.',
  autoRun: true,
  inputs: [],
  outputs: [], // derived by nodePorts()
  configFields: [NAME_FIELD, TYPE_OPTIONS],
  defaultConfig: () => ({ name: 'Input', type: 'image' }),
  compute: () => ({ out: undefined }),
};

/** Marks an output of the enclosing pipeline; whatever is wired into it becomes
 *  an output port on the pipeline node. Passive — the evaluator captures it. */
export const pipelineOutputNode: NodeDefinition = {
  type: 'pipelineOutput',
  label: 'Pipeline Output',
  category: 'Pipeline',
  description:
    'Marks an output of the enclosing pipeline — becomes an output port on the pipeline node. Wire a value into it.',
  autoRun: true,
  inputs: [], // derived by nodePorts()
  outputs: [],
  configFields: [NAME_FIELD, TYPE_OPTIONS],
  defaultConfig: () => ({ name: 'Output', type: 'image' }),
  compute: () => ({}),
};

/** A reusable sub-graph collapsed to one node. Ports derive from the inner
 *  markers; running it evaluates the subgraph. Manual-run so it never spends AI
 *  tokens without an explicit Run. */
export const pipelineNode: NodeDefinition = {
  type: 'pipeline',
  label: 'Pipeline',
  category: 'Pipeline',
  description:
    'A sub-graph collapsed to one node. Open it to edit the nodes inside; its Pipeline Input/Output markers become this node’s ports. Save it to reuse.',
  autoRun: false,
  inputs: [], // derived by nodePorts() from config.inputs
  outputs: [], // derived by nodePorts() from config.outputs
  defaultConfig: () => ({
    graph: { nodes: [], edges: [] } as Subgraph,
    inputs: [],
    outputs: [],
    name: '',
  }),
  compute: async (ctx) => {
    const graph = ctx.config.graph as Subgraph | undefined;
    if (!graph || !Array.isArray(graph.nodes) || !graph.nodes.length) return {};
    return evaluateSubgraph(graph, ctx.inputs, ctx);
  },
};

export const pipelineNodes: NodeDefinition[] = [pipelineInputNode, pipelineOutputNode, pipelineNode];
