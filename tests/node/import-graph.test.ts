import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertProductionImportGraph } from '../../scripts/assert-production-import-graph.ts';

function writeGraph(modules: string[]): string {
  const path = join(mkdtempSync(join(tmpdir(), 'qr-graph-')), 'production-import-graph.json');
  writeFileSync(path, JSON.stringify({ modules }));
  return path;
}

describe('assertProductionImportGraph', () => {
  it.each(['design/x.ts', 'apps/console/src/prototype-demo.tsx', 'apps/console/src/fixtures/orders.ts'])(
    'rejects forbidden module %s in the console bundle',
    (forbidden) => {
      const path = writeGraph(['apps/console/src/main.tsx', forbidden]);
      expect(() => assertProductionImportGraph('console', path)).toThrow(/forbidden/i);
    },
  );

  it.each(['packages/orders/src/codes.ts', 'packages/identity/src/store.ts'])(
    'rejects workspace package %s other than catalog in the console bundle',
    (forbidden) => {
      const path = writeGraph(['apps/console/src/main.tsx', forbidden]);
      expect(() => assertProductionImportGraph('console', path)).toThrow(/forbidden/i);
    },
  );

  it('allows catalog modules in the console bundle', () => {
    const path = writeGraph(['apps/console/src/main.tsx', 'packages/catalog/src/money.ts']);
    expect(() => assertProductionImportGraph('console', path)).not.toThrow();
  });

  it('rejects every packages/** module in the storefront bundle', () => {
    const path = writeGraph(['apps/storefront/src/main.tsx', 'packages/catalog/src/money.ts']);
    expect(() => assertProductionImportGraph('storefront', path)).toThrow(/forbidden/i);
  });

  it.each(['console', 'storefront'] as const)('throws when the %s liveness anchor is missing', (target) => {
    const path = writeGraph([`apps/${target}/src/app.tsx`]);
    expect(() => assertProductionImportGraph(target, path)).toThrow(/liveness anchor/i);
  });

  it.each(['/abs/apps/console/src/x.ts', '../outside.ts', 'apps\\console\\src\\x.ts'])(
    'rejects unsanitised module path %s',
    (bad) => {
      const path = writeGraph(['apps/console/src/main.tsx', bad]);
      expect(() => assertProductionImportGraph('console', path)).toThrow(/unsafe module path/i);
    },
  );

  it('throws when metadata was never written', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'qr-graph-')), 'missing.json');
    expect(() => assertProductionImportGraph('console', path)).toThrow();
  });

  it('always deletes the metadata file, on pass and on throw', () => {
    const clean = writeGraph(['apps/storefront/src/main.tsx']);
    assertProductionImportGraph('storefront', clean);
    expect(existsSync(clean)).toBe(false);

    const dirty = writeGraph(['apps/storefront/src/main.tsx', 'packages/orders/src/codes.ts']);
    expect(() => assertProductionImportGraph('storefront', dirty)).toThrow();
    expect(existsSync(dirty)).toBe(false);
  });
});
