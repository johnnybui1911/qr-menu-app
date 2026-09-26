import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type Manifest = { name: string; exports?: Record<string, string>; main?: string; dependencies?: Record<string, string> };
const read = (dir: string): Manifest => JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'));
const qrDeps = (m: Manifest) => Object.keys(m.dependencies ?? {}).filter((d) => d.startsWith('@qr/')).sort();

describe('workspace dependency direction (D3)', () => {
  it('keeps orders -> catalog -> identity one-way and apps within their allowance', () => {
    expect(qrDeps(read('packages/identity'))).toEqual([]);
    expect(qrDeps(read('packages/catalog'))).toEqual(['@qr/identity']);
    expect(qrDeps(read('packages/orders'))).toEqual(['@qr/catalog', '@qr/identity']);
    expect(qrDeps(read('apps/worker'))).toEqual(['@qr/catalog', '@qr/identity', '@qr/orders']);
    expect(qrDeps(read('apps/console'))).toEqual(['@qr/catalog']);
    expect(qrDeps(read('apps/storefront'))).toEqual([]);
  });

  it.each(['packages/identity', 'packages/catalog', 'packages/orders'])(
    '%s exposes source subpaths only, with no barrel or main entry',
    (dir) => {
      const manifest = read(dir);
      expect(manifest.exports).toEqual({ './*': './src/*.ts' });
      expect(manifest.main).toBeUndefined();
    },
  );
});
