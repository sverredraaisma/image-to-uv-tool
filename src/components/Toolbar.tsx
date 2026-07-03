import { useMemo, useRef, useState } from 'react';
import { useStore } from '../store/store';
import { allNodeDefs } from '../engine/registry';
import { downloadText } from '../lib/download';
import { buildNodeMenu } from './nodeMenu';
import type { SavedGraph } from '../types';

function AddNodeMenu() {
  const addNode = useStore((s) => s.addNode);
  const nodeCount = useStore((s) => s.nodes.length);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const nodes = useMemo(() => allNodeDefs(), []);
  const menu = buildNodeMenu(nodes, query);

  const close = () => {
    setOpen(false);
    setQuery('');
  };
  const pick = (type: string) => {
    addNode(type, { x: 60 + (nodeCount % 8) * 34, y: 90 + (nodeCount % 8) * 34 });
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
          <div className="add-node-menu">
            <input
              className="menu-search nodrag"
              autoFocus
              placeholder="Search nodes…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') close();
                else if (e.key === 'Enter' && query.trim()) {
                  const first = menu[0]?.groups[0]?.items[0];
                  if (first) pick(first.type);
                }
              }}
            />
            {menu.length === 0 && <div className="menu-empty">No matching nodes</div>}
            {menu.map((cat) => (
              <div className="menu-group" key={cat.category}>
                <div className="menu-group-title">{cat.category}</div>
                {cat.groups.map((g) => (
                  <div key={g.group || '_'}>
                    {g.group && <div className="menu-subgroup-title">{g.group}</div>}
                    {g.items.map((item) => (
                      <button
                        key={item.type}
                        type="button"
                        className="menu-item"
                        title={item.description}
                        onClick={() => pick(item.type)}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
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
  const loadGraph = useStore((s) => s.loadGraph);
  const clearGraph = useStore((s) => s.clearGraph);
  const addToast = useStore((s) => s.addToast);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const canUndo = useStore((s) => s.history.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const fileRef = useRef<HTMLInputElement>(null);

  const onSave = () => {
    const graph = exportGraph();
    downloadText(JSON.stringify(graph, null, 2), 'node-graph.json', 'application/json');
  };

  const onLoadFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as SavedGraph;
        if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
          throw new Error('Missing nodes/edges');
        }
        loadGraph(parsed);
        addToast('success', `Loaded ${parsed.nodes.length} nodes`);
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
        <AddNodeMenu />
        <button type="button" className="btn" onClick={onSave}>
          Save
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
