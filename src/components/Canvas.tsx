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

export function Canvas() {
  const storeNodes = useStore((s) => s.nodes);
  const storeEdges = useStore((s) => s.edges);
  const pending = useStore((s) => s.pendingConnection);
  const setNodePosition = useStore((s) => s.setNodePosition);
  const removeNode = useStore((s) => s.removeNode);
  const removeEdge = useStore((s) => s.removeEdge);
  const selectNode = useStore((s) => s.selectNode);
  const addConnection = useStore((s) => s.addConnection);
  const canConnect = useStore((s) => s.canConnect);
  const cancelPending = useStore((s) => s.cancelPendingConnection);

  // Nodes live in local React Flow state for smooth dragging; only the final
  // dropped position is written back to the (persisted) store.
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node>([]);

  useEffect(() => {
    setRfNodes((prev) =>
      storeNodes.map((n) => {
        // Use the store position (during a drag the store isn't updated until
        // drag-stop, so there's no snap-back — and undo/load must apply their
        // restored positions). Selection is local-only, so preserve it.
        const existing = prev.find((p) => p.id === n.id);
        return {
          id: n.id,
          type: 'imageTool',
          position: n.position,
          selected: existing?.selected ?? false,
          data: {},
        };
      }),
    );
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
    for (const c of changes) {
      if (c.type === 'remove') removeNode(c.id);
      else if (c.type === 'select') selectNode(c.selected ? c.id : null);
    }
  };

  const handleEdgesChange = (changes: EdgeChange[]) => {
    onEdgesChange(changes); // keep local state (selection) in sync
    for (const c of changes) if (c.type === 'remove') removeEdge(c.id);
  };

  return (
    <div className={`canvas ${pending ? 'connecting' : ''}`}>
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodesChange={handleNodesChange}
        onNodeDragStop={(_e, node) => setNodePosition(node.id, node.position)}
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
