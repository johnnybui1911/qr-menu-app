import { defineConfig, devices } from '@playwright/test';
import {
  CLOUDFLARE_ENVIRONMENT,
  CONSOLE_BASE_URL,
  CONSOLE_PORT,
  isPlaywrightMainProcess,
  prepareE2eEnvironment,
  readE2eContext,
  REPO_ROOT,
  STOREFRONT_BASE_URL,
  STOREFRONT_PORT,
  teardownE2eEnvironment,
} from './tests/e2e/support/harness.ts';

// Only the main process (no `webServer` runs inside a worker) may pay for migrate+seed — see harness.ts's module
// doc comment for why the two-process split is unavoidable and how the worker process gets the same result back.
// Cleanup rides `process.on('exit')` rather than Playwright's `globalTeardown` hook: with two real webServer
// entries (one of them the @cloudflare/vite-plugin console dev server), this exact wrangler/Playwright pairing
// never invokes `globalTeardown` at all — verified by a standalone probe (recorded in the phase-10 report) — while
// `process.on('exit')` always fires before the main process exits and only ever needs synchronous work (`rmSync`).
const context = isPlaywrightMainProcess() ? prepareE2eEnvironment() : readE2eContext();
if (isPlaywrightMainProcess()) process.on('exit', teardownE2eEnvironment);

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  // D14/decision #1 of phase 10: one spec, no flake-masking retries — a flake here must be fixed at the cause.
  retries: 0,
  workers: 1,
  use: {
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npm run dev:console -- --host 127.0.0.1 --port ' + CONSOLE_PORT,
      cwd: REPO_ROOT,
      url: CONSOLE_BASE_URL + '/api/console/session',
      reuseExistingServer: false,
      env: { QR_LOCAL_STATE_DIR: context.stateDir, CLOUDFLARE_ENV: CLOUDFLARE_ENVIRONMENT },
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'npm run dev:storefront -- --host 127.0.0.1 --port ' + STOREFRONT_PORT,
      cwd: REPO_ROOT,
      url: STOREFRONT_BASE_URL,
      reuseExistingServer: false,
      env: { VITE_STOREFRONT_API_BASE_URL: CONSOLE_BASE_URL },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
