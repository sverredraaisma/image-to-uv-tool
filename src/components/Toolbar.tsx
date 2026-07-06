import { useRef, useState } from 'react';
import { useStore } from '../store/store';
import { downloadText, graphFileName } from '../lib/download';
import { encodeGraphToHash } from '../lib/shareLink';
import { NodePicker } from './NodePicker';
import { ProjectsMenu } from './ProjectsMenu';
import { EXAMPLES, type Example } from './examples';
import type { SavedGraph } from '../types';

function AddNodeMenu() {
  const addNode = useStore((s) => s.addNode);
  const [open, setOpen] = useState(false);

  const close = () => setOpen(false);
  const pick = (type: string) => {
    // No position → the store drops it at the current viewport centre.
    addNode(type);
    close();
  };

  return (
    <div className="add-node">
      <button type="button" className="btn btn-primary" onClick={() => setOpen((o) => !o)}>
        + Add node
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onClick={close} />
          <NodePicker onPick={pick} onClose={close} />
        </>
      )}
    </div>
  );
}

function ExamplesMenu() {
  const loadGraph = useStore((s) => s.loadGraph);
  const nodeCount = useStore((s) => s.nodes.length);
  const [open, setOpen] = useState(false);

  const close = () => setOpen(false);
  const pick = (ex: Example) => {
    // Loading replaces the whole graph — confirm first if there's work to lose.
    if (nodeCount > 0 && !confirm(`Replace the current workspace with “${ex.name}”?`)) return;
    loadGraph(ex.graph);
    close();
  };

  return (
    <div className="add-node">
      <button
        type="button"
        className="btn"
        onClick={() => setOpen((o) => !o)}
        title="Load an example workflow"
      >
        Examples ▾
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onClick={close} />
          <div className="add-node-menu" role="menu">
            {EXAMPLES.map((ex) => (
              <button
                key={ex.name}
                type="button"
                className="menu-item"
                title={ex.description}
                onClick={() => pick(ex)}
              >
                {ex.name}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function Toolbar() {
  const apiKey = useStore((s) => s.apiKey);
  const openRouterKey = useStore((s) => s.openRouterKey);
  const proxyUrl = useStore((s) => s.proxyUrl);
  const setApiKey = useStore((s) => s.setApiKey);
  const setOpenRouterKey = useStore((s) => s.setOpenRouterKey);
  const setProxyUrl = useStore((s) => s.setProxyUrl);
  const exportGraph = useStore((s) => s.exportGraph);
  const exportGraphInlined = useStore((s) => s.exportGraphInlined);
  const loadGraph = useStore((s) => s.loadGraph);
  const clearGraph = useStore((s) => s.clearGraph);
  const autoFormat = useStore((s) => s.autoFormat);
  const nodeCount = useStore((s) => s.nodes.length);
  const addToast = useStore((s) => s.addToast);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const canUndo = useStore((s) => s.history.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const showGenAI = useStore((s) => s.showGenAI);
  const setShowGenAI = useStore((s) => s.setShowGenAI);
  const fileRef = useRef<HTMLInputElement>(null);

  const onSave = async () => {
    try {
      // Inline blob-referenced images so the file is portable to another machine.
      const graph = await exportGraphInlined();
      // timestamped so repeated saves don't collide in the downloads folder
      downloadText(JSON.stringify(graph, null, 2), graphFileName(new Date()), 'application/json');
    } catch (err) {
      addToast('error', `Save failed: ${err instanceof Error ? err.message : err}`);
    }
  };

  const onShare = async () => {
    const hash = encodeGraphToHash(exportGraph());
    const url = `${location.origin}${location.pathname}#g=${hash}`;
    try {
      await navigator.clipboard.writeText(url);
      addToast('success', 'Share link copied (workflow only — images are not included)');
    } catch {
      addToast('info', url); // clipboard blocked — show the link to copy manually
    }
  };

  const onLoadFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as SavedGraph;
        if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
          throw new Error('Missing nodes/edges');
        }
        const requested = parsed.nodes.length;
        loadGraph(parsed);
        const loaded = useStore.getState().nodes.length;
        const dropped = requested - loaded;
        addToast(
          'success',
          dropped > 0 ? `Loaded ${loaded} nodes (${dropped} invalid dropped)` : `Loaded ${loaded} nodes`,
        );
      } catch (err) {
        addToast('error', `Invalid graph file: ${err instanceof Error ? err.message : err}`);
      }
    };
    reader.readAsText(file);
  };

  return (
    <header className="toolbar">
      <div className="toolbar-left">
        <span className="app-title">Node Image Tool</span>
        <label className="field">
          <span>Replicate API key</span>
          <input
            type="password"
            placeholder="r8_…"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </label>
        <label className="field field-sm">
          <span>OpenRouter API key</span>
          <input
            type="password"
            placeholder="sk-or-…"
            value={openRouterKey}
            onChange={(e) => setOpenRouterKey(e.target.value)}
          />
        </label>
        <label className="field field-sm">
          <span>Proxy URL (optional)</span>
          <input
            type="text"
            placeholder="https://your-cors-proxy/v1"
            value={proxyUrl}
            onChange={(e) => setProxyUrl(e.target.value)}
          />
        </label>
      </div>

      <div className="toolbar-right">
        <button type="button" className="btn" onClick={undo} disabled={!canUndo} title="Undo">
          ↶
        </button>
        <button type="button" className="btn" onClick={redo} disabled={!canRedo} title="Redo">
          ↷
        </button>
        <button
          type="button"
          className={`btn btn-toggle ${showGenAI ? 'btn-toggle-on' : ''}`}
          onClick={() => setShowGenAI(!showGenAI)}
          aria-pressed={showGenAI}
          title={
            showGenAI
              ? 'Generative AI nodes are shown — click to hide them'
              : 'Generative AI nodes are hidden — click to show them'
          }
        >
          <span className="genai-badge" aria-hidden="true">
            ✦
          </span>
          Gen AI {showGenAI ? 'on' : 'off'}
        </button>
        <AddNodeMenu />
        <button
          type="button"
          className="btn"
          onClick={autoFormat}
          disabled={nodeCount === 0}
          title="Arrange all nodes tidily based on their connections"
        >
          Auto-format
        </button>
        <ExamplesMenu />
        <ProjectsMenu />
        <button type="button" className="btn" onClick={() => void onSave()}>
          Save
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => void onShare()}
          title="Copy a link to this workflow"
        >
          Share
        </button>
        <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
          Load
        </button>
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => {
            if (confirm('Clear the whole workspace?')) clearGraph();
          }}
        >
          Clear
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onLoadFile(file);
            e.target.value = '';
          }}
        />
      </div>
    </header>
  );
}
