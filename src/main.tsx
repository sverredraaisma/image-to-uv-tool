import React from 'react';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import './index.css';

import { setPlatform } from './lib/platform';
import { browserPlatform } from './lib/canvas';
import { useStore } from './store/store';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';

// Install the browser (canvas-based) image adapter, then let the store compute
// any auto-run nodes restored from local storage.
setPlatform(browserPlatform);
useStore.getState().init();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);

// Register the offline service worker in production (needs https/localhost).
// BASE_URL keeps the path correct under a subpath deploy (GitHub Pages project).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {
      /* offline support is best-effort */
    });
  });
}
