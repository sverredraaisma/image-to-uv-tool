import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

import type {
  ComputeContext,
  DataValue,
  GraphEdge,
  GraphNode,
  NodeConfig,
  NodeRuntime,
  SavedGraph,
} from '../types';
import {
  ancestors,
  descendants,
  downstreamNodeIds,
  topoSort,
  wouldCreateCycle,
} from '../engine/graph';
import { isCompatible } from '../engine/compatibility';
import { getNodeDef, getNodeDefSafe } from '../engine/registry';
import { findReadyAutoNode, gatherInputs } from '../engine/schedule';
import { createSafeStorage } from './safeStorage';
import '../nodes'; // side-effect: register built-in node definitions

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function genId(prefix: string): string {
  const rnd = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `${prefix}_${rnd}`;
}

function defaultRuntime(): NodeRuntime {
  return { status: 'outOfDate', outputs: {} };
}

function statusOf(runtime: Record<string, NodeRuntime>, id: string) {
  return runtime[id]?.status ?? 'outOfDate';
}

// Cross-call guards for the auto-run scheduler.
let autoRunPromise: Promise<void> | null = null;
let autoRunPending = false;

// Abort controllers for in-flight node runs, so long/hung runs can be cancelled.
const runControllers = new Map<string, AbortController>();

// ---------------------------------------------------------------------------
// Store types
// ---------------------------------------------------------------------------

export type ConnectionSide = 'output' | 'input';

export interface PendingConnection {
  nodeId: string;
  portId: string;
  side: ConnectionSide;
}

export interface PreviewState {
  value: DataValue;
  title: string;
}

export type ToastType = 'error' | 'success' | 'info';
export interface Toast {
  id: string;
  type: ToastType;
  message: string;
}

export interface ConnectionInput {
  source: string | null;
  sourceHandle: string | null;
  target: string | null;
  targetHandle: string | null;
}

export interface StoreState {
  nodes: GraphNode[];
  edges: GraphEdge[];
  runtime: Record<string, NodeRuntime>;
  /** Invalidation counter per node; bumped whenever a node goes out of date. */
  epochs: Record<string, number>;
  apiKey: string;
  openRouterKey: string;
  proxyUrl: string;

  pendingConnection: PendingConnection | null;
  selectedNodeId: string | null;
  editorNodeId: string | null;
  preview: PreviewState | null;
  toasts: Toast[];

  // settings
  setApiKey: (key: string) => void;
  setOpenRouterKey: (key: string) => void;
  setProxyUrl: (url: string) => void;

  // graph mutation
  addNode: (type: string, position?: { x: number; y: number }) => string;
  removeNode: (id: string) => void;
  setNodePosition: (id: string, position: { x: number; y: number }) => void;
  updateNodeConfig: (id: string, patch: NodeConfig) => void;
  addConnection: (conn: ConnectionInput) => boolean;
  canConnect: (conn: ConnectionInput) => boolean;
  removeEdge: (id: string) => void;

  // connection UX
  clickPort: (nodeId: string, portId: string, side: ConnectionSide) => void;
  cancelPendingConnection: () => void;

  // selection / editor / preview
  selectNode: (id: string | null) => void;
  openEditor: (id: string | null) => void;
  openPreview: (value: DataValue, title: string) => void;
  closePreview: () => void;

  // toasts
  addToast: (type: ToastType, message: string) => void;
  dismissToast: (id: string) => void;

  // evaluation
  markOutOfDate: (id: string) => void;
  runNode: (id: string) => Promise<void>;
  cancelNode: (id: string) => void;
  bringUpToDate: (id: string) => Promise<void>;
  processAutoRun: () => Promise<void>;
  _executeNode: (id: string) => Promise<void>;

  // persistence / lifecycle
  init: () => void;
  reset: () => void;
  exportGraph: () => SavedGraph;
  loadGraph: (graph: SavedGraph) => void;
  clearGraph: () => void;
}

interface ConnectionCheck {
  ok: boolean;
  reason?: string;
  multiple?: boolean;
}

/** Pure validation shared by `addConnection` and `canConnect`. */
function checkConnection(
  nodes: GraphNode[],
  edges: GraphEdge[],
  conn: ConnectionInput,
): ConnectionCheck {
  const { source, sourceHandle, target, targetHandle } = conn;
  if (!source || !target || !sourceHandle || !targetHandle) return { ok: false };
  const srcNode = nodes.find((n) => n.id === source);
  const tgtNode = nodes.find((n) => n.id === target);
  if (!srcNode || !tgtNode) return { ok: false };
  const outPort = getNodeDefSafe(srcNode.type)?.outputs.find((p) => p.id === sourceHandle);
  const inPort = getNodeDefSafe(tgtNode.type)?.inputs.find((p) => p.id === targetHandle);
  if (!outPort || !inPort) return { ok: false };
  if (!isCompatible(outPort.type, inPort.type)) {
    return { ok: false, reason: `Incompatible: ${outPort.type} → ${inPort.type}` };
  }
  if (wouldCreateCycle(source, target, edges)) {
    return { ok: false, reason: 'Connection would create a cycle' };
  }
  return { ok: true, multiple: inPort.multiple };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useStore = create<StoreState>()(
  persist(
    (set, get) => ({
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

      setApiKey: (key) => set({ apiKey: key }),
      setOpenRouterKey: (key) => set({ openRouterKey: key }),
      setProxyUrl: (url) => set({ proxyUrl: url }),

      addNode: (type, position) => {
        const def = getNodeDef(type);
        const id = genId('n');
        const node: GraphNode = {
          id,
          type,
          position: position ?? { x: 120, y: 120 },
          config: def.defaultConfig(),
        };
        set((s) => ({
          nodes: [...s.nodes, node],
          runtime: { ...s.runtime, [id]: defaultRuntime() },
        }));
        void get().processAutoRun();
        return id;
      },

      removeNode: (id) => {
        runControllers.get(id)?.abort(); // stop an in-flight run for this node
        const { edges, selectedNodeId, editorNodeId } = get();
        const affected = downstreamNodeIds(id, edges);
        set((s) => {
          const runtime = { ...s.runtime };
          delete runtime[id];
          const epochs = { ...s.epochs };
          delete epochs[id];
          return {
            nodes: s.nodes.filter((n) => n.id !== id),
            edges: s.edges.filter((e) => e.source !== id && e.target !== id),
            runtime,
            epochs,
            selectedNodeId: selectedNodeId === id ? null : s.selectedNodeId,
            editorNodeId: editorNodeId === id ? null : s.editorNodeId,
          };
        });
        for (const d of affected) get().markOutOfDate(d);
        void get().processAutoRun();
      },

      setNodePosition: (id, position) =>
        set((s) => ({
          nodes: s.nodes.map((n) => (n.id === id ? { ...n, position } : n)),
        })),

      updateNodeConfig: (id, patch) => {
        set((s) => ({
          nodes: s.nodes.map((n) =>
            n.id === id ? { ...n, config: { ...n.config, ...patch } } : n,
          ),
        }));
        get().markOutOfDate(id);
        void get().processAutoRun();
      },

      addConnection: (conn) => {
        const s = get();
        const check = checkConnection(s.nodes, s.edges, conn);
        if (!check.ok) {
          if (check.reason) get().addToast('error', check.reason);
          return false;
        }
        const { source, sourceHandle, target, targetHandle } = conn as {
          source: string;
          sourceHandle: string;
          target: string;
          targetHandle: string;
        };
        if (
          s.edges.some(
            (e) =>
              e.source === source &&
              e.sourceHandle === sourceHandle &&
              e.target === target &&
              e.targetHandle === targetHandle,
          )
        ) {
          return false;
        }
        let edges = s.edges;
        if (!check.multiple) {
          edges = edges.filter((e) => !(e.target === target && e.targetHandle === targetHandle));
        }
        const edge: GraphEdge = { id: genId('e'), source, sourceHandle, target, targetHandle };
        set({ edges: [...edges, edge] });
        get().markOutOfDate(target);
        void get().processAutoRun();
        return true;
      },

      canConnect: (conn) => checkConnection(get().nodes, get().edges, conn).ok,

      removeEdge: (id) => {
        const edge = get().edges.find((e) => e.id === id);
        set((s) => ({ edges: s.edges.filter((e) => e.id !== id) }));
        if (edge) {
          get().markOutOfDate(edge.target);
          void get().processAutoRun();
        }
      },

      clickPort: (nodeId, portId, side) => {
        const pending = get().pendingConnection;
        if (!pending) {
          set({ pendingConnection: { nodeId, portId, side } });
          return;
        }
        if (pending.nodeId === nodeId && pending.portId === portId) {
          set({ pendingConnection: null });
          return;
        }
        if (pending.side === side) {
          set({ pendingConnection: { nodeId, portId, side } });
          return;
        }
        const out = side === 'output' ? { nodeId, portId } : { nodeId: pending.nodeId, portId: pending.portId };
        const inp = side === 'input' ? { nodeId, portId } : { nodeId: pending.nodeId, portId: pending.portId };
        get().addConnection({
          source: out.nodeId,
          sourceHandle: out.portId,
          target: inp.nodeId,
          targetHandle: inp.portId,
        });
        set({ pendingConnection: null });
      },

      cancelPendingConnection: () => set({ pendingConnection: null }),

      selectNode: (id) => set({ selectedNodeId: id }),
      openEditor: (id) => set({ editorNodeId: id }),
      openPreview: (value, title) => set({ preview: { value, title } }),
      closePreview: () => set({ preview: null }),

      addToast: (type, message) =>
        set((s) => ({ toasts: [...s.toasts, { id: genId('t'), type, message }] })),
      dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

      markOutOfDate: (id) =>
        set((s) => ({
          runtime: {
            ...s.runtime,
            [id]: { ...(s.runtime[id] ?? defaultRuntime()), status: 'outOfDate' },
          },
          epochs: { ...s.epochs, [id]: (s.epochs[id] ?? 0) + 1 },
        })),

      _executeNode: async (id) => {
        const node = get().nodes.find((n) => n.id === id);
        if (!node) return;
        const def = getNodeDefSafe(node.type);
        if (!def) return;

        // Capture invalidation epoch so we can detect config/input changes that
        // happen while this (possibly async) node is running.
        const startEpoch = get().epochs[id] ?? 0;

        // Supersede any prior in-flight run and expose an abort signal.
        runControllers.get(id)?.abort();
        const controller = new AbortController();
        runControllers.set(id, controller);

        set((s) => ({
          runtime: {
            ...s.runtime,
            [id]: { ...(s.runtime[id] ?? defaultRuntime()), status: 'running', error: undefined },
          },
        }));

        try {
          const s = get();
          const inputs = gatherInputs(def.inputs, s.edges, s.runtime, id);
          const ctx: ComputeContext = {
            inputs,
            config: node.config,
            apiKey: get().apiKey || null,
            openRouterKey: get().openRouterKey || null,
            proxyUrl: get().proxyUrl || null,
            signal: controller.signal,
            onProgress: (message) =>
              set((st) => ({
                runtime: {
                  ...st.runtime,
                  [id]: { ...(st.runtime[id] ?? defaultRuntime()), progress: message },
                },
              })),
          };
          const result = await def.compute(ctx);

          // Node deleted while running — drop the result, don't resurrect it.
          if (!get().nodes.some((n) => n.id === id)) return;

          // Invalidated mid-run: discard the stale result and stay out of date so
          // the scheduler re-runs us with the fresh config/inputs.
          if ((get().epochs[id] ?? 0) !== startEpoch) {
            set((st) => ({
              runtime: {
                ...st.runtime,
                [id]: { ...(st.runtime[id] ?? defaultRuntime()), status: 'outOfDate', progress: undefined },
              },
            }));
            return;
          }

          set((st) => ({
            runtime: {
              ...st.runtime,
              [id]: { status: 'upToDate', outputs: result, error: undefined, progress: undefined },
            },
          }));
          // A node that just ran ("changed") makes its direct dependents stale.
          for (const d of downstreamNodeIds(id, get().edges)) get().markOutOfDate(d);
        } catch (err) {
          if (!get().nodes.some((n) => n.id === id)) return;
          // A user-initiated cancel resets the node to out-of-date, not error.
          if (err instanceof DOMException && err.name === 'AbortError') {
            set((st) => ({
              runtime: {
                ...st.runtime,
                [id]: { ...(st.runtime[id] ?? defaultRuntime()), status: 'outOfDate', error: undefined, progress: undefined },
              },
            }));
            return;
          }
          const message = err instanceof Error ? err.message : String(err);
          set((st) => ({
            runtime: {
              ...st.runtime,
              [id]: { ...(st.runtime[id] ?? defaultRuntime()), status: 'error', error: message, progress: undefined },
            },
          }));
          get().addToast('error', `${def.label}: ${message}`);
        } finally {
          if (runControllers.get(id) === controller) runControllers.delete(id);
        }
      },

      processAutoRun: () => {
        autoRunPending = true;
        if (autoRunPromise) return autoRunPromise;
        const sweep = async () => {
          for (;;) {
            const { nodes, edges, runtime } = get();
            const ready = findReadyAutoNode(
              nodes,
              edges,
              runtime,
              (type) => getNodeDefSafe(type)?.autoRun ?? false,
            );
            if (!ready) break;
            await get()._executeNode(ready);
          }
        };
        autoRunPromise = (async () => {
          try {
            while (autoRunPending) {
              autoRunPending = false;
              await sweep();
            }
          } finally {
            autoRunPromise = null;
          }
        })();
        return autoRunPromise;
      },

      runNode: async (id) => {
        const { edges } = get();
        let order: string[];
        try {
          order = topoSort(new Set([id, ...ancestors(id, edges)]), edges);
        } catch {
          get().addToast('error', 'Cannot run: cycle detected');
          return;
        }
        for (const n of order) {
          if (n === id || statusOf(get().runtime, n) !== 'upToDate') {
            await get()._executeNode(n);
          }
        }
        await get().processAutoRun();
      },

      cancelNode: (id) => {
        runControllers.get(id)?.abort();
      },

      bringUpToDate: async (id) => {
        const { edges } = get();
        const targets = new Set([id, ...descendants(id, edges)]);
        const need = new Set(targets);
        for (const t of targets) for (const a of ancestors(t, edges)) need.add(a);
        let order: string[];
        try {
          order = topoSort(need, edges);
        } catch {
          get().addToast('error', 'Cannot run: cycle detected');
          return;
        }
        for (const n of order) {
          if (targets.has(n) || statusOf(get().runtime, n) !== 'upToDate') {
            await get()._executeNode(n);
          }
        }
      },

      init: () => {
        void get().processAutoRun();
      },

      reset: () =>
        set({
          nodes: [],
          edges: [],
          runtime: {},
          epochs: {},
          pendingConnection: null,
          selectedNodeId: null,
          editorNodeId: null,
          preview: null,
          toasts: [],
        }),

      exportGraph: () => {
        const { nodes, edges } = get();
        return { version: 1, nodes, edges };
      },

      loadGraph: (graph) => {
        set({
          nodes: graph.nodes ?? [],
          edges: graph.edges ?? [],
          runtime: {},
          epochs: {},
          pendingConnection: null,
          selectedNodeId: null,
          editorNodeId: null,
          preview: null,
        });
        void get().processAutoRun();
      },

      clearGraph: () => {
        set({
          nodes: [],
          edges: [],
          runtime: {},
          epochs: {},
          pendingConnection: null,
          selectedNodeId: null,
          editorNodeId: null,
        });
      },
    }),
    {
      name: 'node-image-tool',
      storage: createJSONStorage(() =>
        createSafeStorage(localStorage, () => {
          try {
            useStore
              .getState()
              .addToast('error', 'Local storage is full — large images may not persist across reloads.');
          } catch {
            /* store not ready */
          }
        }),
      ),
      // Persist the graph + settings, but never the (regenerable) runtime.
      partialize: (s) => ({
        nodes: s.nodes,
        edges: s.edges,
        apiKey: s.apiKey,
        openRouterKey: s.openRouterKey,
        proxyUrl: s.proxyUrl,
      }),
    },
  ),
);
