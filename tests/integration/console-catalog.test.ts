import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { consoleRequest, createConsoleSession } from '../support/console-session.ts';
import { resetDb } from '../support/test-env.ts';

const json = (body: unknown) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function ownerCategory(cookie: string, name = 'Cà phê', slug = 'ca-phe') {
  const response = await consoleRequest('/api/console/categories', { method: 'POST', cookie, ...json({ name, slug, displayOrder: 0 }) });
  return (await response.json()) as { id: string };
}

beforeEach(resetDb);

describe('console catalog routes (phase 8)', () => {
  it('T4: an Owner creates a category and a product; price arrives as a decimal string, never a float', async () => {
    const owner = await createConsoleSession({ role: 'owner', status: 'active' });
    const category = await consoleRequest('/api/console/categories', { method: 'POST', cookie: owner.cookie, ...json({ name: 'Trà', slug: 'tra', displayOrder: 0 }) });
    expect(category.status).toBe(201);
    const { id: categoryId } = (await category.json()) as { id: string };

    const product = await consoleRequest('/api/console/products', {
      method: 'POST',
      cookie: owner.cookie,
      ...json({ categoryId, name: 'Trà đào', description: '', price: '45000', displayOrder: 0 }),
    });
    expect(product.status).toBe(201);

    const list = await consoleRequest('/api/console/categories', { cookie: owner.cookie });
    const { categories } = (await list.json()) as { categories: { id: string; products: { name: string; priceMinor: number }[] }[] };
    const found = categories.find((c) => c.id === categoryId)!.products.find((p) => p.name === 'Trà đào')!;
    expect(found.priceMinor).toBe(45000);
    expect(Number.isInteger(found.priceMinor)).toBe(true);

    const rejected = await consoleRequest('/api/console/products', {
      method: 'POST',
      cookie: owner.cookie,
      ...json({ categoryId, name: 'Trà sữa', price: '45000.5' }),
    });
    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toEqual({ error: 'invalid_price' });
  });

  it('T5: a Staff caller is refused on every menu mutation but can still read the menu', async () => {
    const owner = await createConsoleSession({ role: 'owner', status: 'active' });
    const staff = await createConsoleSession({ role: 'staff', status: 'active' });
    const category = await ownerCategory(owner.cookie);

    const postCategory = await consoleRequest('/api/console/categories', { method: 'POST', cookie: staff.cookie, ...json({ name: 'X', slug: 'x' }) });
    expect(postCategory.status).toBe(403);
    const patchCategory = await consoleRequest(`/api/console/categories/${category.id}`, { method: 'PATCH', cookie: staff.cookie, ...json({ name: 'Y' }) });
    expect(patchCategory.status).toBe(403);
    const deleteCategoryResp = await consoleRequest(`/api/console/categories/${category.id}`, { method: 'DELETE', cookie: staff.cookie });
    expect(deleteCategoryResp.status).toBe(403);

    const getMenu = await consoleRequest('/api/console/categories', { cookie: staff.cookie });
    expect(getMenu.status).toBe(200);
  });

  it('T6: a stale expectedRevision is refused with 409 and changes nothing', async () => {
    const owner = await createConsoleSession({ role: 'owner', status: 'active' });
    const category = await ownerCategory(owner.cookie);
    const created = await consoleRequest('/api/console/products', { method: 'POST', cookie: owner.cookie, ...json({ categoryId: category.id, name: 'Món', price: '10000' }) });
    const { id: productId } = (await created.json()) as { id: string };

    const first = await consoleRequest(`/api/console/products/${productId}`, { method: 'PATCH', cookie: owner.cookie, ...json({ expectedRevision: 1, name: 'Món A' }) });
    expect(first.status).toBe(200);
    const second = await consoleRequest(`/api/console/products/${productId}`, { method: 'PATCH', cookie: owner.cookie, ...json({ expectedRevision: 1, name: 'Món B' }) });
    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toEqual({ error: 'revision_conflict' });
    const row = await env.DB.prepare('SELECT name FROM products WHERE id = ?').bind(productId).first<{ name: string }>();
    expect(row!.name).toBe('Món A');
  });

  it('T7: deleting a non-empty category is blocked with 409 category_not_empty', async () => {
    const owner = await createConsoleSession({ role: 'owner', status: 'active' });
    const category = await ownerCategory(owner.cookie);
    await consoleRequest('/api/console/products', { method: 'POST', cookie: owner.cookie, ...json({ categoryId: category.id, name: 'Món', price: '10000' }) });
    const response = await consoleRequest(`/api/console/categories/${category.id}`, { method: 'DELETE', cookie: owner.cookie });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: 'category_not_empty' });
  });

  it('T8/A1: deleting a product hides it (is_active=0) instead of a physical delete; hidden products only show in Console', async () => {
    const owner = await createConsoleSession({ role: 'owner', status: 'active' });
    const category = await ownerCategory(owner.cookie);
    const created = await consoleRequest('/api/console/products', { method: 'POST', cookie: owner.cookie, ...json({ categoryId: category.id, name: 'Bánh', price: '20000' }) });
    const { id: productId } = (await created.json()) as { id: string };

    const del = await consoleRequest(`/api/console/products/${productId}`, { method: 'DELETE', cookie: owner.cookie });
    expect(del.status).toBe(200);
    const row = await env.DB.prepare('SELECT is_active FROM products WHERE id = ?').bind(productId).first<{ is_active: number }>();
    expect(row!.is_active).toBe(0);

    const console_ = await consoleRequest('/api/console/categories', { cookie: owner.cookie });
    const { categories } = (await console_.json()) as { categories: { products: { id: string }[] }[] };
    expect(categories.flatMap((c) => c.products).some((p) => p.id === productId)).toBe(true);

    const { readPublicMenu } = await import('@qr/catalog/catalog-read');
    const { STORE_ID } = await import('@qr/identity/store');
    const publicMenu = await readPublicMenu(env.DB, STORE_ID);
    expect(publicMenu.flatMap((c) => c.products).some((p) => p.id === productId)).toBe(false);
  });

  it('T9: toggling availability leaves the product visible in Console but marked unavailable', async () => {
    const owner = await createConsoleSession({ role: 'owner', status: 'active' });
    const category = await ownerCategory(owner.cookie);
    const created = await consoleRequest('/api/console/products', { method: 'POST', cookie: owner.cookie, ...json({ categoryId: category.id, name: 'Nước', price: '15000' }) });
    const { id: productId } = (await created.json()) as { id: string };

    const toggled = await consoleRequest(`/api/console/products/${productId}/availability`, { method: 'POST', cookie: owner.cookie, ...json({ available: false }) });
    expect(toggled.status).toBe(200);
    const row = await env.DB.prepare('SELECT is_available FROM products WHERE id = ?').bind(productId).first<{ is_available: number }>();
    expect(row!.is_available).toBe(0);
  });

  it('image PUT: Content-Length over 5MB is refused before the body is read (413)', async () => {
    const owner = await createConsoleSession({ role: 'owner', status: 'active' });
    const category = await ownerCategory(owner.cookie);
    const created = await consoleRequest('/api/console/products', { method: 'POST', cookie: owner.cookie, ...json({ categoryId: category.id, name: 'Ảnh', price: '10000' }) });
    const { id: productId } = (await created.json()) as { id: string };

    const response = await consoleRequest(`/api/console/products/${productId}/image`, {
      method: 'PUT',
      cookie: owner.cookie,
      headers: { 'content-length': '6000000', 'x-expected-revision': '1', 'x-filename': 'x.jpg' },
      body: new Uint8Array(0),
    });
    expect(response.status).toBe(413);
  });

  it('image PUT: a body whose magic bytes are not JPEG/PNG/WebP is refused (415)', async () => {
    const owner = await createConsoleSession({ role: 'owner', status: 'active' });
    const category = await ownerCategory(owner.cookie);
    const created = await consoleRequest('/api/console/products', { method: 'POST', cookie: owner.cookie, ...json({ categoryId: category.id, name: 'Ảnh2', price: '10000' }) });
    const { id: productId } = (await created.json()) as { id: string };

    const pdfBytes = new TextEncoder().encode('%PDF-1.4 not an image');
    const response = await consoleRequest(`/api/console/products/${productId}/image`, {
      method: 'PUT',
      cookie: owner.cookie,
      headers: { 'x-expected-revision': '1', 'x-filename': 'x.pdf' },
      body: pdfBytes,
    });
    expect(response.status).toBe(415);
  });
});
