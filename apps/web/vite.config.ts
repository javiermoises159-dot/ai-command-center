import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const resolve = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // Workspace packages are consumed as TypeScript source; Vite compiles
      // them as part of the app. Keeps the dev loop instant with no build step
      // between packages. Only @acc/contracts is aliased because it is the only
      // workspace package the browser bundle is allowed to pull in — the domain,
      // orchestrator and repositories are server-side.
      '@acc/contracts': resolve('../../packages/contracts/src/index.ts'),
      '@': resolve('./src'),
    },
  },
  server: {
    port: 5173,
    // The frontend never holds an API key, so it always talks to our server.
    // In dev the proxy keeps it same-origin and avoids CORS entirely.
    proxy: {
      '/api': {
        target: process.env['VITE_API_TARGET'] ?? 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
