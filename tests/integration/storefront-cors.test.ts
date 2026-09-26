import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const preflight = (origin: string) =>
  exports.default.fetch('http://api.test/api/storefront/orders', {
    method: 'OPTIONS',
    headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-table-token,x-order-token,idempotency-key,content-type' },
  });

describe('storefront CORS', () => {
  it('allows the storefront origin with a cached preflight and no credentials', async () => {
    const response = await preflight(env.STOREFRONT_ORIGIN);
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(env.STOREFRONT_ORIGIN);
    const allowed = response.headers.get('access-control-allow-headers')!.toLowerCase();
    for (const header of ['x-table-token', 'x-order-token', 'idempotency-key', 'content-type']) expect(allowed).toContain(header);
    expect(Number(response.headers.get('access-control-max-age'))).toBeGreaterThanOrEqual(600);
    expect(response.headers.has('access-control-allow-credentials')).toBe(false);
    expect(response.headers.get('vary')).toMatch(/origin/i);
  });

  it('grants nothing to a foreign origin', async () => {
    const response = await preflight('https://evil.example');
    expect(response.headers.has('access-control-allow-origin')).toBe(false);
    const actual = await exports.default.fetch('http://api.test/api/storefront/menu', { headers: { origin: 'https://evil.example' } });
    expect(actual.headers.has('access-control-allow-origin')).toBe(false);
  });

  it('adds the allow-origin header to actual storefront responses', async () => {
    const response = await exports.default.fetch('http://api.test/api/storefront/menu', { headers: { origin: env.STOREFRONT_ORIGIN } });
    expect(response.headers.get('access-control-allow-origin')).toBe(env.STOREFRONT_ORIGIN);
  });
});
