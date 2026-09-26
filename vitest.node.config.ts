import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/node/**/*.test.ts'],
    exclude: ['tests/node/build-artifacts.test.ts'],
    fileParallelism: false,
  },
});
