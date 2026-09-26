import { sha256Hex } from '@qr/identity/token-digest';

// Owns all SQL for order_commands: the console-command idempotency tier (D10). Same key + same payload replays the
// stored result without re-running the command; same key + different payload is a conflict.

export type CommandPayload = { action: string; orderId: string; actorUserId: string; body: unknown };

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function payloadHash(payload: CommandPayload): Promise<string> {
  return sha256Hex(canonicalJson(payload));
}

export type CommandInput = { storeId: string; requestKey: string; payloadHash: string; action: string; orderId: string };

export function insertCommandStatement(db: D1Database, command: CommandInput, result: unknown): D1PreparedStatement {
  return db
    .prepare('INSERT INTO order_commands (id, store_id, request_key, payload_hash, action, order_id, result_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), command.storeId, command.requestKey, command.payloadHash, command.action, command.orderId, JSON.stringify(result));
}

export type LedgerVerdict<T> = { kind: 'replay'; result: T } | { kind: 'idempotency_conflict' };

/** Reads the ledger for a request key: null when unused, else a replay of the stored result or a conflict. */
export async function checkCommandLedger<T>(db: D1Database, storeId: string, requestKey: string, hash: string): Promise<LedgerVerdict<T> | null> {
  const row = await db
    .prepare('SELECT payload_hash, result_json FROM order_commands WHERE store_id = ? AND request_key = ?')
    .bind(storeId, requestKey)
    .first<{ payload_hash: string; result_json: string }>();
  if (!row) return null;
  return row.payload_hash === hash ? { kind: 'replay', result: JSON.parse(row.result_json) as T } : { kind: 'idempotency_conflict' };
}

export const COMMAND_KEY_TAKEN = /UNIQUE constraint failed: order_commands\.store_id, order_commands\.request_key/;
/** Every console batch asserts with `changes() = 1` right after its guarded write; a miss nulls orders.order_code. */
export const COMMAND_ASSERTION_FAILED = /NOT NULL constraint failed: orders\.order_code/;

/**
 * The statement that must directly follow a guarded write in a batch: it aborts the whole batch unless that write
 * changed exactly one row. Unlike re-checking the final state, this also catches a concurrent command that already
 * performed the same transition (its UPDATE matched zero rows here).
 */
export function assertPreviousWriteChangedOneRow(db: D1Database, storeId: string, orderId: string): D1PreparedStatement {
  return db
    .prepare('UPDATE orders SET order_code = CASE WHEN changes() = 1 THEN order_code ELSE NULL END WHERE store_id = ? AND id = ?')
    .bind(storeId, orderId);
}
