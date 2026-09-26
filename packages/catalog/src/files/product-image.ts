import type { WriteResult } from '../catalog-write.ts';

// Product images in R2 (D13). Keys are opaque (`product-images/<uuid>`), the MIME type comes from magic bytes, and
// the write order differs by direction: create = R2 first then D1 (compensate on failure); delete = D1 first then R2.

export const MAX_PRODUCT_IMAGE_BYTES = 5_000_000;
export const PRODUCT_IMAGE_PREFIX = 'product-images/';
export type ProductImageType = 'image/jpeg' | 'image/png' | 'image/webp';

const COMPENSATION_ATTEMPTS = 3;

/** MIME from the first 12 bytes; anything outside JPEG/PNG/WebP (SVG, PDF, HTML…) is refused. */
export function contentTypeFor(head: Uint8Array): ProductImageType | null {
  const starts = (...signature: number[]) => signature.every((byte, i) => head[i] === byte);
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (starts(0x52, 0x49, 0x46, 0x46) && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50) return 'image/webp';
  return null;
}

export type ReadImageResult =
  | { ok: true; bytes: Uint8Array; contentType: ProductImageType; size: number }
  | { ok: false; code: 'product_image_size_exceeded' | 'product_image_type_unsupported' | 'product_image_empty' };

/** Reads the upload while counting bytes, cancelling the stream the moment it passes `limit`. */
export async function readProductImage(stream: ReadableStream<Uint8Array>, limit: number): Promise<ReadImageResult> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return { ok: false, code: 'product_image_size_exceeded' };
    }
    chunks.push(value);
  }
  if (size === 0) return { ok: false, code: 'product_image_empty' };
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const contentType = contentTypeFor(bytes.subarray(0, 12));
  if (!contentType) return { ok: false, code: 'product_image_type_unsupported' };
  return { ok: true, bytes, contentType, size };
}

async function bestEffortDelete(bucket: R2Bucket, key: string): Promise<boolean> {
  for (let attempt = 0; attempt < COMPENSATION_ATTEMPTS; attempt++) {
    try {
      await bucket.delete(key);
      return true;
    } catch {
      // Retry; an orphaned opaque object is acceptable, wrong D1 metadata is not (D13).
    }
  }
  return false;
}

export type UploadInput = { storeId: string; productId: string; expectedRevision: number; filename: string; body: ReadableStream<Uint8Array> };

export async function uploadProductImage(db: D1Database, bucket: R2Bucket, input: UploadInput): Promise<WriteResult<{ revision: number; orphanedKey?: string }>> {
  const image = await readProductImage(input.body, MAX_PRODUCT_IMAGE_BYTES);
  if (!image.ok) return image;

  const key = `${PRODUCT_IMAGE_PREFIX}${crypto.randomUUID()}`;
  const stored = await bucket.put(key, image.bytes, { httpMetadata: { contentType: image.contentType } });
  if (stored.size !== image.size) {
    await bestEffortDelete(bucket, key);
    return { ok: false, code: 'product_image_store_failed' };
  }

  const previous = await db
    .prepare('SELECT image_key FROM products WHERE store_id = ? AND id = ?')
    .bind(input.storeId, input.productId)
    .first<{ image_key: string | null }>();
  const row = await db
    .prepare(
      `UPDATE products SET image_key = ?, image_filename = ?, image_content_type = ?, image_size = ?, revision = revision + 1, updated_at = ?
       WHERE store_id = ? AND id = ? AND revision = ?
       RETURNING revision`,
    )
    .bind(key, input.filename.slice(0, 200), image.contentType, image.size, new Date().toISOString(), input.storeId, input.productId, input.expectedRevision)
    .first<{ revision: number }>();
  if (!row) {
    const removed = await bestEffortDelete(bucket, key);
    return { ok: false, code: previous ? 'revision_conflict' : 'not_found', ...(removed ? {} : { orphanedKey: key }) };
  }
  // The new image is committed in D1; the replaced object goes last and best-effort.
  if (previous?.image_key) await bestEffortDelete(bucket, previous.image_key);
  return { ok: true, revision: row.revision };
}

/** Delete: clear the four columns in D1 first, then remove the object; an R2 failure never fails the request. */
export async function removeProductImage(db: D1Database, bucket: R2Bucket, input: { storeId: string; productId: string }): Promise<WriteResult> {
  const current = await db
    .prepare('SELECT image_key FROM products WHERE store_id = ? AND id = ?')
    .bind(input.storeId, input.productId)
    .first<{ image_key: string | null }>();
  if (!current) return { ok: false, code: 'not_found' };
  if (!current.image_key) return { ok: true };
  // Guarded on the key just read, so a concurrent upload is never cleared by a stale delete.
  const result = await db
    .prepare(
      `UPDATE products SET image_key = NULL, image_filename = NULL, image_content_type = NULL, image_size = NULL, revision = revision + 1, updated_at = ?
       WHERE store_id = ? AND id = ? AND image_key = ?`,
    )
    .bind(new Date().toISOString(), input.storeId, input.productId, current.image_key)
    .run();
  if (result.meta.changes !== 1) return { ok: false, code: 'revision_conflict' };
  await bestEffortDelete(bucket, current.image_key);
  return { ok: true };
}
