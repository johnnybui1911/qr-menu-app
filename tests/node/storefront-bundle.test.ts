// T20: exercises the real production bundle, not a synthetic module list (that unit-level coverage already lives
// in tests/node/import-graph.test.ts). A genuine `vite build` of apps/storefront must pass the gate, and adding a
// forbidden `@qr/*` import must make the very same build fail.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build as viteBuild } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import { assertProductionImportGraph, importGraphMetadataPath } from '../../scripts/assert-production-import-graph.ts';

const CONFIG = resolve('apps/storefront/vite.config.ts');
const MAIN = resolve('apps/storefront/src/main.tsx');
const ORIGINAL_MAIN = readFileSync(MAIN, 'utf8');

afterEach(() => {
  writeFileSync(MAIN, ORIGINAL_MAIN);
});

async function buildStorefront(): Promise<number> {
  await viteBuild({ configFile: CONFIG, logLevel: 'silent' });
  return assertProductionImportGraph('storefront', importGraphMetadataPath('storefront'));
}

describe('storefront production bundle (real vite build)', () => {
  it('builds clean: no packages/** module reaches the client bundle', async () => {
    await expect(buildStorefront()).resolves.toBeGreaterThan(0);
  }, 30_000);

  it('fails the same build once a forbidden @qr/* import is added to the entry', async () => {
    writeFileSync(MAIN, `${ORIGINAL_MAIN}\nimport '@qr/catalog/money';\n`);
    await expect(buildStorefront()).rejects.toThrow();
  }, 30_000);
});
