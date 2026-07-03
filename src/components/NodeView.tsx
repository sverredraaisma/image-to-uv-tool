import { useMemo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useStore } from '../store/store';
import { getNodeDefSafe } from '../engine/registry';
import type { ConnectionSide } from '../store/store';
import type { DataValue, NodeDefinition, PortSpec } from '../types';
import { ConfigFields } from './ConfigFields';
import { ValuePreview } from './ValuePreview';

const STATUS_ICON: Record<string, { icon: string; cls: string; title: string }> = {
  outOfDate: { icon: '⚠', cls: 'status-stale', title: 'Out of date' },
  running: { icon: '◌', cls: 'status-running', title: 'Running…' },
  error: { icon: '✕', cls: 'status-error', title: 'Error' },
  upToDate: { icon: '✓', cls: 'status-ok', title: 'Up to date' },
};

/**
 * Pick a comfortable node width from its content: the longest port label (which
 * sits next to a fixed-size preview) and the longest inline field label, with a
 * little extra room for multiline text fields. Simple nodes stay compact; busy
 * ones (many outputs, prompt fields) grow up to a cap.
 */
function nodeWidth(def: NodeDefinition): number {
  const longestPort = [...def.inputs, ...def.outputs].reduce((m, p) => Math.max(m, p.label.length), 0);
  const fields = (def.configFields ?? []).filter((f) => !f.advanced);
  const longestField = fields.reduce((m, f) => Math.max(m, f.label.length), 0);
  const hasMultiline = fields.some((f) => f.kind === 'text' && f.multiline);
  const portW = longestPort * 6.6 + 46 /* preview */ + 46 /* handle + gaps */;
  const fieldW = longestField * 6.6 + 132 /* control + padding */;
  const width = Math.max(214, portW, fieldW, hasMultiline ? 250 : 0);
  return Math.round(Math.min(320, width));
}

export function NodeView({ id, selected }: NodeProps) {
  const node = useStore((s) => s.nodes.find((n) => n.id === id));
  const rt = useStore((s) => s.runtime[id]);
  const edges = useStore((s) => s.edges);
  const runtime = useStore((s) => s.runtime);
  const pending = useStore((s) => s.pendingConnection);

  const clickPort = useStore((s) => s.clickPort);
  const runNode = useStore((s) => s.runNode);
  const cancelNode = useStore((s) => s.cancelNode);
  const bringUpToDate = useStore((s) => s.bringUpToDate);
  const removeNode = useStore((s) => s.removeNode);
  const openEditor = useStore((s) => s.openEditor);
  const openPreview = useStore((s) => s.openPreview);
  const updateNodeConfig = useStore((s) => s.updateNodeConfig);

  const def = node ? getNodeDefSafe(node.type) : undefined;

  const inputValues = useMemo(() => {
    const map: Record<string, DataValue | undefined> = {};
    if (!def) return map;
    for (const port of def.inputs) {
      const edge = edges.find((e) => e.target === id && e.targetHandle === port.id);
      map[port.id] = edge ? runtime[edge.source]?.outputs?.[edge.sourceHandle] : undefined;
    }
    return map;
  }, [def, edges, runtime, id]);

  if (!node || !def) {
    return (
      <div className="node node-error">
        <div className="node-header">Unknown node</div>
      </div>
    );
  }

  const status = rt?.status ?? 'outOfDate';
  const statusMeta = STATUS_ICON[status];
  const inlineFields = (def.configFields ?? []).filter((f) => !f.advanced);
  const hasPopup = (def.configFields ?? []).some((f) => f.advanced) || !!def.customEditor;

  const portClass = (side: ConnectionSide, portId: string) => {
    let cls = `port port-${side}`;
    if (pending) {
      if (pending.nodeId === id && pending.portId === portId && pending.side === side) {
        cls += ' port-pending';
      } else if (pending.side !== side) {
        cls += ' port-candidate';
      }
    }
    return cls;
  };

  const renderInput = (port: PortSpec) => (
    <div className={portClass('input', port.id)} key={port.id}>
      <Handle type="target" position={Position.Left} id={port.id} className="rf-handle" />
      <ValuePreview
        value={inputValues[port.id]}
        onClick={() => inputValues[port.id] && openPreview(inputValues[port.id]!, `${def.label} · ${port.label}`)}
      />
      <span
        className="port-label"
        onClick={() => clickPort(id, port.id, 'input')}
        title="Click to connect"
      >
        {port.label}
      </span>
    </div>
  );

  const renderOutput = (port: PortSpec) => {
    const value = rt?.outputs?.[port.id];
    return (
      <div className={portClass('output', port.id)} key={port.id}>
        <span
          className="port-label"
          onClick={() => clickPort(id, port.id, 'output')}
          title="Click to connect"
        >
          {port.label}
        </span>
        <ValuePreview
          value={value}
          onClick={() => value && openPreview(value, `${def.label} · ${port.label}`)}
        />
        <Handle type="source" position={Position.Right} id={port.id} className="rf-handle" />
      </div>
    );
  };

  return (
    <div
      className={`node cat-${def.category.replace(/\W+/g, '')} ${selected ? 'node-selected' : ''}`}
      style={{ width: nodeWidth(def) }}
    >
      <div className="node-header">
        <span className={`status-icon ${statusMeta.cls}`} title={rt?.error ?? statusMeta.title}>
          {statusMeta.icon}
        </span>
        <span className="node-title">{def.label}</span>
        <span className="node-actions">
          <button
            type="button"
            className="icon-btn"
            title="Bring up to date"
            onClick={() => bringUpToDate(id)}
          >
            ⟳
          </button>
          {hasPopup && (
            <button type="button" className="icon-btn" title="Settings" onClick={() => openEditor(id)}>
              ⚙
            </button>
          )}
          <button
            type="button"
            className="icon-btn icon-danger"
            title="Delete node"
            onClick={() => removeNode(id)}
          >
            ✕
          </button>
        </span>
      </div>

      <div className="node-body">
        {node.type === 'imageInput' && (
          <div className="image-upload nodrag">
            <label className="upload-btn">
              {String(node.config.name || '') || 'Upload image…'}
              <input
                type="file"
                accept="image/*"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const reader = new FileReader();
                  reader.onload = () =>
                    updateNodeConfig(id, { src: reader.result as string, name: file.name });
                  reader.readAsDataURL(file);
                }}
              />
            </label>
          </div>
        )}

        {inlineFields.length > 0 && (
          <ConfigFields nodeId={id} fields={inlineFields} config={node.config} />
        )}

        {def.customEditor && (
          <button type="button" className="wide-btn nodrag" onClick={() => openEditor(id)}>
            Open editor…
          </button>
        )}

        {!def.autoRun &&
          (status === 'running' ? (
            <button type="button" className="wide-btn cancel-btn nodrag" onClick={() => cancelNode(id)}>
              Cancel ✕
            </button>
          ) : (
            <button type="button" className="wide-btn run-btn nodrag" onClick={() => runNode(id)}>
              Run ▶
            </button>
          ))}

        {rt?.progress && <div className="node-progress">{rt.progress}</div>}
        {rt?.error && <div className="node-error-msg" title={rt.error}>{rt.error}</div>}
      </div>

      <div className="node-ports">
        <div className="ports-in">{def.inputs.map(renderInput)}</div>
        <div className="ports-out">{def.outputs.map(renderOutput)}</div>
      </div>
    </div>
  );
}
