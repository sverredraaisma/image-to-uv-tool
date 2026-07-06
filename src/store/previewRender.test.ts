import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from './store';
import '../nodes';
import type { RasterImage } from '../types';

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

async function grayChain() {
  const src = s().addNode('solidColor');
  s().updateNodeConfig(src, { width: 2, height: 2, color: '#ff0000' });
  const gray = s().addNode('grayscale');
  s().addConnection({ source: src, sourceHandle: 'out', target: gray, targetHandle: 'in' });
  await s().processAutoRun();
  return { src, gray };
}

describe('on-demand preview rendering', () => {
  it('shows the cached value immediately for an up-to-date node', async () => {
    const { gray } = await grayChain();
    expect(s().runtime[gray].status).toBe('upToDate');
    await s().requestPreview(gray, 'out', 'Grey · out');
    expect(s().preview?.loading).toBeFalsy();
    expect((s().preview?.value as RasterImage).kind).toBe('image');
  });

  it('renderNodeOutput re-runs a stale auto node up to full resolution', async () => {
    const { gray } = await grayChain();
    s().markOutOfDate(gray); // stale, without triggering auto-run
    expect(s().runtime[gray].status).toBe('outOfDate');
    await s().renderNodeOutput(gray);
    expect(s().runtime[gray].status).toBe('upToDate');
    const out = s().runtime[gray].outputs.out as RasterImage;
    expect([...out.data.slice(0, 3)]).toEqual([76, 76, 76]); // luminance of red
  });

  it('requestPreview renders a stale auto node and ends with a value', async () => {
    const { gray } = await grayChain();
    s().markOutOfDate(gray);
    await s().requestPreview(gray, 'out', 'Grey · out');
    expect(s().preview?.loading).toBeFalsy();
    expect((s().preview?.value as RasterImage).kind).toBe('image');
  });

  it('does not auto-run a manual node; reports nothing to preview instead', async () => {
    const img = s().addNode('solidColor');
    s().updateNodeConfig(img, { width: 2, height: 2, color: '#ffffff' });
    const stl = s().addNode('heightmapStl'); // manual
    s().addConnection({ source: img, sourceHandle: 'out', target: stl, targetHandle: 'in' });
    await s().processAutoRun();
    expect(s().runtime[stl].status).toBe('outOfDate'); // manual never auto-ran

    await s().requestPreview(stl, 'out', 'STL · out');
    // Manual node was NOT run (no token/compute spend); preview reports it.
    expect(s().runtime[stl].status).toBe('outOfDate');
    expect(s().preview?.value).toBeUndefined();
    expect(s().preview?.error).toMatch(/run.*manual/i);
  });

  it('closePreview supersedes a pending render', async () => {
    const { gray } = await grayChain();
    s().markOutOfDate(gray);
    const p = s().requestPreview(gray, 'out', 'Grey · out');
    s().closePreview(); // user closes before the render resolves
    await p;
    expect(s().preview).toBeNull();
  });
});
