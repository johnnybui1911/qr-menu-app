import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { readConsoleMenu, readPublicMenu } from '@qr/catalog/catalog-read';
import { resetDb } from '../support/test-env.ts';
import { TEST_STORE, insertCategory, insertProduct } from '../support/seed.ts';

beforeEach(async () => {
  await resetDb();
  await insertCategory('drinks', { displayOrder: 1 });
  await insertCategory('food', { displayOrder: 0 });
  await insertCategory('hidden-cat', { displayOrder: 2, isActive: 0 });
  await insertProduct('tea', { categoryId: 'drinks', displayOrder: 1, priceMinor: 15000 });
  await insertProduct('coffee-b', { categoryId: 'drinks', displayOrder: 0, priceMinor: 25000 });
  await insertProduct('coffee-a', { categoryId: 'drinks', displayOrder: 0, priceMinor: 20000 });
  await insertProduct('sold-out', { categoryId: 'drinks', displayOrder: 2, isAvailable: 0 });
  await insertProduct('retired', { categoryId: 'drinks', displayOrder: 3 });
  await insertProduct('bread', { categoryId: 'food' });
  await insertProduct('secret', { categoryId: 'hidden-cat' });
  await env.DB.batch([
    env.DB.prepare("UPDATE products SET is_active = 0 WHERE id = 'retired'"),
    env.DB.prepare(
      "UPDATE products SET image_key = 'product-images/0f8fad5b-d9cb-469f-a165-70867728950e', image_filename = 'a.jpg', image_content_type = 'image/jpeg', image_size = 10 WHERE id = 'coffee-a'",
    ),
  ]);
});

describe('readPublicMenu', () => {
  it('lists active products of active categories in display order, sold-out ones flagged', async () => {
    const menu = await readPublicMenu(env.DB, TEST_STORE);
    expect(menu.map((c) => [c.id, c.products.map((p) => [p.id, p.isAvailable])])).toEqual([
      ['food', [['bread', true]]],
      ['drinks', [['coffee-a', true], ['coffee-b', true], ['tea', true], ['sold-out', false]]],
    ]);
    expect(menu[1].products[0]).toEqual({
      id: 'coffee-a',
      name: 'Product coffee-a',
      description: '',
      priceMinor: 20000,
      currency: 'VND',
      isAvailable: true,
      imageId: '0f8fad5b-d9cb-469f-a165-70867728950e',
    });
  });
});

describe('readConsoleMenu', () => {
  it('also shows hidden products and inactive categories, with revisions', async () => {
    const menu = await readConsoleMenu(env.DB, TEST_STORE);
    expect(menu.map((c) => [c.id, c.isActive])).toEqual([
      ['food', true],
      ['drinks', true],
      ['hidden-cat', false],
    ]);
    const retired = menu[1].products.find((p) => p.id === 'retired');
    expect(retired).toMatchObject({ isActive: false, revision: 1, categoryId: 'drinks' });
  });
});
