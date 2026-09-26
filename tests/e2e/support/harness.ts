// Shared constants and one-time environment preparation for the money-flow e2e spec (phase 10). Isolation
// mechanism (proven against this exact wrangler/vite-plugin version, see the probe recorded in the phase-10
// report): `getPlatformProxy`'s `persist.path` does not add the `v3` version segment that `wrangler d1 migrations
// apply --persist-to` and `@cloudflare/vite-plugin`'s `persistState.path` both add on their own — every consumer
// of a raw persist directory here goes through `resolveLocalPersistPath` so all three tools agree on one file.
//
// Playwright loads this config module once in its main process (before any `webServer` starts) and again, sepa-
// rately, inside every worker process that runs a test file — `process.env.TEST_WORKER_INDEX` is Playwright's own
// discriminator between the two (unset in the main process, a number in every worker). Only the main process may
// run `prepareE2eEnvironment`: mkdtemp + `wrangler d1 migrations apply` + `scripts/e2e-seed.ts` take several
// seconds and must happen exactly once, and only the main process's `webServer` entries are ever acted on. The
// result (state dir + table token) is written to a JSON file under the already-gitignored `.qr-build/`, which the
// worker process (and the spec itself) read back with `readE2eContext`.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveLocalPersistPath } from '../../../scripts/e2e-local-persist.ts';

export const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../../..');
export const CLOUDFLARE_ENVIRONMENT = 'e2e';
export const WRANGLER_CONFIG_PATH = join(REPO_ROOT, 'wrangler.jsonc');
export const DEV_VARS_PATH = join(REPO_ROOT, '.dev.vars.e2e');
export const CONTEXT_FILE_PATH = join(REPO_ROOT, '.qr-build', 'e2e-context.json');

// Loopback-only: this harness never runs against a deployed origin, the same exemption `wrangler.jsonc`'s own
// local-dev `vars.CONSOLE_ORIGIN`/`vars.STOREFRONT_ORIGIN` already rely on (C10's hostname gate only rejects
// domain-shaped literals — `127.0.0.1` has no letter TLD to match). Ports are still env-overridable.
const HOST = '127.0.0.1';
export const CONSOLE_PORT = Number(process.env.E2E_CONSOLE_PORT ?? 5173);
export const STOREFRONT_PORT = Number(process.env.E2E_STOREFRONT_PORT ?? 5174);
export const CONSOLE_BASE_URL = `http://${HOST}:${CONSOLE_PORT}`;
export const STOREFRONT_BASE_URL = `http://${HOST}:${STOREFRONT_PORT}`;

// Test-only fixture values, not secrets: identical to the workerd test bindings in vitest.config.ts, so
// scripts/dev/sign-payfs-payload.ts (run out-of-process by the spec) signs against the same webhook secret the
// dev server reads, and readMerchantConfig/readConsoleAuthConfig both accept them as well-formed.
export const E2E_DEV_VARS: Record<string, string> = {
  PAYFS_MERCHANT_BANK_BIN: '970422',
  PAYFS_MERCHANT_ACCOUNT: '0123456789',
  PAYFS_WEBHOOK_API_KEY: 'test-webhook-api-key',
  PAYFS_WEBHOOK_SECRET: 'test-webhook-secret',
  BETTER_AUTH_SECRET: 'test-better-auth-secret-0123456789',
  GOOGLE_CLIENT_ID: 'test-google-client-id',
  GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
  INITIAL_OWNER_EMAIL: 'initial-owner@example.com',
  INVITATION_HMAC_SECRET: 'test-invitation-hmac-secret-0123456789',
};

export type E2eContext = { stateDir: string; tableToken: string };

/** Only the Playwright main process (no `TEST_WORKER_INDEX`) may call this — see the module doc comment. */
export function isPlaywrightMainProcess(): boolean {
  return process.env.TEST_WORKER_INDEX === undefined;
}

/**
 * Mirrors the proven manual flow from phase 9's A2 run (migrate → seed → start servers): creates a fresh temp
 * state dir distinct from any developer's real `.wrangler/state`, writes `.dev.vars.e2e` (distinct from any real
 * `.dev.vars`), migrates, seeds the fixed store/table/menu (decision #5), and persists the result for the worker
 * process and the spec to read back.
 */
export function prepareE2eEnvironment(): E2eContext {
  const stateDir = mkdtempSync(join(tmpdir(), 'qr-e2e-state-'));
  writeFileSync(
    DEV_VARS_PATH,
    Object.entries(E2E_DEV_VARS)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(''),
  );
  execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', stateDir], { cwd: REPO_ROOT, stdio: 'pipe' });
  const seedOutput = execFileSync(
    'npx',
    ['tsx', 'scripts/e2e-seed.ts', '--local', '--persist-to', stateDir, '--config', WRANGLER_CONFIG_PATH, '--environment', CLOUDFLARE_ENVIRONMENT],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  const tableToken = seedOutput.trim().split('\n').at(-1);
  if (!tableToken) throw new Error(`scripts/e2e-seed.ts printed no token:\n${seedOutput}`);

  const context: E2eContext = { stateDir, tableToken };
  mkdirSync(dirname(CONTEXT_FILE_PATH), { recursive: true });
  writeFileSync(CONTEXT_FILE_PATH, JSON.stringify(context));
  return context;
}

/** Reads back what `prepareE2eEnvironment` wrote — used by worker-process config loads and by the spec itself. */
export function readE2eContext(): E2eContext {
  return JSON.parse(readFileSync(CONTEXT_FILE_PATH, 'utf8')) as E2eContext;
}

/** Resolves `context.stateDir` the way `getPlatformProxy` needs it (see the module doc comment). */
export function resolveE2ePersistPath(stateDir: string): string {
  return resolveLocalPersistPath(stateDir);
}

/** Deletes everything `prepareE2eEnvironment` created; called once from `globalTeardown`. */
export function teardownE2eEnvironment(): void {
  rmSync(DEV_VARS_PATH, { force: true });
  try {
    const { stateDir } = readE2eContext();
    rmSync(stateDir, { recursive: true, force: true });
  } catch {
    // Context file missing or unreadable (setup never completed) — nothing else to clean up.
  }
  rmSync(CONTEXT_FILE_PATH, { force: true });
}
