import { generateOpaqueToken, sha256Hex } from '@qr/identity/token-digest';
import type { WriteResult } from './catalog-write.ts';

// Owns all writes to tables and table_secrets. Reading a table by token lives in tables-read.ts.

/** How long a rotated-out table token keeps working, so guests already seated are not cut off (D17). */
export const TABLE_TOKEN_GRACE_MS = 15 * 60 * 1000;

const NUMBER_TAKEN = /UNIQUE constraint failed: tables\.store_id, tables\.table_number/;
const ROTATION_ASSERTION_FAILED = /NOT NULL constraint failed: tables\.table_number/;

export type TableSummary = { id: string; tableNumber: string; isActive: boolean; liveTokens: number };

export async function createTable(db: D1Database, storeId: string, tableNumber: string): Promise<WriteResult<{ id: string }>> {
  const id = crypto.randomUUID();
  try {
    await db.prepare('INSERT INTO tables (id, store_id, table_number) VALUES (?, ?, ?)').bind(id, storeId, tableNumber).run();
    return { ok: true, id };
  } catch (error) {
    if (NUMBER_TAKEN.test(String(error))) return { ok: false, code: 'table_number_taken' };
    throw error;
  }
}

export async function updateTable(db: D1Database, storeId: string, id: string, patch: { tableNumber?: string; isActive?: boolean }): Promise<WriteResult> {
  try {
    const result = await db
      .prepare('UPDATE tables SET table_number = COALESCE(?, table_number), is_active = COALESCE(?, is_active) WHERE store_id = ? AND id = ?')
      .bind(patch.tableNumber ?? null, patch.isActive === undefined ? null : Number(patch.isActive), storeId, id)
      .run();
    return result.meta.changes === 1 ? { ok: true } : { ok: false, code: 'not_found' };
  } catch (error) {
    if (NUMBER_TAKEN.test(String(error))) return { ok: false, code: 'table_number_taken' };
    throw error;
  }
}

/** Tables with the number of currently valid tokens; tokens themselves are never readable (only digests exist). */
export async function listTables(db: D1Database, storeId: string, now: Date = new Date()): Promise<TableSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT t.id, t.table_number, t.is_active,
         (SELECT count(*) FROM table_secrets s WHERE s.store_id = t.store_id AND s.table_id = t.id AND (s.revoked_at IS NULL OR s.revoked_at > ?)) AS live_tokens
       FROM tables t WHERE t.store_id = ? ORDER BY t.table_number`,
    )
    .bind(now.toISOString(), storeId)
    .all<{ id: string; table_number: string; is_active: number; live_tokens: number }>();
  return results.map((row) => ({ id: row.id, tableNumber: row.table_number, isActive: row.is_active === 1, liveTokens: row.live_tokens }));
}

/**
 * "Export QR": a new token for the table, returned exactly once. In one batch every current token gets
 * revoked_at = now + grace, the new digest is inserted, and an assertion requires exactly one unrevoked token.
 */
export async function issueTableToken(db: D1Database, storeId: string, tableId: string, now: Date = new Date()): Promise<WriteResult<{ token: string }>> {
  const exists = await db.prepare('SELECT 1 AS found FROM tables WHERE store_id = ? AND id = ?').bind(storeId, tableId).first();
  if (!exists) return { ok: false, code: 'not_found' };
  const token = generateOpaqueToken();
  try {
    await db.batch([
      db
        .prepare('UPDATE table_secrets SET revoked_at = ? WHERE store_id = ? AND table_id = ? AND revoked_at IS NULL')
        .bind(new Date(now.getTime() + TABLE_TOKEN_GRACE_MS).toISOString(), storeId, tableId),
      db
        .prepare('INSERT INTO table_secrets (id, store_id, table_id, token_digest, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(crypto.randomUUID(), storeId, tableId, await sha256Hex(token), now.toISOString()),
      db
        .prepare(
          `UPDATE tables SET table_number = CASE
             WHEN (SELECT count(*) FROM table_secrets WHERE store_id = ? AND table_id = ? AND revoked_at IS NULL) = 1 THEN table_number
             ELSE NULL END
           WHERE store_id = ? AND id = ?`,
        )
        .bind(storeId, tableId, storeId, tableId),
    ]);
  } catch (error) {
    // Two rotations raced: both batches' assertions saw two live tokens; the caller retries.
    if (ROTATION_ASSERTION_FAILED.test(String(error))) return { ok: false, code: 'rotation_conflict' };
    throw error;
  }
  return { ok: true, token };
}
