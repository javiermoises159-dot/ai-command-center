import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.tsx';
import { RouterProvider } from './lib/router.tsx';
import { ThemeProvider } from './lib/theme.tsx';
import './index.css';

const container = document.getElementById('root');
if (container === null) throw new Error('#root is missing from index.html.');

createRoot(container).render(
  <StrictMode>
    <ThemeProvider>
      <RouterProvider>
        <App />
      </RouterProvider>
    </ThemeProvider>
  </StrictMode>,
);

// Registered only in production: in dev it would cache the shell and fight
// Vite's hot reload.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}
