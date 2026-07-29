import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../store/store';
import { platform } from '../lib/platform';
import { getNodeDefSafe } from '../engine/registry';
import { nodePorts } from '../engine/ports';
import type { ConnectionSide } from '../store/store';
import type { DataValue, PortSpec } from '../types';
import { ConfigFields } from './ConfigFields';
import { ValuePreview } from './ValuePreview';
import { nodeWidth } from './nodeLayout';

const STATUS_ICON: Record<string, { icon: string; cls: string; title: string }> = {
  outOfDate: { icon: '⚠', cls: 'status-stale', title: 'Out of date' },
  running: { icon: '◌', cls: 'status-running', title: 'Running…' },
  error: { icon: '✕', cls: 'status-error', title: 'Error' },
  upToDate: { icon: '✓', cls: 'status-ok', title: 'Up to date' },
};

export function NodeView({ id, selected }: NodeProps) {
  const node = useStore((s) => s.nodes.find((n) => n.id === id));
  const rt = useStore((s) => s.runtime[id]);
  const pending = useStore((s) => s.pendingConnection);
  const def = node ? getNodeDefSafe(node.type) : undefined;

  // Subscribe only to this node's resolved input values (via shallow compare),
  // so an unrelated node's status change doesn't re-render every node.
  const inputValues = useStore(
    useShallow((s) => {
      const map: Record<string, DataValue | undefined> = {};
      const nd = s.nodes.find((n) => n.id === id);
      if (nd && def) {
        for (const port of nodePorts(nd, def).inputs) {
          const edge = s.edges.find((e) => e.target === id && e.targetHandle === port.id);
          map[port.id] = edge ? s.runtime[edge.source]?.outputs?.[edge.sourceHandle] : undefined;
        }
      }
      return map;
    }),
  );

  const clickPort = useStore((s) => s.clickPort);
  const runNode = useStore((s) => s.runNode);
  const cancelNode = useStore((s) => s.cancelNode);
  const bringUpToDate = useStore((s) => s.bringUpToDate);
  const duplicateNode = useStore((s) => s.duplicateNode);
  const toggleBypass = useStore((s) => s.toggleBypass);
  const removeNode = useStore((s) => s.removeNode);
  const openEditor = useStore((s) => s.openEditor);
  const openHelp = useStore((s) => s.openHelp);
  const openPreview = useStore((s) => s.openPreview);
  const requestPreview = useStore((s) => s.requestPreview);
  const updateNodeConfig = useStore((s) => s.updateNodeConfig);
  const enterPipeline = useStore((s) => s.enterPipeline);
  const editingPipeline = useStore((s) => s.editStack.length > 0);
  const addToast = useStore((s) => s.addToast);

  if (!node || !def) {
    return (
      <div className="node node-error">
        <div className="node-header">Unknown node</div>
      </div>
    );
  }

  const status = rt?.status ?? 'outOfDate';
  const statusMeta = STATUS_ICON[status];
  const ports = nodePorts(node, def);
  const inlineFields = (def.configFields ?? []).filter((f) => !f.advanced);
  const hasPopup = (def.configFields ?? []).some((f) => f.advanced) || !!def.customEditor;

  // The two nodes whose source is an uploaded file rather than a config value.
  const upload =
    node.type === 'imageInput'
      ? { accept: 'image/*', label: 'Upload image…' }
      : node.type === 'animationInput'
        ? { accept: 'image/gif,image/webp,image/apng,image/png,image/*', label: 'Upload animation…' }
        : null;

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

  const renderInput = (port: PortSpec) => {
    const inlineText = port.type === 'text' ? String(node.config[port.id] ?? '') : '';
    const missing = port.required && inputValues[port.id] === undefined && inlineText.length === 0;
    return (
      <div
        className={`${portClass('input', port.id)}${missing ? ' port-required-missing' : ''}`}
        key={port.id}
      >
        <Handle type="target" position={Position.Left} id={port.id} className="rf-handle" />
        <ValuePreview
          value={inputValues[port.id]}
          onClick={() =>
            inputValues[port.id] && openPreview(inputValues[port.id]!, `${def.label} · ${port.label}`)
          }
        />
        <span className="port-label" onClick={() => clickPort(id, port.id, 'input')} title="Click to connect">
          {port.label}
          {port.required && (
            <span className="port-required" title="Required input">
              {' '}
              *
            </span>
          )}
        </span>
      </div>
    );
  };

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
          renderable
          onClick={() => void requestPreview(id, port.id, `${def.label} · ${port.label}`)}
        />
        <Handle type="source" position={Position.Right} id={port.id} className="rf-handle" />
      </div>
    );
  };

  return (
    <div
      className={`node cat-${def.category.replace(/\W+/g, '')} ${selected ? 'node-selected' : ''} ${
        node.bypassed ? 'node-bypassed' : ''
      }`}
      style={{
        width: nodeWidth({ inputs: ports.inputs, outputs: ports.outputs, configFields: def.configFields }),
      }}
    >
      <div className="node-header">
        <span className={`status-icon ${statusMeta.cls}`} title={rt?.error ?? statusMeta.title}>
          {statusMeta.icon}
        </span>
        <span className="node-title">{def.label}</span>
        {def.genAI && (
          <span className="genai-badge" title="Generative AI node">
            ✦
          </span>
        )}
        <span className="node-actions">
          <button
            type="button"
            className="icon-btn"
            title="What is this node for?"
            aria-label={`What is ${def.label} for?`}
            onClick={() => openHelp(node.type)}
          >
            ?
          </button>
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
            className={`icon-btn ${node.bypassed ? 'icon-active' : ''}`}
            title={node.bypassed ? 'Un-mute node' : 'Mute (bypass) node'}
            aria-pressed={node.bypassed ? true : false}
            onClick={() => toggleBypass(id)}
          >
            ⏻
          </button>
          <button type="button" className="icon-btn" title="Duplicate node" onClick={() => duplicateNode(id)}>
            ⧉
          </button>
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
        {upload && (
          <div className="image-upload nodrag">
            <label className="upload-btn">
              {String(node.config.name || '') || upload.label}
              <input
                type="file"
                accept={upload.accept}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const reader = new FileReader();
                  reader.onload = async () => {
                    const dataUrl = reader.result as string;
                    // Offload the (large) bytes to the blob store and keep only a
                    // short reference in the graph, so localStorage isn't the cap.
                    // Fall back to inline bytes if the blob store is unavailable.
                    try {
                      const ref = await platform.putBlob(dataUrl);
                      updateNodeConfig(id, { srcRef: ref, src: '', name: file.name });
                    } catch {
                      updateNodeConfig(id, { src: dataUrl, srcRef: '', name: file.name });
                    }
                  };
                  reader.onerror = () => addToast('error', `Could not read ${file.name}`);
                  reader.readAsDataURL(file);
                }}
              />
            </label>
          </div>
        )}

        {inlineFields.length > 0 && <ConfigFields nodeId={id} fields={inlineFields} config={node.config} />}

        {def.customEditor && (
          <button type="button" className="wide-btn nodrag" onClick={() => openEditor(id)}>
            Open editor…
          </button>
        )}

        {node.type === 'pipeline' && (
          <button
            type="button"
            className="wide-btn nodrag"
            title={editingPipeline ? 'Close the current pipeline first' : 'Edit the nodes inside'}
            disabled={editingPipeline}
            onClick={() => enterPipeline(id)}
          >
            Open pipeline ▸
          </button>
        )}

        {!def.autoRun &&
          !node.bypassed &&
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
        {rt?.error && (
          <div className="node-error-msg" title={rt.error}>
            {rt.error}
          </div>
        )}
      </div>

      <div className="node-ports">
        <div className="ports-in">{ports.inputs.map(renderInput)}</div>
        <div className="ports-out">{ports.outputs.map(renderOutput)}</div>
      </div>
    </div>
  );
}
