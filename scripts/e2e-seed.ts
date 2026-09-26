// Seeds the fixed store/table/category/products the money-flow e2e spec drives, plus one `table_secrets` row for a
// table token generated fresh on every run (decision #5, phase-10). Deliberately narrow: no Owner, no session, no
// membership row is ever inserted here — Console auth for the spec comes from `tests/e2e/support/console-session.ts`
// instead, which mints a real better-auth cookie the same way `tests/support/console-session.ts` does for workerd
// tests. Refuses to run against anything but an explicit local D1 (`--local`, and never when `CLOUDFLARE_API_TOKEN`
// is set) so a missing flag can never seed test data into a production database.
//
//   tsx scripts/e2e-seed.ts --local --persist-to <dir> [--config wrangler.jsonc] [--environment e2e]
//
// Prints exactly one line to stdout: the raw table token. Nothing else goes to stdout, so a caller can capture it
// with a plain `execFileSync(...).trim()`.
import { parseArgs } from 'node:util';
import { getPlatformProxy } from 'wrangler';
import { resolveLocalPersistPath } from './e2e-local-persist.ts';
import { generateOpaqueToken, sha256Hex } from '../packages/identity/src/token-digest.ts';
import { STORE_ID } from '../packages/identity/src/store.ts';

const { values } = parseArgs({
  options: {
    local: { type: 'boolean', default: false },
    'persist-to': { type: 'string' },
    config: { type: 'string', default: 'wrangler.jsonc' },
    environment: { type: 'string', default: 'e2e' },
  },
});

if (!values.local) {
  console.error('Refusing to run without --local (this script only ever seeds a local D1 database).');
  process.exit(1);
}
if (process.env.CLOUDFLARE_API_TOKEN) {
  console.error('Refusing to run with CLOUDFLARE_API_TOKEN set: that is the signal a command is about to touch a remote/production account.');
  process.exit(1);
}
if (!values['persist-to']) {
  console.error('Usage: tsx scripts/e2e-seed.ts --local --persist-to <dir> [--config wrangler.jsonc] [--environment e2e]');
  process.exit(2);
}

const TABLE_ID = 'e2e-table-5';
const TABLE_NUMBER = '5';
const CATEGORY_ID = 'e2e-drinks';
const CATEGORY_SLUG = 'do-uong';

type SeedEnv = { DB: D1Database };

const proxy = await getPlatformProxy<SeedEnv>({
  configPath: values.config,
  environment: values.environment,
  persist: { path: resolveLocalPersistPath(values['persist-to']) },
});

try {
  const token = generateOpaqueToken();
  const tokenDigest = await sha256Hex(token);

  await proxy.env.DB.batch([
    proxy.env.DB.prepare('INSERT INTO tables (id, store_id, table_number) VALUES (?, ?, ?)').bind(TABLE_ID, STORE_ID, TABLE_NUMBER),
    proxy.env.DB.prepare('INSERT INTO table_secrets (id, store_id, table_id, token_digest) VALUES (?, ?, ?, ?)').bind(
      crypto.randomUUID(),
      STORE_ID,
      TABLE_ID,
      tokenDigest,
    ),
    proxy.env.DB.prepare('INSERT INTO categories (id, store_id, name, slug, display_order) VALUES (?, ?, ?, ?, 0)').bind(
      CATEGORY_ID,
      STORE_ID,
      'Đồ uống',
      CATEGORY_SLUG,
    ),
    proxy.env.DB.prepare('INSERT INTO products (id, store_id, category_id, name, currency, price_minor, display_order) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(
      'e2e-coffee',
      STORE_ID,
      CATEGORY_ID,
      'Cà phê sữa đá',
      'VND',
      25000,
      0,
    ),
    proxy.env.DB.prepare('INSERT INTO products (id, store_id, category_id, name, currency, price_minor, display_order) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(
      'e2e-tea',
      STORE_ID,
      CATEGORY_ID,
      'Trà đào cam sả',
      'VND',
      35000,
      1,
    ),
  ]);

  console.log(token);
} finally {
  await proxy.dispose();
}
