import { useMemo, useRef, useState } from 'react';
import { useStore } from '../store/store';
import { allNodeDefs } from '../engine/registry';
import { downloadText } from '../lib/download';
import type { SavedGraph } from '../types';

// Menus present categories and AI capability groups in a deliberate order
// rather than registration order.
const CATEGORY_ORDER = ['Input', 'Compose', 'Adjust', 'Transform', 'Mask', 'Export', 'AI (Replicate)', 'AI (OpenRouter)'];
const GROUP_ORDER = ['Generate', 'Segment', 'Depth', 'Background removal', 'Restore & upscale', 'Describe', 'Custom'];
const rank = (order: string[], v: string) => {
  const i = order.indexOf(v);
  return i < 0 ? order.length : i;
};

interface MenuItem {
  type: string;
  label: string;
  description?: string;
  category: string;
  group: string;
}

function AddNodeMenu() {
  const addNode = useStore((s) => s.addNode);
  const nodeCount = useStore((s) => s.nodes.length);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const items = useMemo<MenuItem[]>(
    () =>
      allNodeDefs()
        .filter((d) => !d.type.startsWith('test.'))
        .map((d) => ({
          type: d.type,
          label: d.label,
          description: d.description,
          category: d.category,
          group: d.group ?? '',
        })),
    [],
  );

  const q = query.trim().toLowerCase();
  const filtered = q
    ? items.filter((i) =>
        `${i.label} ${i.description ?? ''} ${i.category} ${i.group}`.toLowerCase().includes(q),
      )
    : items;

  const categories = [...new Set(filtered.map((i) => i.category))].sort(
    (a, b) => rank(CATEGORY_ORDER, a) - rank(CATEGORY_ORDER, b) || a.localeCompare(b),
  );

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
            />
            {categories.length === 0 && <div className="menu-empty">No matching nodes</div>}
            {categories.map((category) => {
              const catItems = filtered.filter((i) => i.category === category);
              const groups = [...new Set(catItems.map((i) => i.group))].sort(
                (a, b) => rank(GROUP_ORDER, a) - rank(GROUP_ORDER, b) || a.localeCompare(b),
              );
              return (
                <div className="menu-group" key={category}>
                  <div className="menu-group-title">{category}</div>
                  {groups.map((group) => (
                    <div key={group || '_'}>
                      {group && <div className="menu-subgroup-title">{group}</div>}
                      {catItems
                        .filter((i) => i.group === group)
                        .sort((a, b) => a.label.localeCompare(b.label))
                        .map((item) => (
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
              );
            })}
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
