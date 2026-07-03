import { useEffect, useMemo } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
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
        const existing = prev.find((p) => p.id === n.id);
        return {
          id: n.id,
          type: 'imageTool',
          position: existing?.position ?? n.position,
          selected: existing?.selected ?? false,
          data: {},
        };
      }),
    );
  }, [storeNodes, setRfNodes]);

  const edges: Edge[] = useMemo(
    () =>
      storeEdges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle,
        targetHandle: e.targetHandle,
      })),
    [storeEdges],
  );

  const handleNodesChange = (changes: NodeChange<Node>[]) => {
    onNodesChange(changes); // keep local state smooth (drag, select…)
    for (const c of changes) {
      if (c.type === 'remove') removeNode(c.id);
      else if (c.type === 'select') selectNode(c.selected ? c.id : null);
    }
  };

  const onEdgesChange = (changes: EdgeChange[]) => {
    for (const c of changes) if (c.type === 'remove') removeEdge(c.id);
  };

  return (
    <div className={`canvas ${pending ? 'connecting' : ''}`}>
      <ReactFlow
        nodes={rfNodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={handleNodesChange}
        onNodeDragStop={(_e, node) => setNodePosition(node.id, node.position)}
        onEdgesChange={onEdgesChange}
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
