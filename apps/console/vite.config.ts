import { cloudflare } from '@cloudflare/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { productionImportGraph } from '../../scripts/assert-production-import-graph.ts';

// One Vite process serves the Console SPA and the API Worker (root wrangler.jsonc) on the same origin.
// Local D1/R2 state lives in the repo-root .wrangler/state, the same place `npm run db:migrate:local` writes;
// otherwise the plugin would resolve it under apps/console and dev would run against an unmigrated database.
// `QR_LOCAL_STATE_DIR` overrides that path (phase 10 e2e harness): the Playwright config points every run at an
// isolated temp directory so `npm run test:e2e` never touches a developer's real `.wrangler/state`.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [
    react(),
    cloudflare({ configPath: '../../wrangler.jsonc', persistState: { path: process.env.QR_LOCAL_STATE_DIR ?? '../../.wrangler/state' } }),
    productionImportGraph('console'),
  ],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { strictPort: true },
  preview: { strictPort: true },
});
