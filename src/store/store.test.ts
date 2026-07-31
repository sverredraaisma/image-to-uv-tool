import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from './store';
import { registerNode } from '../engine/registry';
import { asText } from '../nodes/helpers';
import { createImage } from '../lib/image';
import { OversizeOutputError } from '../lib/lenticular';
import type { NodeDefinition, RasterImage, SequenceValue } from '../types';

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
// A manual node whose compute always throws.
const throwingNode: NodeDefinition = {
  type: 'test.throwing',
  label: 'Boom',
  category: 'test',
  autoRun: false,
  inputs: [],
  outputs: [{ id: 'out', label: 'out', type: 'text' }],
  defaultConfig: () => ({}),
  compute: async () => {
    throw new Error('kaboom');
  },
};
/**
 * A three-frame animation out of nowhere, so a store-level test can prove that
 * an ordinary image node maps over a Sequence without decoding a real GIF.
 */
const sequenceSourceNode: NodeDefinition = {
  type: 'test.sequence',
  label: 'Sequence source',
  category: 'test',
  autoRun: true,
  inputs: [],
  outputs: [{ id: 'out', label: 'out', type: 'sequence' }],
  defaultConfig: () => ({}),
  compute: () => ({
    out: {
      kind: 'sequence',
      frames: [10, 20, 30].map((v) => createImage(1, 1, [v, v, v, 255])),
      delaysMs: [40, 40, 40],
    },
  }),
};
/** Image in, image out — the shape every pixel op has. */
const shiftNode: NodeDefinition = {
  type: 'test.shift',
  label: 'Shift',
  category: 'test',
  autoRun: true,
  inputs: [{ id: 'in', label: 'in', type: 'image' }],
  outputs: [{ id: 'out', label: 'out', type: 'image' }],
  defaultConfig: () => ({}),
  compute: ({ inputs }) => {
    bump('shift');
    const img = inputs.in as RasterImage | undefined;
    if (!img) return { out: undefined };
    const v = img.data[0] + 1;
    return { out: createImage(1, 1, [v, v, v, 255]) };
  },
};

/**
 * Stands in for a print node: it refuses to produce its oversize output until
 * the run is told the user has agreed, and reports chunked progress when it does.
 */
const oversizeNode: NodeDefinition = {
  type: 'test.oversize',
  label: 'Huge',
  category: 'test',
  autoRun: false,
  inputs: [],
  outputs: [{ id: 'out', label: 'out', type: 'text' }],
  defaultConfig: () => ({}),
  compute: async ({ allowOversize, onProgress }) => {
    bump('oversize');
    if (!allowOversize) {
      throw new OversizeOutputError('Depth map', 20_000, 20_000, 'Reduce Width (mm) or PPI', 100, 'too big');
    }
    onProgress?.('Depth map — chunk 50 of 100', 0.5);
    return { out: { kind: 'text', text: 'rendered' } };
  },
};

[
  constNode,
  passNode,
  manualNode,
  imageInNode,
  asyncNode,
  abortableNode,
  throwingNode,
  sequenceSourceNode,
  shiftNode,
  oversizeNode,
].forEach(registerNode);

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
    oversize: null,
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

  it('computes a diamond graph correctly with concurrent independent branches', async () => {
    // a → b, a → c, then b & c → d (multiple input). b and c run concurrently.
    const a = store().addNode('test.const');
    store().updateNodeConfig(a, { v: 'X' });
    const b = store().addNode('test.pass');
    const c = store().addNode('test.pass');
    const d = store().addNode('test.pass'); // 'in' is single, so wire only b→d here
    store().addConnection({ source: a, sourceHandle: 'out', target: b, targetHandle: 'in' });
    store().addConnection({ source: a, sourceHandle: 'out', target: c, targetHandle: 'in' });
    store().addConnection({ source: b, sourceHandle: 'out', target: d, targetHandle: 'in' });
    await store().processAutoRun();
    expect(store().runtime[a].status).toBe('upToDate');
    expect(store().runtime[b].status).toBe('upToDate');
    expect(store().runtime[c].status).toBe('upToDate');
    expect((store().runtime[b].outputs.out as { text: string }).text).toBe('X');
    expect((store().runtime[c].outputs.out as { text: string }).text).toBe('X');
    expect((store().runtime[d].outputs.out as { text: string }).text).toBe('X');
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
    expect(store().addConnection({ source: p1, sourceHandle: 'out', target: p2, targetHandle: 'in' })).toBe(
      true,
    );
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

  it('ignores junk/legacy persisted keys and coerces non-string settings', async () => {
    localStorage.setItem(
      'node-image-tool',
      JSON.stringify({
        version: 0,
        state: {
          nodes: [{ id: 'a', type: 'invert', position: { x: 0, y: 0 }, config: {} }],
          edges: [],
          apiKey: 123, // wrong type -> coerced to ''
          openRouterKey: 'ok',
          runtime: { a: { status: 'upToDate', outputs: {} } }, // junk -> must not restore
          toasts: [{ id: 't', type: 'error', message: 'stale' }], // junk -> must not restore
        },
      }),
    );
    await useStore.persist.rehydrate();
    expect(store().apiKey).toBe(''); // non-string dropped
    expect(store().openRouterKey).toBe('ok');
    expect(store().runtime).toEqual({}); // persisted runtime not restored
    expect(store().toasts).toEqual([]); // persisted toasts not restored
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

  it('removeNodes deletes a whole selection in one undo step', async () => {
    const { a, b, c } = await buildChain();
    const before = store().history.length;
    store().removeNodes([a, b]);
    expect(store().nodes.some((n) => n.id === a || n.id === b)).toBe(false);
    expect(store().history.length).toBe(before + 1); // single snapshot, not one per node
    store().undo();
    expect(store().nodes.some((n) => n.id === a)).toBe(true);
    expect(store().nodes.some((n) => n.id === b)).toBe(true);
    void c;
  });

  it('setNodePositions moves a selection in one snapshot; a no-op move adds none', () => {
    const a = store().addNode('test.const');
    const b = store().addNode('test.const');
    const pa = store().nodes.find((n) => n.id === a)!.position;
    const pb = store().nodes.find((n) => n.id === b)!.position;
    const before = store().history.length;
    store().setNodePositions([
      { id: a, position: { x: pa.x + 30, y: pa.y } },
      { id: b, position: { x: pb.x + 30, y: pb.y } },
    ]);
    expect(store().history.length).toBe(before + 1);
    expect(store().nodes.find((n) => n.id === a)!.position.x).toBe(pa.x + 30);
    expect(store().nodes.find((n) => n.id === b)!.position.x).toBe(pb.x + 30);
    // No-op move (same positions) must not create a history entry.
    const after = store().history.length;
    store().setNodePositions([{ id: a, position: { x: pa.x + 30, y: pa.y } }]);
    expect(store().history.length).toBe(after);
  });

  it('duplicateNodes copies a group with its internal edges in one undo step', async () => {
    const a = store().addNode('test.const');
    const b = store().addNode('test.pass');
    store().addConnection({ source: a, sourceHandle: 'out', target: b, targetHandle: 'in' });
    await store().processAutoRun();
    const beforeNodes = store().nodes.length;
    const beforeEdges = store().edges.length;
    const beforeHistory = store().history.length;

    const copies = store().duplicateNodes([a, b]);
    expect(copies).toHaveLength(2);
    expect(store().nodes.length).toBe(beforeNodes + 2);
    // the internal a->b edge is duplicated among the copies
    expect(store().edges.length).toBe(beforeEdges + 1);
    const [ca, cb] = copies;
    expect(store().edges.some((e) => e.source === ca && e.target === cb)).toBe(true);
    // single undo step reverses the whole group duplicate
    expect(store().history.length).toBe(beforeHistory + 1);
    store().undo();
    expect(store().nodes.length).toBe(beforeNodes);
  });

  it('copySelection + paste clones the selection (with internal edges) and selects the copies', async () => {
    const a = store().addNode('test.const');
    const b = store().addNode('test.pass');
    store().addConnection({ source: a, sourceHandle: 'out', target: b, targetHandle: 'in' });
    await store().processAutoRun();
    store().setSelection([a, b]);
    store().copySelection();

    const before = store().nodes.length;
    const pasted = store().paste();
    expect(pasted).toHaveLength(2);
    expect(store().nodes.length).toBe(before + 2);
    expect(store().edges.some((e) => e.source === pasted[0] && e.target === pasted[1])).toBe(true);
    expect(store().selectedNodeIds).toEqual(pasted); // copies become the selection

    // paste again works even after the originals are gone (clipboard holds content)
    store().removeNodes([a, b]);
    const second = store().paste();
    expect(second).toHaveLength(2);
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

describe('compute errors', () => {
  it('a throwing compute sets error status and toasts the label + message', async () => {
    const id = store().addNode('test.throwing');
    await store().runNode(id);
    expect(store().runtime[id].status).toBe('error');
    expect(store().runtime[id].error).toBe('kaboom');
    expect(store().toasts.some((t) => t.type === 'error' && /Boom: kaboom/.test(t.message))).toBe(true);
  });

  it('runNode stops at a failed ancestor instead of running descendants blind', async () => {
    const t = store().addNode('test.throwing'); // throws, outputs text 'out'
    const p = store().addNode('test.pass'); // text 'in'
    store().addConnection({ source: t, sourceHandle: 'out', target: p, targetHandle: 'in' });
    await store().processAutoRun();
    await store().runNode(p);
    expect(store().runtime[t].status).toBe('error');
    expect(runCounts.pass ?? 0).toBe(0); // descendant never ran on a missing input
    expect(store().runtime[p].status).not.toBe('upToDate');
  });

  it('bringUpToDate does not run descendants past a failed node', async () => {
    const t = store().addNode('test.throwing');
    const p = store().addNode('test.pass');
    store().addConnection({ source: t, sourceHandle: 'out', target: p, targetHandle: 'in' });
    await store().runNode(t); // t errors
    const passRuns = runCounts.pass ?? 0;
    await store().bringUpToDate(t); // t re-runs and errors; p must stay blocked
    expect(runCounts.pass ?? 0).toBe(passRuns);
  });
});

describe('graph-swap safety (H1 / H5)', () => {
  it('an in-flight run does not commit its stale result after an undo', async () => {
    const m = store().addNode('test.async'); // snapshot: []
    const running = store().runNode(m); // async compute pending, status running
    expect(store().runtime[m].status).toBe('running');
    store().addNode('test.const'); // snapshot: [m]
    store().undo(); // restore [m]; aborts in-flight runs
    releaseAsync!(); // the old run resolves only now, against the restored graph
    await running;
    // The stale 'done' output must NOT have been committed.
    expect(store().runtime[m].status).toBe('outOfDate');
    expect(store().runtime[m].outputs.out).toBeUndefined();
  });

  it('undo preserves computed results for nodes it did not change (no paid re-run)', async () => {
    const { a, c } = await buildChain();
    await store().runNode(c); // manual node now up to date ("M:5")
    expect(store().runtime[c].status).toBe('upToDate');
    const manualRuns = runCounts.manual;

    // A pure position nudge, then undo it.
    const pos = store().nodes.find((n) => n.id === a)!.position;
    store().setNodePosition(a, { x: pos.x + 25, y: pos.y });
    store().undo();
    await store().processAutoRun();

    // The manual result survived the undo and was not recomputed.
    expect(store().runtime[c].status).toBe('upToDate');
    expect((store().runtime[c].outputs.out as { text: string }).text).toBe('M:5');
    expect(runCounts.manual).toBe(manualRuns);
  });

  it('undo invalidates the structurally-affected branch but keeps an unrelated result', async () => {
    // Two independent chains, each ending in a (paid) manual node.
    const a1 = store().addNode('test.const');
    store().updateNodeConfig(a1, { v: '5' });
    const b1 = store().addNode('test.pass');
    const c1 = store().addNode('test.manual');
    store().addConnection({ source: a1, sourceHandle: 'out', target: b1, targetHandle: 'in' });
    store().addConnection({ source: b1, sourceHandle: 'out', target: c1, targetHandle: 'in' });

    const a2 = store().addNode('test.const');
    store().updateNodeConfig(a2, { v: '9' });
    const b2 = store().addNode('test.pass');
    const c2 = store().addNode('test.manual');
    store().addConnection({ source: a2, sourceHandle: 'out', target: b2, targetHandle: 'in' });
    store().addConnection({ source: b2, sourceHandle: 'out', target: c2, targetHandle: 'in' });

    await store().processAutoRun();
    await store().runNode(c1);
    await store().runNode(c2);
    expect(store().runtime[c1].status).toBe('upToDate');
    expect(store().runtime[c2].status).toBe('upToDate');

    // Structurally change chain 1, then undo it.
    const ab1 = store().edges.find((e) => e.source === a1 && e.target === b1)!;
    store().removeEdge(ab1.id);
    await store().processAutoRun();
    store().undo(); // restore a1 -> b1
    await store().processAutoRun();

    // chain 1's manual node was invalidated by the structural change...
    expect(store().runtime[c1].status).toBe('outOfDate');
    // ...but chain 2 (untouched) kept its result — a full wipe would lose it.
    expect(store().runtime[c2].status).toBe('upToDate');
    expect((store().runtime[c2].outputs.out as { text: string }).text).toBe('M:9');
  });
});

describe('node bypass (mute)', () => {
  it('a bypassed auto node forwards its input and stops computing', async () => {
    const { a, b } = await buildChain(); // a(const '5') -> b(pass) -> c(manual)
    expect((store().runtime[b].outputs.out as { text: string }).text).toBe('5');
    const passRuns = runCounts.pass ?? 0;

    store().toggleBypass(b);
    await store().processAutoRun();
    // b now passes 'a' straight through (still '5' here) without running compute…
    expect((store().runtime[b].outputs.out as { text: string }).text).toBe('5');
    expect(runCounts.pass ?? 0).toBe(passRuns); // pass compute did not run
    void a;
  });

  it('a bypassed manual node auto-updates when its input changes', async () => {
    const a = store().addNode('test.const');
    store().updateNodeConfig(a, { v: 'hello' });
    const m = store().addNode('test.manual'); // manual: normally needs Run
    store().addConnection({ source: a, sourceHandle: 'out', target: m, targetHandle: 'in' });
    await store().processAutoRun();
    expect(store().runtime[m].status).toBe('outOfDate'); // manual, not run yet

    store().toggleBypass(m);
    await store().processAutoRun();
    // muted manual node now behaves as a wire and updates automatically
    expect(store().runtime[m].status).toBe('upToDate');
    expect((store().runtime[m].outputs.out as { text: string }).text).toBe('hello');
    expect(runCounts.manual ?? 0).toBe(0); // never actually ran the manual compute
  });
});

describe('robustness (§2.3)', () => {
  it('caps the toast list so an error flood cannot grow unbounded', () => {
    for (let i = 0; i < 12; i++) store().addToast('error', `e${i}`);
    const toasts = store().toasts;
    expect(toasts.length).toBeLessThanOrEqual(6);
    expect(toasts[toasts.length - 1].message).toBe('e11'); // keeps the most recent
  });

  it('exportGraph returns a deep clone (mutating it does not affect the store)', () => {
    const a = store().addNode('test.const');
    store().updateNodeConfig(a, { v: 'orig' });
    const saved = store().exportGraph();
    (saved.nodes.find((n) => n.id === a)!.config as { v: string }).v = 'mutated';
    expect(store().nodes.find((n) => n.id === a)!.config.v).toBe('orig');
  });

  it('runs an ordinary image node over every frame of a sequence', async () => {
    // The capability is the scheduler's, not the node's: test.shift knows
    // nothing about animations, and still turns three frames into three.
    const src = store().addNode('test.sequence');
    const op = store().addNode('test.shift');
    store().addConnection({ source: src, sourceHandle: 'out', target: op, targetHandle: 'in' });
    await store().processAutoRun();

    const out = store().runtime[op].outputs.out as SequenceValue;
    expect(out.kind).toBe('sequence');
    expect(out.frames.map((f) => f.data[0])).toEqual([11, 21, 31]);
    expect(out.delaysMs).toEqual([40, 40, 40]);
    expect(runCounts.shift).toBe(3); // once per frame, not once for the first
  });
});

describe('oversize consent', () => {
  it('asks instead of just failing, with the numbers the user needs', async () => {
    const id = store().addNode('test.oversize');
    await store().runNode(id);
    // Still an error on the node — nothing was produced — but the question is
    // now on screen rather than only in a toast.
    expect(store().runtime[id].status).toBe('error');
    expect(store().oversize).toMatchObject({
      nodeId: id,
      label: 'Huge',
      what: 'Depth map',
      width: 20_000,
      height: 20_000,
      chunks: 100,
    });
    // …and it is a question, not a failure, so it does not also shout.
    expect(store().toasts).toHaveLength(0);
  });

  it('runs the work again with consent when the user agrees', async () => {
    const id = store().addNode('test.oversize');
    await store().runNode(id);
    expect(store().oversizeAllowed(id)).toBe(false);

    store().confirmOversize();
    expect(store().oversize).toBeNull();
    expect(store().oversizeAllowed(id)).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(store().runtime[id].status).toBe('upToDate');
    expect((store().runtime[id].outputs.out as { text: string }).text).toBe('rendered');
    expect(runCounts.oversize).toBe(2); // refused once, then run
  });

  it('leaves the node alone when the user declines', async () => {
    const id = store().addNode('test.oversize');
    await store().runNode(id);
    store().dismissOversize();
    expect(store().oversize).toBeNull();
    expect(store().oversizeAllowed(id)).toBe(false);
    expect(store().runtime[id].status).toBe('error');
    expect(runCounts.oversize).toBe(1);
  });

  it('forgets the consent when the settings that sized it change', async () => {
    const id = store().addNode('test.oversize');
    await store().runNode(id);
    store().confirmOversize();
    await new Promise((r) => setTimeout(r, 0));
    expect(store().oversizeAllowed(id)).toBe(true);

    store().updateNodeConfig(id, { widthMm: 900 });
    expect(store().oversizeAllowed(id)).toBe(false);
  });

  it('puts the chunk progress on the node, fraction and all', async () => {
    const id = store().addNode('test.oversize');
    await store().runNode(id);
    store().confirmOversize();
    // Caught mid-run: the node carries the message and how far along it is.
    expect(store().runtime[id].progress).toBe('Depth map — chunk 50 of 100');
    expect(store().runtime[id].progressFraction).toBe(0.5);
    await new Promise((r) => setTimeout(r, 0));
    // …and both are cleared once it finishes.
    expect(store().runtime[id].progress).toBeUndefined();
  });
});
