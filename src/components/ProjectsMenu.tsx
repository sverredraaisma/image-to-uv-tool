import { useState } from 'react';
import { useStore } from '../store/store';
import { projectStore } from '../lib/projectStore';

/** Named-project picker: save the current workspace under a name, reopen or
 *  delete saved projects. Snapshots live in IndexedDB (see projectStore). */
export function ProjectsMenu() {
  const exportGraph = useStore((s) => s.exportGraph);
  const loadGraph = useStore((s) => s.loadGraph);
  const addToast = useStore((s) => s.addToast);

  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<string[]>([]);

  const refresh = () => {
    projectStore
      .list()
      .then(setProjects)
      .catch(() => setProjects([]));
  };

  const toggle = () => {
    if (!open) refresh();
    setOpen((o) => !o);
  };

  const saveAs = async () => {
    const name = window.prompt('Save project as:')?.trim();
    if (!name) return;
    try {
      await projectStore.save(name, exportGraph());
      addToast('success', `Saved project “${name}”`);
      refresh();
    } catch (e) {
      addToast('error', `Save failed: ${e instanceof Error ? e.message : e}`);
    }
  };

  const openProject = async (name: string) => {
    try {
      const graph = await projectStore.load(name);
      if (!graph) return addToast('error', `Project “${name}” not found`);
      loadGraph(graph);
      addToast('success', `Opened “${name}”`);
      setOpen(false);
    } catch (e) {
      addToast('error', `Open failed: ${e instanceof Error ? e.message : e}`);
    }
  };

  const remove = async (name: string) => {
    if (!window.confirm(`Delete project “${name}”?`)) return;
    await projectStore.remove(name).catch(() => {});
    refresh();
  };

  return (
    <div className="add-node">
      <button type="button" className="btn" onClick={toggle} title="Saved projects">
        Projects ▾
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onClick={() => setOpen(false)} />
          <div className="add-node-menu projects-menu">
            <button type="button" className="menu-item" onClick={() => void saveAs()}>
              + Save current as…
            </button>
            {projects.length === 0 && <div className="menu-empty">No saved projects</div>}
            {projects.map((name) => (
              <div className="project-row" key={name}>
                <button
                  type="button"
                  className="menu-item project-open"
                  onClick={() => void openProject(name)}
                >
                  {name}
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
    </div>
  );
}
