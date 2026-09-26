import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { generateOpaqueToken } from '@qr/identity/token-digest';
import { resetDb } from '../support/test-env.ts';
import { insertCategory, insertProduct, insertTable, insertTableSecret } from '../support/seed.ts';

const TABLE_TOKEN = generateOpaqueToken();
const getMenu = (headers: Record<string, string>) =>
  exports.default.fetch('http://api.test/api/storefront/menu', { headers: { origin: env.STOREFRONT_ORIGIN, ...headers } });

beforeEach(async () => {
  await resetDb();
  await insertCategory();
  await insertProduct('coffee');
  await insertProduct('sold-out', { isAvailable: 0 });
  await insertTable('table-1', '7');
  await insertTableSecret('table-1', TABLE_TOKEN);
});

describe('GET /api/storefront/menu', () => {
  it('requires a table token and answers failures with the uniform 404', async () => {
    const missing = await getMenu({});
    expect({ status: missing.status, body: await missing.json() }).toEqual({ status: 404, body: { error: 'not_found' } });
  });

  it('returns the table and its menu, with sold-out products flagged', async () => {
    const response = await getMenu({ 'x-table-token': TABLE_TOKEN });
    expect(response.status).toBe(200);
    const body = await response.json<{ table: unknown; categories: { products: { id: string; isAvailable: boolean }[] }[] }>();
    expect(body.table).toEqual({ tableNumber: '7' });
    expect(body.categories.flatMap((c) => c.products.map((p) => [p.id, p.isAvailable]))).toEqual([
      ['coffee', true],
      ['sold-out', false],
    ]);
  });
});
