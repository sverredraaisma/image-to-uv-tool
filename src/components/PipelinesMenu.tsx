import { useRef, useState } from 'react';
import { useStore } from '../store/store';
import { pipelineLibrary, isSavedPipeline, type SavedPipeline } from '../lib/pipelineLibrary';
import { downloadText } from '../lib/download';

/** Reusable-pipeline library: save the pipeline you're editing (or a selected
 *  pipeline node) to the browser or a file, and drop saved ones onto the canvas. */
export function PipelinesMenu() {
  const buildSavedPipeline = useStore((s) => s.buildSavedPipeline);
  const insertSavedPipeline = useStore((s) => s.insertSavedPipeline);
  const addToast = useStore((s) => s.addToast);
  const defaultName = useStore((s) => {
    if (s.editStack.length) {
      const f = s.editStack[s.editStack.length - 1];
      return (f.nodes.find((n) => n.id === f.pipelineNodeId)?.config.name as string) || '';
    }
    const n = s.selectedNodeId ? s.nodes.find((n) => n.id === s.selectedNodeId) : undefined;
    return n?.type === 'pipeline' ? (n.config.name as string) || '' : '';
  });

  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = () => pipelineLibrary.list().then(setSaved).catch(() => setSaved([]));
  const toggle = () => {
    if (!open) refresh();
    setOpen((o) => !o);
  };

  const build = (): SavedPipeline | null => {
    const name = window.prompt('Pipeline name:', defaultName)?.trim();
    if (!name) return null;
    const p = buildSavedPipeline(name);
    if (!p) addToast('error', 'Open a pipeline (or select a pipeline node) first');
    return p;
  };

  const saveToBrowser = async () => {
    const p = build();
    if (!p) return;
    try {
      await pipelineLibrary.save(p);
      addToast('success', `Saved pipeline “${p.name}”`);
      refresh();
    } catch (e) {
      addToast('error', `Save failed: ${e instanceof Error ? e.message : e}`);
    }
  };

  const saveToFile = () => {
    const p = build();
    if (!p) return;
    downloadText(JSON.stringify(p, null, 2), `${p.name}.pipeline.json`, 'application/json');
  };

  const insert = async (name: string) => {
    try {
      const p = await pipelineLibrary.load(name);
      if (!p) return addToast('error', `Pipeline “${name}” not found`);
      insertSavedPipeline(p);
      addToast('success', `Added pipeline “${name}”`);
      setOpen(false);
    } catch (e) {
      addToast('error', `Load failed: ${e instanceof Error ? e.message : e}`);
    }
  };

  const download = async (name: string) => {
    const p = await pipelineLibrary.load(name).catch(() => null);
    if (p) downloadText(JSON.stringify(p, null, 2), `${p.name}.pipeline.json`, 'application/json');
  };

  const remove = async (name: string) => {
    if (!window.confirm(`Delete pipeline “${name}”?`)) return;
    await pipelineLibrary.remove(name).catch(() => {});
    refresh();
  };

  const importFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        if (!isSavedPipeline(parsed)) throw new Error('Not a pipeline file');
        insertSavedPipeline(parsed);
        addToast('success', `Added pipeline “${parsed.name}”`);
        setOpen(false);
      } catch (e) {
        addToast('error', `Invalid pipeline file: ${e instanceof Error ? e.message : e}`);
      }
    };
    reader.readAsText(file);
  };

  return (
    <div className="add-node">
      <button type="button" className="btn" onClick={toggle} title="Reusable pipelines">
        Pipelines ▾
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onClick={() => setOpen(false)} />
          <div className="add-node-menu projects-menu">
            <button type="button" className="menu-item" onClick={() => void saveToBrowser()}>
              + Save current to browser…
            </button>
            <button type="button" className="menu-item" onClick={saveToFile}>
              ⭳ Save current to file…
            </button>
            <button type="button" className="menu-item" onClick={() => fileRef.current?.click()}>
              ⭱ Import from file…
            </button>
            <div className="menu-subgroup-title">Saved</div>
            {saved.length === 0 && <div className="menu-empty">No saved pipelines</div>}
            {saved.map((name) => (
              <div className="project-row" key={name}>
                <button type="button" className="menu-item project-open" onClick={() => void insert(name)}>
                  {name}
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  title={`Download ${name}`}
                  onClick={() => void download(name)}
                >
                  ⭳
                </button>
                <button
                  type="button"
                  className="icon-btn icon-danger"
                  title={`Delete ${name}`}
                  onClick={() => void remove(name)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </>
      )}
      <input
        ref={fileRef}
        type="file"
        aria-label="Import pipeline file"
        accept="application/json,.json"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) importFile(file);
          e.target.value = '';
        }}
      />
    </div>
  );
}
