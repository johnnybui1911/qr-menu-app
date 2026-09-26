import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveLineItemPrice, resolveOrderLineItems } from '@qr/catalog/pricing';
import { resetDb } from '../support/test-env.ts';
import { TEST_STORE, insertCategory, insertProduct } from '../support/seed.ts';

beforeEach(async () => {
  await resetDb();
  await insertCategory();
  await insertProduct('coffee', { priceMinor: 20000 });
  await insertProduct('tea', { priceMinor: 15000 });
});

describe('resolveOrderLineItems (D11, D19)', () => {
  it('prices every line from D1 and totals on the server', async () => {
    const result = await resolveOrderLineItems(env.DB, TEST_STORE, [
      { productId: 'coffee', quantity: 2 },
      { productId: 'tea', quantity: 1 },
      { productId: 'coffee', quantity: 1 },
    ]);
    expect(result).toEqual({
      ok: true,
      currency: 'VND',
      totalAmountMinor: 75000,
      lines: [
        { productId: 'coffee', productName: 'Product coffee', quantity: 2, unitPriceMinor: 20000, lineTotalMinor: 40000 },
        { productId: 'tea', productName: 'Product tea', quantity: 1, unitPriceMinor: 15000, lineTotalMinor: 15000 },
        { productId: 'coffee', productName: 'Product coffee', quantity: 1, unitPriceMinor: 20000, lineTotalMinor: 20000 },
      ],
    });
  });

  it('rejects the whole order when any product is unavailable', async () => {
    await env.DB.prepare("UPDATE products SET is_available = 0 WHERE id = 'tea'").run();
    const result = await resolveOrderLineItems(env.DB, TEST_STORE, [
      { productId: 'coffee', quantity: 1 },
      { productId: 'tea', quantity: 1 },
    ]);
    expect(result).toEqual({ ok: false, rejected: [{ productId: 'tea', code: 'product_unavailable' }] });
  });

  it('rejects unknown products and products of another store', async () => {
    await env.DB.prepare("INSERT INTO stores (id, name) VALUES ('store_other', 'Other')").run();
    await insertCategory('cat-other', { store: 'store_other' });
    await insertProduct('foreign', { categoryId: 'cat-other', store: 'store_other' });
    const result = await resolveOrderLineItems(env.DB, TEST_STORE, [
      { productId: 'ghost', quantity: 1 },
      { productId: 'foreign', quantity: 1 },
    ]);
    expect(result).toEqual({
      ok: false,
      rejected: [
        { productId: 'ghost', code: 'product_not_found' },
        { productId: 'foreign', code: 'product_not_found' },
      ],
    });
  });

  it('treats a hidden product as not found, even if a stale menu still offers it', async () => {
    await env.DB.prepare("UPDATE products SET is_active = 0 WHERE id = 'tea'").run();
    expect(await resolveOrderLineItems(env.DB, TEST_STORE, [{ productId: 'tea', quantity: 1 }])).toEqual({
      ok: false,
      rejected: [{ productId: 'tea', code: 'product_not_found' }],
    });
  });

  it('rejects an empty order', async () => {
    expect(await resolveOrderLineItems(env.DB, TEST_STORE, [])).toEqual({ ok: false, rejected: [] });
  });
});

describe('resolveLineItemPrice', () => {
  it('refuses a line total beyond the safe money ceiling', () => {
    expect(() => resolveLineItemPrice({ priceMinor: Number.MAX_SAFE_INTEGER }, 2)).toThrow(/money_out_of_range/);
  });
});
