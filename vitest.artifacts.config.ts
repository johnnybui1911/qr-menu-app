import { defineConfig } from 'vitest/config';

// Runs only after `npm run build:console`; it inspects the built bundle, so it is not part of `npm test`.
export default defineConfig({
  test: { environment: 'node', include: ['tests/node/build-artifacts.test.ts'] },
});
