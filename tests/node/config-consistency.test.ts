import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readJsonc } from '../support/jsonc.ts';

type WranglerConfig = {
  compatibility_date: string;
  main?: string;
  assets?: { directory?: string; not_found_handling?: string; run_worker_first?: string[] };
  triggers?: { crons?: string[] };
  d1_databases?: { binding: string }[];
  r2_buckets?: { binding: string }[];
};

const root = readJsonc<WranglerConfig>('wrangler.jsonc');
const storefront = readJsonc<WranglerConfig>('apps/storefront/wrangler.jsonc');

describe('Cloudflare config consistency', () => {
  it('uses one compatibility_date for both Workers and the test runtime', () => {
    expect(root.compatibility_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(storefront.compatibility_date).toBe(root.compatibility_date);
    // The workerd test pool reads the root Wrangler config instead of repeating the date.
    expect(readFileSync('vitest.config.ts', 'utf8')).toMatch(/configPath:\s*['"]\.\/wrangler\.jsonc['"]/);
  });

  it('schedules exactly the reconciliation and email-outbox crons', () => {
    expect([...(root.triggers?.crons ?? [])].sort()).toEqual(['*/1 * * * *', '*/5 * * * *']);
  });

  it('routes /api to the Worker before SPA asset fallback', () => {
    expect(root.main).toBe('apps/worker/src/index.ts');
    expect(root.assets?.not_found_handling).toBe('single-page-application');
    expect(root.assets?.run_worker_first).toEqual(['/api', '/api/*']);
    expect(root.d1_databases?.map((d) => d.binding)).toEqual(['DB']);
    expect(root.r2_buckets?.map((b) => b.binding)).toEqual(['FILES']);
  });

  it('keeps the storefront Worker assets-only', () => {
    expect(storefront.main).toBeUndefined();
    expect(storefront.d1_databases).toBeUndefined();
    expect(storefront.r2_buckets).toBeUndefined();
    expect(storefront.assets?.not_found_handling).toBe('single-page-application');
  });
});
