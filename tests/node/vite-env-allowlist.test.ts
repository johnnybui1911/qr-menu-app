// T23. A real dual-app `vite build` was tried first: Vite statically replaces every recognised
// `import.meta.env.VITE_*` expression with its resolved value at build time, so the identifier itself never
// survives into the production JS (confirmed by building apps/storefront and grepping the emitted bundle for
// `VITE_` — zero matches, with or without the env var set). Grepping the *bundle* is therefore not a meaningful
// gate; grepping the *source* for every name actually referenced is. This scans apps/*/src instead (the escape
// hatch phase 9 allows when the build-based approach is fragile) and additionally proves the scanner really
// catches a rogue name, not just that today's tree happens to be clean.

import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const VITE_ENV_REFERENCE = /import\.meta\.env\.(VITE_[A-Z0-9_]+)/g;
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;

// C10/C11: the storefront is a different origin and needs exactly one build-time base URL; the console is same
// origin (F10) and must call relative `/api/...` paths, so it may reference no VITE_ variable at all.
const STOREFRONT_ALLOWLIST = new Set(['VITE_STOREFRONT_API_BASE_URL']);

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (SOURCE_FILE.test(entry)) yield path;
  }
}

/** Every distinct `import.meta.env.VITE_*` name referenced anywhere under `root`. */
function scanViteEnvNames(root: string): Set<string> {
  const names = new Set<string>();
  for (const file of walk(root)) {
    for (const match of readFileSync(file, 'utf8').matchAll(VITE_ENV_REFERENCE)) names.add(match[1]);
  }
  return names;
}

describe('VITE_* build-time variable allowlist (C10, C11)', () => {
  it('storefront source references only the one allowed VITE_ name', () => {
    const found = scanViteEnvNames('apps/storefront/src');
    expect(found.size).toBeGreaterThan(0);
    for (const name of found) expect(STOREFRONT_ALLOWLIST.has(name)).toBe(true);
  });

  it('console source references no VITE_ variable — same origin, relative /api/... calls only', () => {
    expect(scanViteEnvNames('apps/console/src')).toEqual(new Set());
  });

  it('flags an unlisted VITE_ name the moment it appears anywhere in scanned source', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qr-vite-env-'));
    writeFileSync(join(dir, 'leak.ts'), "export const leaked = import.meta.env.VITE_SECRET_X;\n");

    const found = scanViteEnvNames(dir);
    expect(found.has('VITE_SECRET_X')).toBe(true);
    expect(STOREFRONT_ALLOWLIST.has('VITE_SECRET_X')).toBe(false);
  });
});
