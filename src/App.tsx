import { useEffect } from 'react';
import { Toolbar } from './components/Toolbar';
import { Canvas } from './components/Canvas';
import { PreviewModal } from './components/PreviewModal';
import { SettingsModal } from './components/SettingsModal';
import { Toasts } from './components/Toasts';
import { handleUndoRedoKey, type UndoRedoKeyEvent } from './components/keyboard';
import { useStore } from './store/store';

export default function App() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (handleUndoRedoKey(e as unknown as UndoRedoKeyEvent, useStore.getState())) e.preventDefault();
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
