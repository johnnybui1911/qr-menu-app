import type { D1Migration } from '@cloudflare/vitest-pool-workers';

declare global {
  namespace Cloudflare {
    interface Env {
      MIGRATIONS: D1Migration[];
    }
  }
}
