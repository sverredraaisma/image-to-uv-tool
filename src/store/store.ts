import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

import type {
  ComputeContext,
  ComputeResult,
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
  upstreamNodeIds,
  wouldCreateCycle,
} from '../engine/graph';
import { isCompatible } from '../engine/compatibility';
import { getNodeDef, getNodeDefSafe } from '../engine/registry';
import { nodePorts } from '../engine/ports';
import { sanitizeGraph, type SanitizeOptions } from '../engine/sanitize';
import { CURRENT_GRAPH_VERSION, migrateSavedGraph } from '../engine/migrate';
import { reconcileRuntime } from '../engine/reconcile';
import { cloneFragment } from '../engine/clone';
import { autoLayout } from '../engine/autoLayout';
import { bypassOutputs, findReadyAutoNodes, gatherInputs } from '../engine/schedule';
import { platform } from '../lib/platform';
import { isBlobRef } from '../lib/blobStore';
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

// Validate imported/rehydrated edges against the real node definitions, so a
// file import is held to the same invariants as live editing (see sanitizeGraph).
const SANITIZE_OPTIONS: SanitizeOptions = {
  getPorts: (node) => {
    const def = getNodeDefSafe(node.type);
    // Unknown type → null (structural-only checks). Known type → resolved ports,
    // which for a Pipeline are its per-instance derived ports.
    return def ? nodePorts(node, def) : null;
  },
  isCompatible,
};

// In-app clipboard for copy/paste (module-scoped; survives selection changes).
let clipboard: GraphSnapshot | null = null;

// Abort controllers for in-flight node runs, so long/hung runs can be cancelled.
const runControllers = new Map<string, AbortController>();

/**
 * Abort and forget every in-flight run. Called whenever the whole graph is
 * swapped out (undo/redo/load/reset/clear). After this, a still-pending run is
 * no longer the "current" controller for its node, so its (now stale) result is
 * discarded at the commit guard in `_executeNode` instead of overwriting the
 * freshly restored graph — this is what closes the epoch-reset hole (H1).
 */
function abortAllRuns(): void {
  for (const c of runControllers.values()) c.abort();
  runControllers.clear();
}

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

interface GraphSnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const HISTORY_LIMIT = 50;
const MAX_TOASTS = 6;

export interface StoreState {
  nodes: GraphNode[];
  edges: GraphEdge[];
  runtime: Record<string, NodeRuntime>;
  /** Invalidation counter per node; bumped whenever a node goes out of date. */
  epochs: Record<string, number>;
  apiKey: string;
  openRouterKey: string;
  proxyUrl: string;
  /** When false, generative-AI nodes are hidden from the add-node menus. */
  showGenAI: boolean;

  pendingConnection: PendingConnection | null;
  selectedNodeId: string | null;
  /** Full multi-selection from the canvas (for group duplicate / delete). */
  selectedNodeIds: string[];
  /**
   * One-shot request for the canvas to select exactly these nodes (e.g. a
   * freshly added / pasted node), then clear it. Runtime-only, never persisted.
   */
  pendingSelectIds: string[];
  /**
   * Installed by the canvas (which lives inside the React Flow provider) so
   * out-of-provider UI — the toolbar "Add node" menu — can drop a node at the
   * current viewport centre instead of a fixed off-screen spot. Null until the
   * canvas mounts. Runtime-only, never persisted.
   */
  viewportCenter: (() => { x: number; y: number }) | null;
  editorNodeId: string | null;
  preview: PreviewState | null;
  toasts: Toast[];
  /** Bumped by autoFormat so the canvas can re-fit the view. Runtime-only. */
  arrangeNonce: number;

  // undo/redo history of structural graph changes
  history: GraphSnapshot[];
  future: GraphSnapshot[];

  // settings
  setApiKey: (key: string) => void;
  setOpenRouterKey: (key: string) => void;
  setProxyUrl: (url: string) => void;
  setShowGenAI: (show: boolean) => void;

  // graph mutation
  addNode: (type: string, position?: { x: number; y: number }) => string;
  duplicateNode: (id: string) => string;
  duplicateNodes: (ids: string[]) => string[];
  copySelection: () => void;
  paste: () => string[];
  removeNode: (id: string) => void;
  removeNodes: (ids: string[]) => void;
  setNodePosition: (id: string, position: { x: number; y: number }) => void;
  setNodePositions: (updates: { id: string; position: { x: number; y: number } }[]) => void;
  autoFormat: () => void;
  updateNodeConfig: (id: string, patch: NodeConfig) => void;
  toggleBypass: (id: string) => void;
  addConnection: (conn: ConnectionInput) => boolean;
  canConnect: (conn: ConnectionInput) => boolean;
  removeEdge: (id: string) => void;
  undo: () => void;
  redo: () => void;
  _snapshot: () => void;

  // connection UX
  clickPort: (nodeId: string, portId: string, side: ConnectionSide) => void;
  cancelPendingConnection: () => void;

  // selection / editor / preview
  selectNode: (id: string | null) => void;
  setSelection: (ids: string[]) => void;
  clearPendingSelect: () => void;
  setViewportCenter: (fn: (() => { x: number; y: number }) | null) => void;
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
  exportGraphInlined: () => Promise<SavedGraph>;
  loadGraph: (graph: SavedGraph) => void;
  clearGraph: () => void;
}

interface ConnectionCheck {
  ok: boolean;
  reason?: string;
  multiple?: boolean;
}

/** Pure validation shared by `addConnection` and `canConnect`. */
function checkConnection(nodes: GraphNode[], edges: GraphEdge[], conn: ConnectionInput): ConnectionCheck {
  const { source, sourceHandle, target, targetHandle } = conn;
  if (!source || !target || !sourceHandle || !targetHandle) return { ok: false };
  const srcNode = nodes.find((n) => n.id === source);
  const tgtNode = nodes.find((n) => n.id === target);
  if (!srcNode || !tgtNode) return { ok: false };
  const outPort = nodePorts(srcNode, getNodeDefSafe(srcNode.type)).outputs.find((p) => p.id === sourceHandle);
  const inPort = nodePorts(tgtNode, getNodeDefSafe(tgtNode.type)).inputs.find((p) => p.id === targetHandle);
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
      showGenAI: true,
      pendingConnection: null,
      selectedNodeId: null,
      selectedNodeIds: [],
      pendingSelectIds: [],
      viewportCenter: null,
      editorNodeId: null,
      preview: null,
      toasts: [],
      arrangeNonce: 0,
      history: [],
      future: [],

      setApiKey: (key) => set({ apiKey: key }),
      setOpenRouterKey: (key) => set({ openRouterKey: key }),
      setProxyUrl: (url) => set({ proxyUrl: url }),
      setShowGenAI: (show) => set({ showGenAI: show }),

      addNode: (type, position) => {
        get()._snapshot();
        const def = getNodeDef(type);
        const id = genId('n');
        // No explicit position (e.g. the toolbar menu) → drop it at the current
        // viewport centre so it's never placed off-screen. Falls back to a fixed
        // spot before the canvas has installed its centre getter.
        const pos = position ?? get().viewportCenter?.() ?? { x: 120, y: 120 };
        const node: GraphNode = { id, type, position: pos, config: def.defaultConfig() };
        set((s) => ({
          nodes: [...s.nodes, node],
          runtime: { ...s.runtime, [id]: defaultRuntime() },
          // Ask the canvas to select the new node so it's easy to spot.
          pendingSelectIds: [id],
        }));
        void get().processAutoRun();
        return id;
      },

      duplicateNode: (id) => {
        const src = get().nodes.find((n) => n.id === id);
        if (!src) return '';
        get()._snapshot();
        const newId = genId('n');
        const node: GraphNode = {
          id: newId,
          type: src.type,
          position: { x: src.position.x + 40, y: src.position.y + 40 },
          // config is JSON-serialisable (it is persisted), so a clone is safe.
          config: JSON.parse(JSON.stringify(src.config)),
        };
        set((s) => ({
          nodes: [...s.nodes, node],
          runtime: { ...s.runtime, [newId]: defaultRuntime() },
          pendingSelectIds: [newId],
        }));
        void get().processAutoRun();
        return newId;
      },

      // Duplicate a group of nodes together, preserving the edges among them
      // (edges to nodes outside the group are dropped) as one undo step. Returns
      // the new node ids so the caller can re-select the copies.
      duplicateNodes: (ids) => {
        const present = new Set(ids.filter((id) => get().nodes.some((n) => n.id === id)));
        if (!present.size) return [];
        get()._snapshot();
        const { nodes: newNodes, edges: newEdges } = cloneFragment(get().nodes, get().edges, present, genId);
        set((s) => ({
          nodes: [...s.nodes, ...newNodes],
          edges: [...s.edges, ...newEdges],
          runtime: {
            ...s.runtime,
            ...Object.fromEntries(newNodes.map((n) => [n.id, defaultRuntime()])),
          },
          pendingSelectIds: newNodes.map((n) => n.id),
        }));
        void get().processAutoRun();
        return newNodes.map((n) => n.id);
      },

      copySelection: () => {
        const ids = new Set(get().selectedNodeIds);
        if (!ids.size) return;
        clipboard = {
          nodes: get()
            .nodes.filter((n) => ids.has(n.id))
            .map((n) => structuredClone(n)),
          edges: get()
            .edges.filter((e) => ids.has(e.source) && ids.has(e.target))
            .map((e) => structuredClone(e)),
        };
      },

      paste: () => {
        if (!clipboard || !clipboard.nodes.length) return [];
        get()._snapshot();
        const ids = new Set(clipboard.nodes.map((n) => n.id));
        const { nodes: newNodes, edges: newEdges } = cloneFragment(
          clipboard.nodes,
          clipboard.edges,
          ids,
          genId,
        );
        set((s) => ({
          nodes: [...s.nodes, ...newNodes],
          edges: [...s.edges, ...newEdges],
          runtime: {
            ...s.runtime,
            ...Object.fromEntries(newNodes.map((n) => [n.id, defaultRuntime()])),
          },
          selectedNodeIds: newNodes.map((n) => n.id),
          selectedNodeId: newNodes.length === 1 ? newNodes[0].id : null,
          pendingSelectIds: newNodes.map((n) => n.id),
        }));
        void get().processAutoRun();
        return newNodes.map((n) => n.id);
      },

      removeNode: (id) => {
        if (!get().nodes.some((n) => n.id === id)) return;
        get()._snapshot();
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
            selectedNodeIds: s.selectedNodeIds.filter((s) => s !== id),
            editorNodeId: editorNodeId === id ? null : s.editorNodeId,
            pendingConnection: s.pendingConnection?.nodeId === id ? null : s.pendingConnection,
          };
        });
        for (const d of affected) get().markOutOfDate(d);
        void get().processAutoRun();
      },

      setNodePosition: (id, position) => {
        const cur = get().nodes.find((n) => n.id === id);
        if (!cur || (cur.position.x === position.x && cur.position.y === position.y)) return;
        get()._snapshot();
        set((s) => ({
          nodes: s.nodes.map((n) => (n.id === id ? { ...n, position } : n)),
        }));
      },

      // Persist a whole multi-selection drag in one snapshot so the other
      // dragged nodes don't snap back on the next store sync, and one undo
      // reverses the whole move.
      setNodePositions: (updates) => {
        const cur = get().nodes;
        const moved = updates.filter((u) => {
          const n = cur.find((m) => m.id === u.id);
          return n && (n.position.x !== u.position.x || n.position.y !== u.position.y);
        });
        if (!moved.length) return;
        get()._snapshot();
        const byId = new Map(moved.map((u) => [u.id, u.position]));
        set((s) => ({
          nodes: s.nodes.map((n) => (byId.has(n.id) ? { ...n, position: byId.get(n.id)! } : n)),
        }));
      },

      // Re-arrange every node into a tidy layered layout from the connections
      // (one undo step). Bumps arrangeNonce so the canvas re-fits the view.
      autoFormat: () => {
        const { nodes, edges } = get();
        if (!nodes.length) return;
        const pos = autoLayout(nodes, edges, { originX: 80, originY: 80 });
        get()._snapshot();
        set((s) => ({
          nodes: s.nodes.map((n) => (pos[n.id] ? { ...n, position: pos[n.id] } : n)),
          arrangeNonce: s.arrangeNonce + 1,
        }));
      },

      removeNodes: (ids) => {
        const doomed = new Set(ids.filter((id) => get().nodes.some((n) => n.id === id)));
        if (!doomed.size) return;
        get()._snapshot();
        const { edges, selectedNodeId, editorNodeId } = get();
        const affected = new Set<string>();
        for (const id of doomed) {
          runControllers.get(id)?.abort();
          for (const d of downstreamNodeIds(id, edges)) if (!doomed.has(d)) affected.add(d);
        }
        set((s) => {
          const runtime = { ...s.runtime };
          const epochs = { ...s.epochs };
          for (const id of doomed) {
            delete runtime[id];
            delete epochs[id];
          }
          return {
            nodes: s.nodes.filter((n) => !doomed.has(n.id)),
            edges: s.edges.filter((e) => !doomed.has(e.source) && !doomed.has(e.target)),
            runtime,
            epochs,
            selectedNodeId: selectedNodeId && doomed.has(selectedNodeId) ? null : s.selectedNodeId,
            selectedNodeIds: s.selectedNodeIds.filter((id) => !doomed.has(id)),
            editorNodeId: editorNodeId && doomed.has(editorNodeId) ? null : s.editorNodeId,
            pendingConnection:
              s.pendingConnection && doomed.has(s.pendingConnection.nodeId) ? null : s.pendingConnection,
          };
        });
        for (const d of affected) get().markOutOfDate(d);
        void get().processAutoRun();
      },

      updateNodeConfig: (id, patch) => {
        set((s) => ({
          nodes: s.nodes.map((n) => (n.id === id ? { ...n, config: { ...n.config, ...patch } } : n)),
        }));
        get().markOutOfDate(id);
        void get().processAutoRun();
      },

      toggleBypass: (id) => {
        if (!get().nodes.some((n) => n.id === id)) return;
        get()._snapshot();
        set((s) => ({
          nodes: s.nodes.map((n) => (n.id === id ? { ...n, bypassed: !n.bypassed } : n)),
        }));
        // The node's own output changes, so it and everything downstream go stale.
        get().markOutOfDate(id);
        for (const d of descendants(id, get().edges)) get().markOutOfDate(d);
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
        get()._snapshot();
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

      _snapshot: () =>
        set((s) => ({
          history: [...s.history.slice(-(HISTORY_LIMIT - 1)), { nodes: s.nodes, edges: s.edges }],
          future: [],
        })),

      undo: () => {
        const { history } = get();
        if (!history.length) return;
        const prev = history[history.length - 1];
        abortAllRuns();
        set((s) => {
          const current = { nodes: s.nodes, edges: s.edges };
          return {
            nodes: prev.nodes,
            edges: prev.edges,
            history: s.history.slice(0, -1),
            future: [current, ...s.future].slice(0, HISTORY_LIMIT),
            // Keep results for nodes unchanged by the undo (don't wipe paid AI
            // outputs on a mere position nudge, H5).
            runtime: reconcileRuntime(s.runtime, current, prev),
            epochs: {},
            pendingConnection: null,
          };
        });
        void get().processAutoRun();
      },

      redo: () => {
        const { future } = get();
        if (!future.length) return;
        const next = future[0];
        abortAllRuns();
        set((s) => {
          const current = { nodes: s.nodes, edges: s.edges };
          return {
            nodes: next.nodes,
            edges: next.edges,
            future: s.future.slice(1),
            history: [...s.history.slice(-(HISTORY_LIMIT - 1)), current],
            runtime: reconcileRuntime(s.runtime, current, next),
            epochs: {},
            pendingConnection: null,
          };
        });
        void get().processAutoRun();
      },

      removeEdge: (id) => {
        const edge = get().edges.find((e) => e.id === id);
        if (!edge) return;
        get()._snapshot();
        set((s) => ({ edges: s.edges.filter((e) => e.id !== id) }));
        get().markOutOfDate(edge.target);
        void get().processAutoRun();
      },

      clickPort: (nodeId, portId, side) => {
        const pending = get().pendingConnection;
        if (!pending) {
          set({ pendingConnection: { nodeId, portId, side } });
          return;
        }
        if (pending.nodeId === nodeId && pending.portId === portId && pending.side === side) {
          set({ pendingConnection: null });
          return;
        }
        if (pending.side === side) {
          set({ pendingConnection: { nodeId, portId, side } });
          return;
        }
        const out =
          side === 'output' ? { nodeId, portId } : { nodeId: pending.nodeId, portId: pending.portId };
        const inp =
          side === 'input' ? { nodeId, portId } : { nodeId: pending.nodeId, portId: pending.portId };
        get().addConnection({
          source: out.nodeId,
          sourceHandle: out.portId,
          target: inp.nodeId,
          targetHandle: inp.portId,
        });
        set({ pendingConnection: null });
      },

      cancelPendingConnection: () => set({ pendingConnection: null }),

      selectNode: (id) => set({ selectedNodeId: id, selectedNodeIds: id ? [id] : [] }),
      setSelection: (ids) => set({ selectedNodeIds: ids, selectedNodeId: ids.length === 1 ? ids[0] : null }),
      clearPendingSelect: () => set((s) => (s.pendingSelectIds.length ? { pendingSelectIds: [] } : s)),
      setViewportCenter: (fn) => set({ viewportCenter: fn }),
      openEditor: (id) => set({ editorNodeId: id }),
      openPreview: (value, title) => set({ preview: { value, title } }),
      closePreview: () => set({ preview: null }),

      addToast: (type, message) =>
        // Keep only the most recent toasts so an error flood can't grow the
        // array (and the DOM) without bound.
        set((s) => ({ toasts: [...s.toasts, { id: genId('t'), type, message }].slice(-MAX_TOASTS) })),
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

        // True only while THIS run still owns the node: a newer run of the same
        // node, or a graph swap (undo/redo/load/reset) via abortAllRuns, replaces
        // or clears the controller. A run that is no longer current must not
        // write any result — that would clobber the newer run or resurrect a
        // stale output against a restored graph (H1).
        const isCurrent = () => runControllers.get(id) === controller;

        set((s) => ({
          runtime: {
            ...s.runtime,
            [id]: { ...(s.runtime[id] ?? defaultRuntime()), status: 'running', error: undefined },
          },
        }));

        try {
          const s = get();
          const ports = nodePorts(node, def);
          const inputs = gatherInputs(ports.inputs, s.edges, s.runtime, id);
          // A muted node acts as a wire: forward a compatible input to its
          // outputs instead of computing (no compute, no network, no token spend).
          let result: ComputeResult;
          if (node.bypassed) {
            result = bypassOutputs(ports.inputs, ports.outputs, inputs);
          } else {
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
            result = await def.compute(ctx);
          }

          // Node deleted while running — drop the result, don't resurrect it.
          if (!get().nodes.some((n) => n.id === id)) return;

          // Superseded by a newer run or a graph swap — that run/graph owns the
          // node now, so silently drop this result (H1).
          if (!isCurrent()) return;

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
          // Superseded by a newer run or a graph swap — don't stamp a status onto
          // a node the newer run/graph now owns (fixes the abort-clobber race).
          if (!isCurrent()) return;
          // A user-initiated cancel resets the node to out-of-date, not error.
          if (err instanceof DOMException && err.name === 'AbortError') {
            set((st) => ({
              runtime: {
                ...st.runtime,
                [id]: {
                  ...(st.runtime[id] ?? defaultRuntime()),
                  status: 'outOfDate',
                  error: undefined,
                  progress: undefined,
                },
              },
            }));
            return;
          }
          const message = err instanceof Error ? err.message : String(err);
          set((st) => ({
            runtime: {
              ...st.runtime,
              [id]: {
                ...(st.runtime[id] ?? defaultRuntime()),
                status: 'error',
                error: message,
                progress: undefined,
              },
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
            const ready = findReadyAutoNodes(
              nodes,
              edges,
              runtime,
              (n) => n.bypassed === true || (getNodeDefSafe(n.type)?.autoRun ?? false),
            );
            if (!ready.length) break;
            // Ready nodes are pairwise independent, so run them concurrently —
            // independent branches (and async decodes) progress in parallel.
            await Promise.all(ready.map((id) => get()._executeNode(id)));
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
        // Stop at a failed ancestor: running a descendant with a missing input
        // just produces silently-wrong output or a second toast.
        const failed = new Set<string>();
        for (const n of order) {
          if (upstreamNodeIds(n, edges).some((u) => failed.has(u))) {
            failed.add(n);
            continue;
          }
          if (n === id || statusOf(get().runtime, n) !== 'upToDate') {
            await get()._executeNode(n);
            if (statusOf(get().runtime, n) === 'error') failed.add(n);
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
        // Run only out-of-date nodes (forcing out-of-date manual ones); an
        // up-to-date node that re-runs would cascade needless recomputes — and
        // spend tokens on manual AI descendants — for no change. If nothing is
        // stale this is a no-op. Use Run ▶ to force a specific node.
        // Stop descending past a node that fails (missing-input cascade).
        const failed = new Set<string>();
        for (const n of order) {
          if (upstreamNodeIds(n, edges).some((u) => failed.has(u))) {
            failed.add(n);
            continue;
          }
          if (statusOf(get().runtime, n) !== 'upToDate') {
            await get()._executeNode(n);
            if (statusOf(get().runtime, n) === 'error') failed.add(n);
          }
        }
      },

      init: () => {
        void get().processAutoRun();
      },

      reset: () => {
        abortAllRuns();
        set({
          nodes: [],
          edges: [],
          runtime: {},
          epochs: {},
          pendingConnection: null,
          selectedNodeId: null,
          selectedNodeIds: [],
          pendingSelectIds: [],
          editorNodeId: null,
          preview: null,
          toasts: [],
          history: [],
          future: [],
        });
      },

      exportGraph: () => {
        // Deep-clone so callers can't mutate live store state through the
        // exported object (config objects are otherwise shared by reference).
        const { nodes, edges } = get();
        return { version: 1, nodes: structuredClone(nodes), edges: structuredClone(edges) };
      },

      exportGraphInlined: async () => {
        // Inline blob references back into config.src so a downloaded graph file
        // is self-contained and portable to another machine (its IndexedDB
        // wouldn't have our blobs). Import reads config.src via the legacy path.
        const graph = get().exportGraph();
        for (const node of graph.nodes) {
          const ref = node.config.srcRef;
          if (isBlobRef(ref) && !node.config.src) {
            const src = await platform.getBlob(ref).catch(() => null);
            if (src) {
              node.config = { ...node.config, src, srcRef: '' };
            }
          }
        }
        return graph;
      },

      loadGraph: (graph) => {
        get()._snapshot();
        abortAllRuns();
        const { nodes, edges } = sanitizeGraph(migrateSavedGraph(graph), SANITIZE_OPTIONS);
        set({
          nodes,
          edges,
          runtime: {},
          epochs: {},
          pendingConnection: null,
          selectedNodeId: null,
          selectedNodeIds: [],
          editorNodeId: null,
          preview: null,
        });
        void get().processAutoRun();
      },

      clearGraph: () => {
        if (!get().nodes.length && !get().edges.length) return;
        get()._snapshot();
        abortAllRuns();
        set({
          nodes: [],
          edges: [],
          runtime: {},
          epochs: {},
          pendingConnection: null,
          selectedNodeId: null,
          selectedNodeIds: [],
          editorNodeId: null,
        });
      },
    }),
    {
      name: 'node-image-tool',
      version: CURRENT_GRAPH_VERSION,
      // Runs when the persisted schema version differs from the current one;
      // normalise the graph shape before merge/sanitise validates it.
      migrate: (persisted) => {
        const p = (persisted ?? {}) as Record<string, unknown>;
        const { nodes, edges } = migrateSavedGraph({ version: 0, nodes: p.nodes, edges: p.edges });
        return { ...p, nodes, edges };
      },
      storage: createJSONStorage(() =>
        createSafeStorage(localStorage, {
          debounceMs: 400,
          onError: () => {
            try {
              useStore
                .getState()
                .addToast('error', 'Local storage is full — large images may not persist across reloads.');
            } catch {
              /* store not ready */
            }
          },
        }),
      ),
      // Persist the graph + settings, but never the (regenerable) runtime.
      partialize: (s) => ({
        nodes: s.nodes,
        edges: s.edges,
        apiKey: s.apiKey,
        openRouterKey: s.openRouterKey,
        proxyUrl: s.proxyUrl,
        showGenAI: s.showGenAI,
      }),
      // Sanitize the rehydrated graph the same way loadGraph does, so a
      // corrupt/partially-written localStorage entry can't crash on startup.
      // Only the whitelisted persisted keys are merged (and settings validated
      // as strings), so junk/legacy keys — runtime, toasts, a non-string
      // apiKey — can't leak in from a hand-edited or old localStorage blob.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Record<string, unknown>;
        const { nodes, edges } = sanitizeGraph({ nodes: p.nodes, edges: p.edges }, SANITIZE_OPTIONS);
        const asString = (v: unknown) => (typeof v === 'string' ? v : '');
        return {
          ...current,
          nodes,
          edges,
          apiKey: asString(p.apiKey),
          openRouterKey: asString(p.openRouterKey),
          proxyUrl: asString(p.proxyUrl),
          // Default to visible (true) if the persisted value isn't a boolean.
          showGenAI: typeof p.showGenAI === 'boolean' ? p.showGenAI : true,
        };
      },
    },
  ),
);
