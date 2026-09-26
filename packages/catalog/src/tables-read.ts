import { sha256Hex } from '@qr/identity/token-digest';

export type ResolvedTable = { id: string; tableNumber: string };

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;

/**
 * Resolves a table from its customer token by joining on the token digest (D8, D17). A rotated token stays valid until
 * its revoked_at passes. Every failure returns null so callers answer with one uniform 404.
 */
export async function resolveTableByToken(db: D1Database, storeId: string, token: string | null, now: string): Promise<ResolvedTable | null> {
  if (!token || !TOKEN_PATTERN.test(token)) return null;
  return db
    .prepare(
      `SELECT t.id, t.table_number AS tableNumber
       FROM table_secrets s
       JOIN tables t ON t.id = s.table_id AND t.store_id = s.store_id
       WHERE s.store_id = ? AND s.token_digest = ? AND (s.revoked_at IS NULL OR s.revoked_at > ?) AND t.is_active = 1`,
    )
    .bind(storeId, await sha256Hex(token), now)
    .first<ResolvedTable>();
}
