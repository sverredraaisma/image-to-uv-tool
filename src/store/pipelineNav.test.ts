import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from './store';
import '../nodes'; // register built-ins

function reset() {
  localStorage.clear();
  useStore.setState({
    nodes: [],
    edges: [],
    runtime: {},
    epochs: {},
    apiKey: '',
    openRouterKey: '',
    proxyUrl: '',
    pendingConnection: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    pendingSelectIds: [],
    editorNodeId: null,
    preview: null,
    toasts: [],
    editStack: [],
    pipelineTestInputs: {},
    history: [],
    future: [],
  });
}

beforeEach(reset);
const s = () => useStore.getState();

describe('pipeline sub-canvas navigation', () => {
  it('enters an empty pipeline and shows its (empty) subgraph', () => {
    const p = s().addNode('pipeline');
    s().enterPipeline(p);
    expect(s().editStack).toHaveLength(1);
    expect(s().editStack[0].pipelineNodeId).toBe(p);
    expect(s().nodes).toHaveLength(0); // empty subgraph is the active graph
  });

  it('folds inner Input/Output markers into derived ports on exit', () => {
    const p = s().addNode('pipeline');
    s().enterPipeline(p);
    const pin = s().addNode('pipelineInput');
    s().updateNodeConfig(pin, { name: 'Photo', type: 'image' });
    const pout = s().addNode('pipelineOutput');
    s().updateNodeConfig(pout, { name: 'Result', type: 'image' });
    s().exitPipeline();

    expect(s().editStack).toHaveLength(0);
    const node = s().nodes.find((n) => n.id === p)!;
    const inputs = node.config.inputs as { id: string; label: string; type: string }[];
    const outputs = node.config.outputs as { id: string; label: string; type: string }[];
    expect(inputs).toEqual([{ id: pin, label: 'Photo', type: 'image' }]);
    expect(outputs).toEqual([{ id: pout, label: 'Result', type: 'image' }]);
    // The subgraph is preserved in the node's config.
    const graph = node.config.graph as { nodes: unknown[] };
    expect(graph.nodes).toHaveLength(2);
  });

  it('runs a pipeline end-to-end after editing its subgraph', async () => {
    // Build: solidColor(red) → pipeline{ in → invert → out }
    const src = s().addNode('solidColor');
    s().updateNodeConfig(src, { width: 1, height: 1, color: '#000000' });
    const p = s().addNode('pipeline');
    s().enterPipeline(p);
    const pin = s().addNode('pipelineInput');
    s().updateNodeConfig(pin, { name: 'In', type: 'image' });
    const inv = s().addNode('invert');
    s().updateNodeConfig(inv, { r: true, g: true, b: true, a: false });
    const pout = s().addNode('pipelineOutput');
    s().updateNodeConfig(pout, { name: 'Out', type: 'image' });
    s().addConnection({ source: pin, sourceHandle: 'out', target: inv, targetHandle: 'in' });
    s().addConnection({ source: inv, sourceHandle: 'out', target: pout, targetHandle: 'in' });
    s().exitPipeline();

    // Wire the source into the pipeline's derived input, then run it.
    s().addConnection({ source: src, sourceHandle: 'out', target: p, targetHandle: pin });
    await s().processAutoRun();
    await s().runNode(p);

    const out = s().runtime[p].outputs[pout];
    expect(out?.kind).toBe('image');
    if (out?.kind === 'image') expect([...out.data]).toEqual([255, 255, 255, 255]); // black inverted → white
  });

  it('exportGraph folds an in-progress pipeline edit into the root', () => {
    const p = s().addNode('pipeline');
    s().enterPipeline(p);
    s().addNode('pipelineInput');
    // While still inside, export should return the ROOT graph (one pipeline node).
    const exported = s().exportGraph();
    expect(exported.nodes).toHaveLength(1);
    expect(exported.nodes[0].type).toBe('pipeline');
    const graph = exported.nodes[0].config.graph as { nodes: unknown[] };
    expect(graph.nodes).toHaveLength(1); // the marker we just added
  });

  it('drops parent edges to a pipeline port removed during editing', () => {
    // Set up a pipeline with one input marker wired from a source.
    const src = s().addNode('solidColor');
    const p = s().addNode('pipeline');
    s().enterPipeline(p);
    const pin = s().addNode('pipelineInput');
    s().exitPipeline();
    s().addConnection({ source: src, sourceHandle: 'out', target: p, targetHandle: pin });
    expect(s().edges).toHaveLength(1);

    // Re-enter, delete the marker, exit → the parent edge must be gone.
    s().enterPipeline(p);
    s().removeNode(pin);
    s().exitPipeline();
    expect(s().edges).toHaveLength(0);
    const node = s().nodes.find((n) => n.id === p)!;
    expect(node.config.inputs).toEqual([]);
  });
});
