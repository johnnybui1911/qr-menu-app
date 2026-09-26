// A deploy with a wrong origin still succeeds and then breaks OAuth, cookies, CORS and QR links in production, so the
// guard in scripts/deploy-worker.ts must refuse every shape of wrong value before anything is built or uploaded.
import { describe, expect, it } from 'vitest';
import { readDeployOrigins } from '../../scripts/deploy-origins.ts';

const CONSOLE = 'https://console.example';
const STOREFRONT = 'https://storefront.example';

describe('readDeployOrigins (D21 deploy-time origins)', () => {
  it('accepts two distinct bare https origins', () => {
    expect(readDeployOrigins({ CONSOLE_ORIGIN: CONSOLE, STOREFRONT_ORIGIN: STOREFRONT })).toEqual({
      consoleOrigin: CONSOLE,
      storefrontOrigin: STOREFRONT,
    });
  });

  it.each([
    ['missing', undefined, /CONSOLE_ORIGIN is not set/],
    ['empty', '', /CONSOLE_ORIGIN is not set/],
    ['not a URL', 'console.example', /not a URL/],
    ['http', 'http://console.example', /must use https/],
    ['loopback (the committed dev value)', 'https://127.0.0.1:5173', /loopback/],
    ['localhost', 'https://localhost', /loopback/],
    ['trailing slash', `${CONSOLE}/`, /bare origin/],
    ['path', `${CONSOLE}/console`, /bare origin/],
  ])('rejects a %s CONSOLE_ORIGIN', (_label, value, message) => {
    expect(() => readDeployOrigins({ CONSOLE_ORIGIN: value, STOREFRONT_ORIGIN: STOREFRONT })).toThrow(message);
  });

  it('validates STOREFRONT_ORIGIN with the same rules', () => {
    expect(() => readDeployOrigins({ CONSOLE_ORIGIN: CONSOLE, STOREFRONT_ORIGIN: `${STOREFRONT}/` })).toThrow(/STOREFRONT_ORIGIN must be a bare origin/);
  });

  it('rejects the same origin for both Workers', () => {
    expect(() => readDeployOrigins({ CONSOLE_ORIGIN: CONSOLE, STOREFRONT_ORIGIN: CONSOLE })).toThrow(/must be different/);
  });
});
