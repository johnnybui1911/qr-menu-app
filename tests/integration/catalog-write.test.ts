import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { STORE_ID } from '@qr/identity/store';
import { resolveOrderLineItems } from '@qr/catalog/pricing';
import { readPublicMenu } from '@qr/catalog/catalog-read';
import {
  createCategory,
  createProduct,
  deleteCategory,
  hideProduct,
  setProductAvailability,
  updateProduct,
} from '@qr/catalog/catalog-write';
import { resetDb } from '../support/test-env.ts';
import { insertOrder, insertTable } from '../support/seed.ts';

beforeEach(resetDb);

describe('catalog writes (owner menu management)', () => {
  it('creates a category and a product priced in integer VND', async () => {
    const category = await createCategory(env.DB, STORE_ID, { name: 'Đồ uống', slug: 'do-uong', displayOrder: 0 });
    expect(category).toMatchObject({ ok: true });
    const categoryId = category.ok ? category.id : '';
    const product = await createProduct(env.DB, STORE_ID, { categoryId, name: 'Cà phê sữa', description: '', priceMinor: 25000, displayOrder: 0 });
    expect(product).toMatchObject({ ok: true, revision: 1 });
    expect(await env.DB.prepare('SELECT price_minor, typeof(price_minor) AS t FROM products').first()).toEqual({ price_minor: 25000, t: 'integer' });
  });

  it('rejects a duplicate category slug', async () => {
    await createCategory(env.DB, STORE_ID, { name: 'A', slug: 'a', displayOrder: 0 });
    expect(await createCategory(env.DB, STORE_ID, { name: 'B', slug: 'a', displayOrder: 1 })).toEqual({ ok: false, code: 'slug_taken' });
  });

  it('refuses a product for an unknown category', async () => {
    expect(await createProduct(env.DB, STORE_ID, { categoryId: 'ghost', name: 'X', description: '', priceMinor: 1, displayOrder: 0 })).toEqual({
      ok: false,
      code: 'category_not_found',
    });
  });

  it('detects a concurrent edit through expectedRevision and changes nothing', async () => {
    const category = await createCategory(env.DB, STORE_ID, { name: 'A', slug: 'a', displayOrder: 0 });
    const product = await createProduct(env.DB, STORE_ID, { categoryId: category.ok ? category.id : '', name: 'Trà', description: '', priceMinor: 15000, displayOrder: 0 });
    const productId = product.ok ? product.id : '';
    expect(await updateProduct(env.DB, STORE_ID, productId, 1, { priceMinor: 16000 })).toEqual({ ok: true, revision: 2 });
    expect(await updateProduct(env.DB, STORE_ID, productId, 1, { name: 'Trà đào', priceMinor: 99000 })).toEqual({ ok: false, code: 'revision_conflict' });
    expect(await env.DB.prepare('SELECT name, price_minor, revision FROM products').first()).toEqual({ name: 'Trà', price_minor: 16000, revision: 2 });
    expect(await updateProduct(env.DB, STORE_ID, 'ghost', 1, { name: 'x' })).toEqual({ ok: false, code: 'not_found' });
  });

  it('refuses to delete a category that still has products', async () => {
    const category = await createCategory(env.DB, STORE_ID, { name: 'A', slug: 'a', displayOrder: 0 });
    const categoryId = category.ok ? category.id : '';
    await createProduct(env.DB, STORE_ID, { categoryId, name: 'Trà', description: '', priceMinor: 1, displayOrder: 0 });
    expect(await deleteCategory(env.DB, STORE_ID, categoryId)).toEqual({ ok: false, code: 'category_not_empty' });
    expect(await env.DB.prepare('SELECT count(*) AS n FROM categories').first('n')).toBe(1);
    const empty = await createCategory(env.DB, STORE_ID, { name: 'B', slug: 'b', displayOrder: 1 });
    expect(await deleteCategory(env.DB, STORE_ID, empty.ok ? empty.id : '')).toEqual({ ok: true });
  });

  it('hides an ordered product instead of deleting it', async () => {
    const category = await createCategory(env.DB, STORE_ID, { name: 'A', slug: 'a', displayOrder: 0 });
    const product = await createProduct(env.DB, STORE_ID, { categoryId: category.ok ? category.id : '', name: 'Trà', description: '', priceMinor: 1000, displayOrder: 0 });
    const productId = product.ok ? product.id : '';
    await insertTable();
    await insertOrder('order-1', { totalMinor: 1000 });
    await env.DB.prepare(
      "INSERT INTO order_items (id, store_id, order_id, product_id, product_name_snapshot, quantity, unit_price_snapshot_minor, line_total_minor, currency, position) VALUES ('li', 'store_default', 'order-1', ?, 'Trà', 1, 1000, 1000, 'VND', 0)",
    ).bind(productId).run();

    expect(await hideProduct(env.DB, STORE_ID, productId)).toEqual({ ok: true });
    expect(await env.DB.prepare('SELECT is_active FROM products').first('is_active')).toBe(0);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM order_items').first('n')).toBe(1);
    expect((await readPublicMenu(env.DB, STORE_ID)).flatMap((c) => c.products)).toEqual([]);
  });

  it('toggles stock so a sold-out product cannot be ordered', async () => {
    const category = await createCategory(env.DB, STORE_ID, { name: 'A', slug: 'a', displayOrder: 0 });
    const product = await createProduct(env.DB, STORE_ID, { categoryId: category.ok ? category.id : '', name: 'Trà', description: '', priceMinor: 1000, displayOrder: 0 });
    const productId = product.ok ? product.id : '';
    expect(await setProductAvailability(env.DB, STORE_ID, productId, false)).toEqual({ ok: true });
    expect(await resolveOrderLineItems(env.DB, STORE_ID, [{ productId, quantity: 1 }])).toEqual({
      ok: false,
      rejected: [{ productId, code: 'product_unavailable' }],
    });
    expect(await setProductAvailability(env.DB, STORE_ID, 'ghost', true)).toEqual({ ok: false, code: 'not_found' });
  });
});
