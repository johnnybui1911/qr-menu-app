import { join } from 'node:path';

/**
 * `wrangler d1 migrations apply --local --persist-to <dir>` and `@cloudflare/vite-plugin`'s `persistState.path`
 * both silently version their local storage under `<dir>/v3/...`. `getPlatformProxy`'s `persist.path` option does
 * not add that suffix — passed the same `<dir>` it reads/writes one level too high and finds an empty database
 * ("no such table"). Every phase-10 script that opens the same local D1 the dev servers use must resolve through
 * here so all three tools agree on one physical directory.
 */
export function resolveLocalPersistPath(baseDir: string): string {
  return join(baseDir, 'v3');
}
