import { useEffect, useRef, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Node,
  type Edge,
  type Connection,
  type NodeChange,
  type EdgeChange,
} from '@xyflow/react';
import { useStore } from '../store/store';
import { platform } from '../lib/platform';
import { NodeView } from './NodeView';
import { NodePicker } from './NodePicker';
import { EXAMPLES } from './examples';

const nodeTypes = { imageTool: NodeView };

// A single shared, stable `data` object for every node. NodeView reads
// everything it needs from the store by id, so the React Flow node carries no
// per-node data — a fresh `{}` each sync would break React Flow's per-node
// memoisation and re-render every NodeView on any change (H3).
const NODE_DATA = {} as const;

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function FlowCanvas() {
  const storeNodes = useStore((s) => s.nodes);
  const storeEdges = useStore((s) => s.edges);
  const pending = useStore((s) => s.pendingConnection);
  const setNodePositions = useStore((s) => s.setNodePositions);
  const removeNodes = useStore((s) => s.removeNodes);
  const removeEdge = useStore((s) => s.removeEdge);
  const selectNode = useStore((s) => s.selectNode);
  const setSelection = useStore((s) => s.setSelection);
  const pendingSelectIds = useStore((s) => s.pendingSelectIds);
  const clearPendingSelect = useStore((s) => s.clearPendingSelect);
  const setViewportCenter = useStore((s) => s.setViewportCenter);
  const addNode = useStore((s) => s.addNode);
  const updateNodeConfig = useStore((s) => s.updateNodeConfig);
  const loadGraph = useStore((s) => s.loadGraph);
  const addConnection = useStore((s) => s.addConnection);
  const canConnect = useStore((s) => s.canConnect);
  const cancelPending = useStore((s) => s.cancelPendingConnection);
  const addToast = useStore((s) => s.addToast);

  const { screenToFlowPosition, fitView } = useReactFlow();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const arrangeNonce = useStore((s) => s.arrangeNonce);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  // Expose the current viewport centre (in flow coords) so the toolbar's
  // "Add node" menu — which lives outside the React Flow provider — can drop a
  // node where the user is actually looking. The small offset roughly centres
  // the node body rather than its top-left corner.
  useEffect(() => {
    setViewportCenter(() => {
      const rect = wrapperRef.current?.getBoundingClientRect();
      if (!rect) return { x: 120, y: 120 };
      const p = screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      return { x: p.x - 110, y: p.y - 40 };
    });
    return () => setViewportCenter(null);
  }, [screenToFlowPosition, setViewportCenter]);

  // Nodes live in local React Flow state for smooth dragging; only the final
  // dropped position is written back to the (persisted) store.
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node>([]);

  useEffect(() => {
    setRfNodes((prev) => {
      const prevById = new Map(prev.map((p) => [p.id, p]));
      return storeNodes.map((n) => {
        // Preserve the existing React Flow node object (identity) when nothing
        // this layer cares about changed, so a config keystroke on one node
        // doesn't re-render every other node.
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

  // Edges also live in local state so React Flow can track their selection.
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

  // After an auto-format, wait a frame for React Flow to ingest the new node
  // positions, then fit the whole graph into view so the user sees the result.
  useEffect(() => {
    if (!arrangeNonce) return;
    const raf = requestAnimationFrame(() => void fitView({ padding: 0.2, duration: 400 }));
    return () => cancelAnimationFrame(raf);
  }, [arrangeNonce, fitView]);

  // One-shot: select exactly the nodes the store just asked for (a freshly
  // added / duplicated / pasted node), deselecting the rest, then clear the
  // request. Runs after the storeNodes sync above, so the new node already
  // exists in rfNodes by the time this maps over it.
  useEffect(() => {
    if (!pendingSelectIds.length) return;
    const want = new Set(pendingSelectIds);
    setRfNodes((prev) =>
      prev.map((n) => {
        const sel = want.has(n.id);
        return n.selected === sel ? n : { ...n, selected: sel };
      }),
    );
    setSelection(pendingSelectIds);
    clearPendingSelect();
  }, [pendingSelectIds, setRfNodes, setSelection, clearPendingSelect]);

  const handleNodesChange = (changes: NodeChange<Node>[]) => {
    onNodesChange(changes); // keep local state smooth (drag, select…)
    // Batch a multi-selection delete into one store mutation (single undo step).
    const removed = changes.filter((c) => c.type === 'remove').map((c) => c.id);
    if (removed.length) removeNodes(removed);
  };

  const handleEdgesChange = (changes: EdgeChange[]) => {
    onEdgesChange(changes); // keep local state (selection) in sync
    for (const c of changes) if (c.type === 'remove') removeEdge(c.id);
  };

  // Drag an image file onto the canvas → create an Image Input node there.
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    const file = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith('image/'));
    if (!file) return;
    const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const id = addNode('imageInput', position);
    try {
      const dataUrl = await readFileAsDataUrl(file);
      try {
        const ref = await platform.putBlob(dataUrl);
        updateNodeConfig(id, { srcRef: ref, src: '', name: file.name });
      } catch {
        updateNodeConfig(id, { src: dataUrl, srcRef: '', name: file.name });
      }
    } catch (err) {
      addToast('error', err instanceof Error ? err.message : 'Could not read the dropped file');
    }
  };

  const addAtMenu = (type: string) => {
    if (menu) addNode(type, screenToFlowPosition({ x: menu.x, y: menu.y }));
    setMenu(null);
  };

  return (
    <div
      ref={wrapperRef}
      className={`canvas ${pending ? 'connecting' : ''}`}
      onDrop={(e) => void onDrop(e)}
      onDragOver={(e) => e.preventDefault()}
    >
      {storeNodes.length === 0 && (
        <div className="canvas-empty">
          <div className="canvas-empty-card">
            <div className="canvas-empty-title">Start building</div>
            <div>Add a node from the top-right menu (or right-click), then wire outputs into inputs.</div>
            <div className="canvas-empty-sub">
              Drag an image file onto the canvas, and paste your Replicate / OpenRouter key (top-left) for the
              AI nodes.
            </div>
            <div className="canvas-empty-examples">
              <span className="canvas-empty-examples-label">Or load an example:</span>
              {EXAMPLES.map((ex) => (
                <button
                  key={ex.name}
                  type="button"
                  className="btn"
                  title={ex.description}
                  onClick={() => loadGraph(ex.graph)}
                >
                  {ex.name}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodesChange={handleNodesChange}
        onSelectionChange={({ nodes }) => setSelection(nodes.map((n) => n.id))}
        onNodeDragStop={(_e, node, nodes) => {
          const dragged = nodes?.length ? nodes : [node];
          setNodePositions(dragged.map((d) => ({ id: d.id, position: d.position })));
        }}
        onEdgesChange={handleEdgesChange}
        onConnect={(c: Connection) => addConnection(c)}
        isValidConnection={(c) => canConnect(c as Connection)}
        onPaneClick={() => {
          cancelPending();
          selectNode(null);
          setMenu(null);
        }}
        onPaneContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: (e as React.MouseEvent).clientX, y: (e as React.MouseEvent).clientY });
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
      {menu && (
        <>
          <div className="menu-backdrop" onClick={() => setMenu(null)} />
          <div className="context-menu" style={{ left: menu.x, top: menu.y }}>
            <NodePicker onPick={addAtMenu} onClose={() => setMenu(null)} />
          </div>
        </>
      )}
    </div>
  );
}

export function Canvas() {
  return (
    <ReactFlowProvider>
      <FlowCanvas />
    </ReactFlowProvider>
  );
}
