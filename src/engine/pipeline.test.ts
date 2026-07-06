import { describe, it, expect } from 'vitest';
import '../nodes'; // register built-in node types
import { evaluateSubgraph, type Subgraph } from './pipeline';
import { pipelineNode } from '../nodes/pipeline';
import { createImage } from '../lib/image';
import type { ComputeContext, DataValue, GraphNode, RasterImage } from '../types';

const node = (id: string, type: string, config: Record<string, unknown> = {}): GraphNode => ({
  id,
  type,
  position: { x: 0, y: 0 },
  config,
});
const edge = (source: string, sourceHandle: string, target: string, targetHandle: string) => ({
  id: `${source}-${target}`,
  source,
  sourceHandle,
  target,
  targetHandle,
});

const ctx = (inputs: Record<string, DataValue | undefined>) =>
  ({ inputs, config: {}, apiKey: null, openRouterKey: null, proxyUrl: null }) as unknown as ComputeContext;

describe('evaluateSubgraph', () => {
  it('passes an input marker straight through to an output marker', async () => {
    const graph: Subgraph = {
      nodes: [node('pin', 'pipelineInput', { name: 'A', type: 'image' }), node('pout', 'pipelineOutput')],
      edges: [edge('pin', 'out', 'pout', 'in')],
    };
    const img = createImage(2, 2, [1, 2, 3, 255]);
    const out = await evaluateSubgraph(graph, { pin: img }, ctx({}));
    expect(out.pout).toBe(img);
  });

  it('runs inner nodes between the markers (invert)', async () => {
    const graph: Subgraph = {
      nodes: [
        node('pin', 'pipelineInput', { name: 'A', type: 'image' }),
        node('inv', 'invert', { r: true, g: true, b: true, a: false }),
        node('pout', 'pipelineOutput'),
      ],
      edges: [edge('pin', 'out', 'inv', 'in'), edge('inv', 'out', 'pout', 'in')],
    };
    const img = createImage(1, 1, [10, 20, 30, 255]);
    const out = await evaluateSubgraph(graph, { pin: img }, ctx({}));
    const result = out.pout as RasterImage;
    expect([...result.data]).toEqual([245, 235, 225, 255]);
  });

  it('captures multiple outputs by their marker ids', async () => {
    const graph: Subgraph = {
      nodes: [
        node('pin', 'pipelineInput', { name: 'A', type: 'image' }),
        node('gray', 'grayscale'),
        node('o1', 'pipelineOutput', { name: 'Original' }),
        node('o2', 'pipelineOutput', { name: 'Grey' }),
      ],
      edges: [
        edge('pin', 'out', 'gray', 'in'),
        edge('pin', 'out', 'o1', 'in'),
        edge('gray', 'out', 'o2', 'in'),
      ],
    };
    const img = createImage(1, 1, [255, 0, 0, 255]);
    const out = await evaluateSubgraph(graph, { pin: img }, ctx({}));
    expect((out.o1 as RasterImage).data[0]).toBe(255); // original red
    expect((out.o2 as RasterImage).data[0]).toBe(76); // luminance of red
  });

  it('throws on a cycle in the subgraph', async () => {
    const graph: Subgraph = {
      nodes: [node('a', 'invert'), node('b', 'invert')],
      edges: [edge('a', 'out', 'b', 'in'), edge('b', 'out', 'a', 'in')],
    };
    await expect(evaluateSubgraph(graph, {}, ctx({}))).rejects.toThrow();
  });
});

describe('pipeline node compute', () => {
  it('evaluates its embedded subgraph, keyed by output-marker id', async () => {
    const graph: Subgraph = {
      nodes: [
        node('pin', 'pipelineInput', { name: 'In', type: 'image' }),
        node('inv', 'invert', { r: true, g: true, b: true, a: false }),
        node('pout', 'pipelineOutput', { name: 'Out' }),
      ],
      edges: [edge('pin', 'out', 'inv', 'in'), edge('inv', 'out', 'pout', 'in')],
    };
    const img = createImage(1, 1, [0, 0, 0, 255]);
    const result = await pipelineNode.compute({
      inputs: { pin: img },
      config: { graph },
      apiKey: null,
      openRouterKey: null,
      proxyUrl: null,
    } as unknown as ComputeContext);
    expect((result.pout as RasterImage).data[0]).toBe(255); // inverted black → white
  });

  it('returns nothing for an empty pipeline', async () => {
    const result = await pipelineNode.compute({
      inputs: {},
      config: { graph: { nodes: [], edges: [] } },
      apiKey: null,
      openRouterKey: null,
      proxyUrl: null,
    } as unknown as ComputeContext);
    expect(result).toEqual({});
  });
});
