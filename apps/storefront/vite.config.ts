import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { productionImportGraph } from '../../scripts/assert-production-import-graph.ts';

// Static SPA; talks to the API only over HTTP via VITE_STOREFRONT_API_BASE_URL.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), productionImportGraph('storefront')],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { strictPort: true },
  preview: { strictPort: true },
});
