// Production origins are never committed (D21, C10): `wrangler.jsonc` keeps the loopback values that dev, e2e and the
// workerd tests run on, and `scripts/deploy-worker.ts` injects the real ones at deploy time. A deploy that silently
// ships a loopback, empty or slash-suffixed origin still "succeeds" and then breaks Google OAuth, Console cookies,
// storefront CORS and QR links — so every value is rejected here before anything is built or uploaded.

export type DeployOrigins = { consoleOrigin: string; storefrontOrigin: string };

const LOOPBACK_HOSTS: Record<string, true> = { localhost: true, '127.0.0.1': true, '[::1]': true, '0.0.0.0': true };

function readOrigin(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set — export the deployed origin (GitHub repo variable in CI)`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a URL: ${JSON.stringify(value)}`);
  }
  if (url.protocol !== 'https:') throw new Error(`${name} must use https: ${value}`);
  if (LOOPBACK_HOSTS[url.hostname]) throw new Error(`${name} points at a loopback host: ${value}`);
  if (url.origin !== value) throw new Error(`${name} must be a bare origin (no path, query or trailing slash): ${value} → ${url.origin}`);
  return value;
}

export function readDeployOrigins(env: Record<string, string | undefined>): DeployOrigins {
  const consoleOrigin = readOrigin(env, 'CONSOLE_ORIGIN');
  const storefrontOrigin = readOrigin(env, 'STOREFRONT_ORIGIN');
  if (consoleOrigin === storefrontOrigin) throw new Error('CONSOLE_ORIGIN and STOREFRONT_ORIGIN must be different origins');
  return { consoleOrigin, storefrontOrigin };
}
