import { Toolbar } from './components/Toolbar';
import { Canvas } from './components/Canvas';
import { PreviewModal } from './components/PreviewModal';
import { SettingsModal } from './components/SettingsModal';
import { Toasts } from './components/Toasts';

export default function App() {
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
