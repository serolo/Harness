// Renderer entry (Phase 0 app shell). React 18 root → <App/>.
//
// electron-vite serves this file as the renderer entry (referenced from index.html).
// The Tailwind entry CSS is imported here so PostCSS processes it and the generated
// utilities are available app-wide.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@renderer/app/App';
import '@renderer/index.css';

const rootEl = document.getElementById('root');
if (!rootEl) {
  // The root node is declared in index.html; its absence is a hard programming error,
  // not a runtime condition to recover from.
  throw new Error('Renderer bootstrap failed: #root element not found');
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
