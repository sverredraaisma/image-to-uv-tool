import { useEffect } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type Connection,
  type NodeChange,
  type EdgeChange,
} from '@xyflow/react';
import { useStore } from '../store/store';
import { NodeView } from './NodeView';

const nodeTypes = { imageTool: NodeView };

// A single shared, stable `data` object for every node. NodeView reads
// everything it needs from the store by id, so the React Flow node carries no
// per-node data — a fresh `{}` each sync would break React Flow's per-node
// memoisation and re-render every NodeView on any change (H3).
const NODE_DATA = {} as const;

export function Canvas() {
  const storeNodes = useStore((s) => s.nodes);
  const storeEdges = useStore((s) => s.edges);
  const pending = useStore((s) => s.pendingConnection);
  const setNodePositions = useStore((s) => s.setNodePositions);
  const removeNodes = useStore((s) => s.removeNodes);
  const removeEdge = useStore((s) => s.removeEdge);
  const selectNode = useStore((s) => s.selectNode);
  const addConnection = useStore((s) => s.addConnection);
  const canConnect = useStore((s) => s.canConnect);
  const cancelPending = useStore((s) => s.cancelPendingConnection);

  // Nodes live in local React Flow state for smooth dragging; only the final
  // dropped position is written back to the (persisted) store.
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node>([]);

  useEffect(() => {
    setRfNodes((prev) => {
      const prevById = new Map(prev.map((p) => [p.id, p]));
      return storeNodes.map((n) => {
        // Preserve the existing React Flow node object (identity) when nothing
        // this layer cares about changed, so a config keystroke on one node
        // doesn't re-render every other node. The store keeps the same node
        // object reference (and thus the same `position` ref) for untouched
        // nodes, so an unchanged `position` ref means "reuse as-is".
        const existing = prevById.get(n.id);
        if (existing && existing.position === n.position) return existing;
        return {
          id: n.id,
          type: 'imageTool',
          position: n.position,
          selected: existing?.selected ?? false,
          data: NODE_DATA,
        };
      });
    });
  }, [storeNodes, setRfNodes]);

  // Edges also live in local state so React Flow can track their selection —
  // otherwise clicking an edge never marks it selected and Delete can't remove
  // it. Removals are propagated back to the store.
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<Edge>([]);

  useEffect(() => {
    setRfEdges((prev) =>
      storeEdges.map((e) => {
        const existing = prev.find((p) => p.id === e.id);
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          sourceHandle: e.sourceHandle,
          targetHandle: e.targetHandle,
          selected: existing?.selected ?? false,
        };
      }),
    );
  }, [storeEdges, setRfEdges]);

  const handleNodesChange = (changes: NodeChange<Node>[]) => {
    onNodesChange(changes); // keep local state smooth (drag, select…)
    // Batch a multi-selection delete into one store mutation so it is a single
    // undo step (not one per node).
    const removed = changes.filter((c) => c.type === 'remove').map((c) => c.id);
    if (removed.length) removeNodes(removed);
    for (const c of changes) {
      if (c.type === 'select') selectNode(c.selected ? c.id : null);
    }
  };

  const handleEdgesChange = (changes: EdgeChange[]) => {
    onEdgesChange(changes); // keep local state (selection) in sync
    for (const c of changes) if (c.type === 'remove') removeEdge(c.id);
  };

  return (
    <div className={`canvas ${pending ? 'connecting' : ''}`}>
      {storeNodes.length === 0 && (
        <div className="canvas-empty">
          <div className="canvas-empty-card">
            <div className="canvas-empty-title">Start building</div>
            <div>Add a node from the top-right menu, then wire outputs into inputs.</div>
            <div className="canvas-empty-sub">
              Paste your Replicate / OpenRouter key (top-left) to use the AI nodes.
            </div>
          </div>
        </div>
      )}
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodesChange={handleNodesChange}
        onNodeDragStop={(_e, node, nodes) => {
          // `nodes` is every node moved in this drag (the whole selection);
          // persist them all so none snap back, falling back to the single node.
          const dragged = nodes?.length ? nodes : [node];
          setNodePositions(dragged.map((d) => ({ id: d.id, position: d.position })));
        }}
        onEdgesChange={handleEdgesChange}
        onConnect={(c: Connection) => addConnection(c)}
        isValidConnection={(c) => canConnect(c as Connection)}
        onPaneClick={() => {
          cancelPending();
          selectNode(null);
        }}
        deleteKeyCode={['Backspace', 'Delete']}
        fitView
        minZoom={0.15}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={18} />
        <MiniMap pannable zoomable />
        <Controls />
      </ReactFlow>
    </div>
  );
}
