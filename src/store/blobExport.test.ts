import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from './store';
import { setPlatform } from '../lib/platform';

const store = () => useStore.getState();

beforeEach(() => {
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
    editorNodeId: null,
    preview: null,
    toasts: [],
    history: [],
    future: [],
  });
  setPlatform({
    getBlob: (ref) => Promise.resolve(ref === 'blob_test' ? 'data:image/png;base64,ZZ' : null),
    decodeImage: () =>
      Promise.resolve({ kind: 'image', width: 1, height: 1, data: new Uint8ClampedArray(4) }),
  });
});

describe('exportGraphInlined (Phase 1.1 blob store)', () => {
  it('inlines a blob reference into config.src so the file is portable', async () => {
    const id = store().addNode('imageInput');
    store().updateNodeConfig(id, { srcRef: 'blob_test', src: '' });
    await store().processAutoRun();
    const graph = await store().exportGraphInlined();
    const node = graph.nodes.find((n) => n.id === id)!;
    expect(node.config.src).toBe('data:image/png;base64,ZZ');
    expect(node.config.srcRef).toBe('');
  });

  it('leaves a legacy inline src untouched', async () => {
    const id = store().addNode('imageInput');
    store().updateNodeConfig(id, { src: 'data:image/png;base64,LEGACY', srcRef: '' });
    const graph = await store().exportGraphInlined();
    const node = graph.nodes.find((n) => n.id === id)!;
    expect(node.config.src).toBe('data:image/png;base64,LEGACY');
  });
});
