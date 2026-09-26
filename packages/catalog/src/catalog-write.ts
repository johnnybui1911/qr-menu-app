// Owns all writes to categories and products (C3). Menu edits are optimistic: product updates carry the revision the
// owner last saw, and a stale revision changes nothing (409 revision_conflict) instead of silently overwriting.

export type WriteResult<T extends object = object> = ({ ok: true } & T) | { ok: false; code: string };

const SLUG_TAKEN = /UNIQUE constraint failed: categories\.store_id, categories\.slug/;
const FOREIGN_KEY_FAILED = /FOREIGN KEY constraint failed/;

export type CategoryInput = { name: string; slug: string; displayOrder: number };

export async function createCategory(db: D1Database, storeId: string, input: CategoryInput): Promise<WriteResult<{ id: string }>> {
  const id = crypto.randomUUID();
  try {
    await db
      .prepare('INSERT INTO categories (id, store_id, name, slug, display_order) VALUES (?, ?, ?, ?, ?)')
      .bind(id, storeId, input.name, input.slug, input.displayOrder)
      .run();
    return { ok: true, id };
  } catch (error) {
    if (SLUG_TAKEN.test(String(error))) return { ok: false, code: 'slug_taken' };
    throw error;
  }
}

export type CategoryPatch = Partial<CategoryInput & { isActive: boolean }>;

export async function updateCategory(db: D1Database, storeId: string, id: string, patch: CategoryPatch): Promise<WriteResult> {
  try {
    const result = await db
      .prepare(
        `UPDATE categories SET name = COALESCE(?, name), slug = COALESCE(?, slug), display_order = COALESCE(?, display_order),
           is_active = COALESCE(?, is_active), updated_at = ?
         WHERE store_id = ? AND id = ?`,
      )
      .bind(
        patch.name ?? null,
        patch.slug ?? null,
        patch.displayOrder ?? null,
        patch.isActive === undefined ? null : Number(patch.isActive),
        new Date().toISOString(),
        storeId,
        id,
      )
      .run();
    return result.meta.changes === 1 ? { ok: true } : { ok: false, code: 'not_found' };
  } catch (error) {
    if (SLUG_TAKEN.test(String(error))) return { ok: false, code: 'slug_taken' };
    throw error;
  }
}

/** Only an empty category can be deleted; hidden products still reference theirs, so they block deletion too. */
export async function deleteCategory(db: D1Database, storeId: string, id: string): Promise<WriteResult> {
  const result = await db
    .prepare('DELETE FROM categories WHERE store_id = ? AND id = ? AND NOT EXISTS (SELECT 1 FROM products WHERE store_id = ? AND category_id = ?)')
    .bind(storeId, id, storeId, id)
    .run();
  if (result.meta.changes === 1) return { ok: true };
  const exists = await db.prepare('SELECT 1 AS found FROM categories WHERE store_id = ? AND id = ?').bind(storeId, id).first();
  return { ok: false, code: exists ? 'category_not_empty' : 'not_found' };
}

export type ProductInput = { categoryId: string; name: string; description: string; priceMinor: number; displayOrder: number };

export async function createProduct(db: D1Database, storeId: string, input: ProductInput): Promise<WriteResult<{ id: string; revision: number }>> {
  const id = crypto.randomUUID();
  try {
    await db
      .prepare('INSERT INTO products (id, store_id, category_id, name, description, price_minor, display_order) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, storeId, input.categoryId, input.name, input.description, input.priceMinor, input.displayOrder)
      .run();
    return { ok: true, id, revision: 1 };
  } catch (error) {
    if (FOREIGN_KEY_FAILED.test(String(error))) return { ok: false, code: 'category_not_found' };
    throw error;
  }
}

export type ProductPatch = Partial<ProductInput>;

/** Applies the patch only if the product is still at `expectedRevision`, bumping the revision. */
export async function updateProduct(
  db: D1Database,
  storeId: string,
  id: string,
  expectedRevision: number,
  patch: ProductPatch,
): Promise<WriteResult<{ revision: number }>> {
  try {
    const row = await db
      .prepare(
        `UPDATE products SET category_id = COALESCE(?, category_id), name = COALESCE(?, name), description = COALESCE(?, description),
           price_minor = COALESCE(?, price_minor), display_order = COALESCE(?, display_order), revision = revision + 1, updated_at = ?
         WHERE store_id = ? AND id = ? AND revision = ?
         RETURNING revision`,
      )
      .bind(
        patch.categoryId ?? null,
        patch.name ?? null,
        patch.description ?? null,
        patch.priceMinor ?? null,
        patch.displayOrder ?? null,
        new Date().toISOString(),
        storeId,
        id,
        expectedRevision,
      )
      .first<{ revision: number }>();
    if (row) return { ok: true, revision: row.revision };
  } catch (error) {
    if (FOREIGN_KEY_FAILED.test(String(error))) return { ok: false, code: 'category_not_found' };
    throw error;
  }
  const exists = await db.prepare('SELECT 1 AS found FROM products WHERE store_id = ? AND id = ?').bind(storeId, id).first();
  return { ok: false, code: exists ? 'revision_conflict' : 'not_found' };
}

/** Stock toggle ("hết món"). Not revision-checked: it touches a single flag the edit form never writes. */
export async function setProductAvailability(db: D1Database, storeId: string, id: string, available: boolean): Promise<WriteResult> {
  const result = await db
    .prepare('UPDATE products SET is_available = ?, updated_at = ? WHERE store_id = ? AND id = ?')
    .bind(Number(available), new Date().toISOString(), storeId, id)
    .run();
  return result.meta.changes === 1 ? { ok: true } : { ok: false, code: 'not_found' };
}

/** "Delete" for products: hide from every menu and from ordering; past orders keep their snapshot and FK. */
export async function hideProduct(db: D1Database, storeId: string, id: string): Promise<WriteResult> {
  const result = await db
    .prepare('UPDATE products SET is_active = 0, revision = revision + 1, updated_at = ? WHERE store_id = ? AND id = ?')
    .bind(new Date().toISOString(), storeId, id)
    .run();
  return result.meta.changes === 1 ? { ok: true } : { ok: false, code: 'not_found' };
}
