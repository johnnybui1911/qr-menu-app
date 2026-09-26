import { playwright } from '@vitest/browser-playwright';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// React contract tests in real headless Chromium with fetch stubbed (no D1, no worker): the `browser` risk layer.
export default defineConfig({
  plugins: [react()],
  // Build-time variable of the storefront (the only VITE_* allowed); tests point it at a fake API origin.
  define: { 'import.meta.env.VITE_STOREFRONT_API_BASE_URL': JSON.stringify('http://api.test') },
  test: {
    include: ['tests/browser/**/*.test.{ts,tsx}'],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
    },
  },
});
