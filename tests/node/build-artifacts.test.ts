import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const GENERATED = 'apps/console/dist/qr_menu_app/wrangler.json';

describe('console build artifacts', () => {
  it('emits a resolved wrangler.json that pairs the Worker bundle with the client assets', () => {
    expect(existsSync(GENERATED)).toBe(true);
    const config = JSON.parse(readFileSync(GENERATED, 'utf8')) as { main: string; assets: { directory: string } };
    const base = dirname(GENERATED);
    expect(existsSync(resolve(base, config.main))).toBe(true);
    expect(resolve(base, config.assets.directory)).toBe(resolve('apps/console/dist/client'));
    expect(existsSync(resolve(base, config.assets.directory, 'index.html'))).toBe(true);
  });

  it('never ships the import-graph metadata as a public asset', () => {
    expect(existsSync('apps/console/dist/client/production-import-graph.json')).toBe(false);
  });
});
