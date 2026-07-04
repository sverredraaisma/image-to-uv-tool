import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from './store';
import { registerNode } from '../engine/registry';
import { asText } from '../nodes/helpers';
import type { NodeDefinition } from '../types';

// --- Synthetic test nodes (unique "test.*" types so they don't clash) -------
const runCounts: Record<string, number> = {};
const bump = (k: string) => (runCounts[k] = (runCounts[k] ?? 0) + 1);

const constNode: NodeDefinition = {
  type: 'test.const',
  label: 'Const',
  category: 'test',
  autoRun: true,
  inputs: [],
  outputs: [{ id: 'out', label: 'out', type: 'text' }],
  defaultConfig: () => ({ v: '0' }),
  compute: ({ config }) => {
    bump('const');
    return { out: { kind: 'text', text: String(config.v) } };
  },
};
const passNode: NodeDefinition = {
  type: 'test.pass',
  label: 'Pass',
  category: 'test',
  autoRun: true,
  inputs: [{ id: 'in', label: 'in', type: 'text' }],
  outputs: [{ id: 'out', label: 'out', type: 'text' }],
  defaultConfig: () => ({}),
  compute: ({ inputs }) => {
    bump('pass');
    return { out: { kind: 'text', text: asText(inputs.in) ?? '' } };
  },
};
const manualNode: NodeDefinition = {
  type: 'test.manual',
  label: 'Manual',
  category: 'test',
  autoRun: false,
  inputs: [{ id: 'in', label: 'in', type: 'text' }],
  outputs: [{ id: 'out', label: 'out', type: 'text' }],
  defaultConfig: () => ({}),
  compute: ({ inputs }) => {
    bump('manual');
    return { out: { kind: 'text', text: `M:${asText(inputs.in) ?? ''}` } };
  },
};
const imageInNode: NodeDefinition = {
  type: 'test.imgIn',
  label: 'ImgIn',
  category: 'test',
  autoRun: true,
  inputs: [{ id: 'in', label: 'in', type: 'image' }],
  outputs: [{ id: 'out', label: 'out', type: 'image' }],
  defaultConfig: () => ({}),
  compute: () => ({ out: undefined }),
};
// A manual node whose async compute we resolve by hand, to test mid-run edits.
let releaseAsync: (() => void) | null = null;
const asyncNode: NodeDefinition = {
  type: 'test.async',
  label: 'Async',
  category: 'test',
  autoRun: false,
  inputs: [],
  outputs: [{ id: 'out', label: 'out', type: 'text' }],
  defaultConfig: () => ({}),
  compute: () =>
    new Promise((resolve) => {
      releaseAsync = () => resolve({ out: { kind: 'text', text: 'done' } });
    }),
};
// A manual node whose compute rejects when its abort signal fires.
const abortableNode: NodeDefinition = {
  type: 'test.abortable',
  label: 'Abortable',
  category: 'test',
  autoRun: false,
  inputs: [],
  outputs: [{ id: 'out', label: 'out', type: 'text' }],
  defaultConfig: () => ({}),
  compute: ({ signal }) =>
    new Promise((_resolve, reject) => {
      if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
      signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }),
};
[constNode, passNode, manualNode, imageInNode, asyncNode, abortableNode].forEach(registerNode);

const store = () => useStore.getState();

beforeEach(() => {
  localStorage.clear();
  useStore.setState({
    nodes: [],
    edges: [],
    runtime: {},
    epochs: {},
    apiKey: '',
    proxyUrl: '',
    pendingConnection: null,
    selectedNodeId: null,
    editorNodeId: null,
    preview: null,
    toasts: [],
    history: [],
    future: [],
  });
  for (const k of Object.keys(runCounts)) delete runCounts[k];
  releaseAsync = null;
});

async function buildChain() {
  const a = store().addNode('test.const');
  store().updateNodeConfig(a, { v: '5' });
  const b = store().addNode('test.pass');
  const c = store().addNode('test.manual');
  store().addConnection({ source: a, sourceHandle: 'out', target: b, targetHandle: 'in' });
  store().addConnection({ source: b, sourceHandle: 'out', target: c, targetHandle: 'in' });
  await store().processAutoRun();
  return { a, b, c };
}

describe('auto-run scheduling', () => {
  it('runs auto nodes and propagates values, leaving manual nodes stale', async () => {
    const { a, b, c } = await buildChain();
    const rt = store().runtime;
    expect(rt[a].status).toBe('upToDate');
    expect(rt[b].status).toBe('upToDate');
    expect((rt[b].outputs.out as { text: string }).text).toBe('5');
    // manual node never auto-runs
    expect(rt[c].status).toBe('outOfDate');
    expect(runCounts.manual ?? 0).toBe(0);
  });

  it('re-runs downstream auto nodes when an upstream config changes', async () => {
    const { a, b, c } = await buildChain();
    store().updateNodeConfig(a, { v: '9' });
    await store().processAutoRun();
    expect((store().runtime[b].outputs.out as { text: string }).text).toBe('9');
    // the manual descendant becomes out of date again
    expect(store().runtime[c].status).toBe('outOfDate');
  });
});

describe('manual run', () => {
  it('runNode runs a manual node after resolving its ancestors', async () => {
    const { c } = await buildChain();
    await store().runNode(c);
    expect(store().runtime[c].status).toBe('upToDate');
    expect((store().runtime[c].outputs.out as { text: string }).text).toBe('M:5');
    expect(runCounts.manual).toBe(1);
  });
});

describe('bring up to date', () => {
  it('cascades downward and forces manual nodes to run', async () => {
    const { a, c } = await buildChain();
    expect(store().runtime[c].status).toBe('outOfDate');
    await store().bringUpToDate(a);
    expect(store().runtime[c].status).toBe('upToDate');
    expect((store().runtime[c].outputs.out as { text: string }).text).toBe('M:5');
  });

  it('does not re-run already up-to-date nodes (no needless token spend)', async () => {
    const { a, c } = await buildChain();
    await store().runNode(c); // now the whole chain is up to date
    const before = { ...runCounts };
    await store().bringUpToDate(a); // nothing stale -> should be a no-op
    expect(runCounts).toEqual(before);
    expect(store().runtime[c].status).toBe('upToDate');
  });
});

describe('connection validation', () => {
  it('rejects incompatible types with a toast', async () => {
    const a = store().addNode('test.const'); // text output
    const img = store().addNode('test.imgIn'); // image input
    await store().processAutoRun();
    const ok = store().addConnection({ source: a, sourceHandle: 'out', target: img, targetHandle: 'in' });
    expect(ok).toBe(false);
    expect(store().edges).toHaveLength(0);
    expect(store().toasts.some((t) => /incompatible/i.test(t.message))).toBe(true);
  });

  it('rejects a connection that would create a cycle', async () => {
    const p1 = store().addNode('test.pass');
    const p2 = store().addNode('test.pass');
    await store().processAutoRun();
    expect(store().addConnection({ source: p1, sourceHandle: 'out', target: p2, targetHandle: 'in' })).toBe(true);
    const ok = store().addConnection({ source: p2, sourceHandle: 'out', target: p1, targetHandle: 'in' });
    expect(ok).toBe(false);
    expect(store().toasts.some((t) => /cycle/i.test(t.message))).toBe(true);
  });

  it('a single (non-multiple) input replaces its existing connection', async () => {
    const a = store().addNode('test.const');
    const a2 = store().addNode('test.const');
    const b = store().addNode('test.pass');
    await store().processAutoRun();
    store().addConnection({ source: a, sourceHandle: 'out', target: b, targetHandle: 'in' });
    store().addConnection({ source: a2, sourceHandle: 'out', target: b, targetHandle: 'in' });
    const into = store().edges.filter((e) => e.target === b && e.targetHandle === 'in');
    expect(into).toHaveLength(1);
    expect(into[0].source).toBe(a2);
  });
});

describe('persistence', () => {
  it('persists graph + settings but never runtime outputs', async () => {
    await buildChain();
    store().setApiKey('secret-key');
    await new Promise((r) => setTimeout(r, 450)); // persist writes are debounced
    const raw = localStorage.getItem('node-image-tool');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw as string);
    expect(parsed.state.nodes).toHaveLength(3);
    expect(parsed.state.apiKey).toBe('secret-key');
    expect(parsed.state.runtime).toBeUndefined();
    expect(raw).not.toContain('outOfDate');
  });

  it('sanitizes a corrupt persisted graph on rehydration', async () => {
    localStorage.setItem(
      'node-image-tool',
      JSON.stringify({
        version: 0,
        state: {
          nodes: [
            { id: 'a', type: 'invert' }, // no position/config
            { type: 'orphan' }, // no id -> dropped
          ],
          edges: [{ id: 'e', source: 'a', sourceHandle: 'out', target: 'ghost', targetHandle: 'in' }],
          apiKey: 'k',
        },
      }),
    );
    await useStore.persist.rehydrate();
    expect(store().nodes.map((n) => n.id)).toEqual(['a']);
    expect(store().nodes[0].position).toEqual({ x: 0, y: 0 });
    expect(store().edges).toHaveLength(0); // dangling edge dropped
    expect(store().apiKey).toBe('k');
  });

  it('exportGraph / loadGraph round-trips the graph', async () => {
    const { a } = await buildChain();
    const saved = store().exportGraph();
    expect(saved.nodes).toHaveLength(3);
    useStore.setState({ nodes: [], edges: [], runtime: {} });
    store().loadGraph(saved);
    await store().processAutoRun();
    expect(store().nodes.some((n) => n.id === a)).toBe(true);
    expect(store().edges).toHaveLength(2);
  });

  it('tolerates an unknown node type without throwing', async () => {
    store().loadGraph({
      version: 1,
      nodes: [{ id: 'x', type: 'no-such-node', position: { x: 0, y: 0 }, config: {} }],
      edges: [],
    });
    await store().processAutoRun(); // scheduler must skip it
    await store().runNode('x'); // execute must no-op
    await store().bringUpToDate('x');
    expect(store().nodes.find((n) => n.id === 'x')).toBeTruthy();
  });
});

describe('click-to-connect', () => {
  it('connects clicking an output then a compatible input (either order)', () => {
    const a = store().addNode('test.const'); // text output 'out'
    const b = store().addNode('test.pass'); // text input 'in'
    store().clickPort(a, 'out', 'output');
    store().clickPort(b, 'in', 'input');
    expect(store().pendingConnection).toBeNull();
    expect(store().edges).toHaveLength(1);
    expect(store().edges[0]).toMatchObject({ source: a, sourceHandle: 'out', target: b, targetHandle: 'in' });

    const c = store().addNode('test.pass');
    store().clickPort(c, 'in', 'input'); // input first this time
    store().clickPort(a, 'out', 'output');
    expect(store().edges.some((e) => e.source === a && e.target === c)).toBe(true);
  });

  it('clicking the same port again cancels', () => {
    const a = store().addNode('test.const');
    store().clickPort(a, 'out', 'output');
    store().clickPort(a, 'out', 'output');
    expect(store().pendingConnection).toBeNull();
    expect(store().edges).toHaveLength(0);
  });

  it('clicking another port on the same side switches the pending selection', () => {
    const a = store().addNode('test.const');
    const a2 = store().addNode('test.const');
    store().clickPort(a, 'out', 'output');
    store().clickPort(a2, 'out', 'output');
    expect(store().pendingConnection?.nodeId).toBe(a2);
    expect(store().edges).toHaveLength(0);
  });
});

describe('undo / redo', () => {
  it('undo restores a removed node and its edges; redo re-removes it', async () => {
    const { b } = await buildChain();
    const edgeCount = store().edges.length;
    store().removeNode(b);
    await store().processAutoRun();
    expect(store().nodes.some((n) => n.id === b)).toBe(false);
    store().undo();
    expect(store().nodes.some((n) => n.id === b)).toBe(true);
    expect(store().edges).toHaveLength(edgeCount);
    store().redo();
    expect(store().nodes.some((n) => n.id === b)).toBe(false);
  });

  it('undo removes a just-added node', () => {
    store().addNode('test.const');
    expect(store().nodes).toHaveLength(1);
    store().undo();
    expect(store().nodes).toHaveLength(0);
  });

  it('moving a node to the same spot creates no history entry', () => {
    const a = store().addNode('test.const');
    const pos = { ...store().nodes[0].position };
    const before = store().history.length;
    store().setNodePosition(a, { ...pos });
    expect(store().history.length).toBe(before);
    store().setNodePosition(a, { x: pos.x + 10, y: pos.y });
    expect(store().history.length).toBe(before + 1);
  });

  it('clearGraph empties the graph and undo restores it', async () => {
    await buildChain();
    const count = store().nodes.length;
    const edges = store().edges.length;
    store().clearGraph();
    expect(store().nodes).toHaveLength(0);
    expect(store().edges).toHaveLength(0);
    store().undo();
    expect(store().nodes).toHaveLength(count);
    expect(store().edges).toHaveLength(edges);
  });

  it('clearGraph on an already-empty graph does not add history', () => {
    const before = store().history.length;
    store().clearGraph();
    expect(store().history.length).toBe(before);
  });

  it('a new action after undo clears the redo stack', () => {
    store().addNode('test.const');
    store().undo();
    expect(store().future.length).toBeGreaterThan(0);
    store().addNode('test.pass');
    expect(store().future).toHaveLength(0);
  });
});

describe('node + edge removal', () => {
  it('removing a node drops its edges and downstream goes stale', async () => {
    const { a, b } = await buildChain();
    store().removeNode(a);
    await store().processAutoRun();
    expect(store().nodes.some((n) => n.id === a)).toBe(false);
    expect(store().edges.some((e) => e.source === a)).toBe(false);
    // b lost its input -> recomputed to empty
    expect((store().runtime[b].outputs.out as { text: string }).text).toBe('');
  });

  it('duplicateNode copies type + config with a new id and offset position', () => {
    const a = store().addNode('test.const');
    store().updateNodeConfig(a, { v: '9' });
    const b = store().duplicateNode(a);
    expect(b).not.toBe(a);
    const orig = store().nodes.find((n) => n.id === a)!;
    const dup = store().nodes.find((n) => n.id === b)!;
    expect(dup.type).toBe('test.const');
    expect(dup.config.v).toBe('9');
    expect(dup.config).not.toBe(orig.config); // cloned, not shared
    expect(dup.position.x).toBeGreaterThan(orig.position.x);
  });

  it('clears a pending connection that referenced the removed node', async () => {
    const a = store().addNode('test.const');
    await store().processAutoRun();
    store().clickPort(a, 'out', 'output');
    expect(store().pendingConnection?.nodeId).toBe(a);
    store().removeNode(a);
    expect(store().pendingConnection).toBeNull();
  });

  it('does not resurrect runtime for a node removed mid-run', async () => {
    const id = store().addNode('test.async');
    const running = store().runNode(id); // starts the async compute (now pending)
    expect(releaseAsync).toBeTruthy();
    store().removeNode(id);
    releaseAsync!(); // compute resolves after the node is already gone
    await running;
    expect(store().nodes.some((n) => n.id === id)).toBe(false);
    expect(store().runtime[id]).toBeUndefined();
  });
});

describe('cancellation', () => {
  it('cancelNode aborts a running node and resets it to out of date', async () => {
    const id = store().addNode('test.abortable');
    const running = store().runNode(id);
    expect(store().runtime[id].status).toBe('running');
    store().cancelNode(id);
    await running;
    expect(store().runtime[id].status).toBe('outOfDate');
    expect(store().runtime[id].error).toBeUndefined();
  });
});
