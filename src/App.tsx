import { useEffect } from 'react';
import { Toolbar } from './components/Toolbar';
import { Canvas } from './components/Canvas';
import { PreviewModal } from './components/PreviewModal';
import { SettingsModal } from './components/SettingsModal';
import { Toasts } from './components/Toasts';
import { escapeTarget, handleShortcut, type ShortcutEvent } from './components/keyboard';
import { decodeGraphFromHash } from './lib/shareLink';
import { useStore } from './store/store';

export default function App() {
  // Load a shared workflow from the URL hash (#g=…) once on startup.
  useEffect(() => {
    const match = /[#&]g=([^&]+)/.exec(window.location.hash);
    if (!match) return;
    const graph = decodeGraphFromHash(match[1]);
    if (graph) {
      useStore.getState().loadGraph(graph);
      useStore.getState().addToast('success', 'Loaded shared workflow from link');
    }
    // Clear the hash so a refresh doesn't reload / clobber the user's edits.
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      if (e.key === 'Escape') {
        const target = escapeTarget({
          hasPreview: !!s.preview,
          hasEditor: !!s.editorNodeId,
          hasPending: !!s.pendingConnection,
        });
        if (target === 'preview') s.closePreview();
        else if (target === 'editor') s.openEditor(null);
        else if (target === 'pending') s.cancelPendingConnection();
        if (target) e.preventDefault();
        return;
      }
      const handled = handleShortcut(e as unknown as ShortcutEvent, {
        undo: s.undo,
        redo: s.redo,
        duplicateSelected: () => {
          const ids = s.selectedNodeIds.length
            ? s.selectedNodeIds
            : s.selectedNodeId
              ? [s.selectedNodeId]
              : [];
          if (ids.length) s.duplicateNodes(ids);
        },
        copy: s.copySelection,
        paste: s.paste,
      });
      if (handled) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="app">
      <Toolbar />
      <main className="workspace">
        <Canvas />
      </main>
      <PreviewModal />
      <SettingsModal />
      <Toasts />
    </div>
  );
}
