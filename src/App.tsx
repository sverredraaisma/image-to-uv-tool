import { useEffect } from 'react';
import { Toolbar } from './components/Toolbar';
import { Canvas } from './components/Canvas';
import { PreviewModal } from './components/PreviewModal';
import { SettingsModal } from './components/SettingsModal';
import { Toasts } from './components/Toasts';
import { escapeTarget, handleShortcut, type ShortcutEvent } from './components/keyboard';
import { useStore } from './store/store';

export default function App() {
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
          if (s.selectedNodeId) s.duplicateNode(s.selectedNodeId);
        },
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
