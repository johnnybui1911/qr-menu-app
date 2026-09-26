import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STORE_ID } from '@qr/identity/store';
import { createCategory, createProduct } from '@qr/catalog/catalog-write';
import { removeProductImage, uploadProductImage } from '@qr/catalog/files/product-image';
import { resetDb } from '../support/test-env.ts';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 7, 7, 7]);
const body = (bytes: Uint8Array<ArrayBuffer> = JPEG) => new Blob([bytes]).stream();
let productId: string;

const imageRow = () =>
  env.DB.prepare('SELECT image_key, image_filename, image_content_type, image_size, revision FROM products WHERE id = ?').bind(productId).first<{
    image_key: string | null;
    revision: number;
  }>();

beforeEach(async () => {
  await resetDb();
  const category = await createCategory(env.DB, STORE_ID, { name: 'A', slug: 'a', displayOrder: 0 });
  const product = await createProduct(env.DB, STORE_ID, { categoryId: category.ok ? category.id : '', name: 'Trà', description: '', priceMinor: 1, displayOrder: 0 });
  productId = product.ok ? product.id : '';
});

describe('product images: create = R2 first, then D1 (D13)', () => {
  it('stores the object under an opaque key and records all four columns', async () => {
    const result = await uploadProductImage(env.DB, env.FILES, { storeId: STORE_ID, productId, expectedRevision: 1, filename: 'tra.jpg', body: body() });
    expect(result).toMatchObject({ ok: true, revision: 2 });
    const row = await imageRow();
    expect(row).toMatchObject({ image_filename: 'tra.jpg', image_content_type: 'image/jpeg', image_size: JPEG.byteLength, revision: 2 });
    expect(row!.image_key).toMatch(/^product-images\/[0-9a-f-]{36}$/);
    expect(await (await env.FILES.get(row!.image_key!))!.arrayBuffer()).toEqual(JPEG.buffer);
  });

  it('never writes a file it could not identify', async () => {
    const put = vi.spyOn(env.FILES, 'put');
    const pdf = new TextEncoder().encode('%PDF-1.7 pretend jpeg');
    expect(await uploadProductImage(env.DB, env.FILES, { storeId: STORE_ID, productId, expectedRevision: 1, filename: 'x.jpg', body: body(pdf) })).toEqual({
      ok: false,
      code: 'product_image_type_unsupported',
    });
    expect(put).not.toHaveBeenCalled();
    put.mockRestore();
  });

  it('deletes the new object again when the D1 write loses on revision', async () => {
    // R2 is not reset between tests, so compare the object count around the upload.
    const before = (await env.FILES.list({ prefix: 'product-images/' })).objects.length;
    const result = await uploadProductImage(env.DB, env.FILES, { storeId: STORE_ID, productId, expectedRevision: 7, filename: 'x.jpg', body: body() });
    expect(result).toEqual({ ok: false, code: 'revision_conflict' });
    expect((await env.FILES.list({ prefix: 'product-images/' })).objects).toHaveLength(before);
    expect((await imageRow())!.image_key).toBeNull();
  });

  it('replaces an image and removes the previous object after D1 commits', async () => {
    await uploadProductImage(env.DB, env.FILES, { storeId: STORE_ID, productId, expectedRevision: 1, filename: 'a.jpg', body: body() });
    const first = (await imageRow())!.image_key!;
    await uploadProductImage(env.DB, env.FILES, { storeId: STORE_ID, productId, expectedRevision: 2, filename: 'b.jpg', body: body() });
    const second = (await imageRow())!.image_key!;
    expect(second).not.toBe(first);
    expect(await env.FILES.head(first)).toBeNull();
    expect(await env.FILES.head(second)).not.toBeNull();
  });

  it('rejects metadata that is not all-or-none', async () => {
    await expect(env.DB.prepare("UPDATE products SET image_key = 'product-images/x' WHERE id = ?").bind(productId).run()).rejects.toThrow(
      /CHECK constraint failed: products_image_all_or_none/,
    );
  });

  it('removes an image D1 first and still succeeds when R2 fails', async () => {
    await uploadProductImage(env.DB, env.FILES, { storeId: STORE_ID, productId, expectedRevision: 1, filename: 'a.jpg', body: body() });
    const failingBucket = { delete: async () => Promise.reject(new Error('r2 down')) } as unknown as R2Bucket;
    expect(await removeProductImage(env.DB, failingBucket, { storeId: STORE_ID, productId })).toEqual({ ok: true });
    expect(await imageRow()).toMatchObject({ image_key: null, image_filename: null, image_content_type: null, image_size: null });
  });
});

describe('GET /api/storefront/product-images/:uuid', () => {
  it('serves an image with immutable caching, ETag, nosniff and 304 on revalidation', async () => {
    await uploadProductImage(env.DB, env.FILES, { storeId: STORE_ID, productId, expectedRevision: 1, filename: 'a.jpg', body: body() });
    const uuid = (await imageRow())!.image_key!.slice('product-images/'.length);
    const first = await exports.default.fetch(`http://api.test/api/storefront/product-images/${uuid}`);
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(first.headers.get('content-type')).toBe('image/jpeg');
    expect(first.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(JPEG);
    const etag = first.headers.get('etag')!;
    const again = await exports.default.fetch(`http://api.test/api/storefront/product-images/${uuid}`, { headers: { 'if-none-match': etag } });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe('');
  });

  it('answers every unknown or foreign key with the same 404 and only reads product-images/', async () => {
    await env.FILES.put('secrets/x', 'do not serve');
    const get = vi.spyOn(env.FILES, 'get');
    const paths = ['0f8fad5b-d9cb-469f-a165-70867728950e', 'not-a-uuid', '..%2Fsecrets%2Fx', 'secrets%2Fx'];
    const responses = await Promise.all(paths.map((p) => exports.default.fetch(`http://api.test/api/storefront/product-images/${p}`)));
    for (const response of responses) expect({ status: response.status, body: await response.json() }).toEqual({ status: 404, body: { error: 'not_found' } });
    for (const [key] of get.mock.calls) expect(key).toMatch(/^product-images\//);
    get.mockRestore();
  });
});
