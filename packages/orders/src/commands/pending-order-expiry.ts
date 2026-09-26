// Time-based rules for unpaid orders (D6). Each step is one conditional UPDATE whose WHERE clause re-checks the current
// state, so overlapping cron runs converge on the same result without locks.

const MINUTE_MS = 60_000;
/** Older unpaid orders make the reconciliation job consult the bank. */
export const RECONCILE_AFTER_MS = 2 * MINUTE_MS;
export const FLAG_AFTER_MS = 15 * MINUTE_MS;
export const CANCEL_AFTER_MS = 30 * MINUTE_MS;
/** Money can still arrive for an order cancelled this recently (the payment provider retries webhooks for ~2.8 hours, F13). */
export const LATE_PAYMENT_WINDOW_MS = 3 * 60 * MINUTE_MS;

const before = (now: Date, ms: number) => new Date(now.getTime() - ms).toISOString();

/** Whether any order is old enough to be reconciled against the bank, or recent enough to receive late money. */
export async function hasReconciliationCandidates(db: D1Database, storeId: string, now: Date): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS found FROM orders
       WHERE store_id = ?
         AND ((status = 'pending_payment' AND created_at <= ?) OR (status = 'cancelled' AND created_at >= ?))
       LIMIT 1`,
    )
    .bind(storeId, before(now, RECONCILE_AFTER_MS), before(now, LATE_PAYMENT_WINDOW_MS))
    .first();
  return row !== null;
}

/** Flags unpaid orders older than 15 minutes for the owner; already-flagged orders are left untouched. */
export async function flagStalePendingOrders(db: D1Database, storeId: string, now: Date): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE orders SET needs_attention = 1, updated_at = ?
       WHERE store_id = ? AND status = 'pending_payment' AND needs_attention = 0 AND created_at <= ?`,
    )
    .bind(now.toISOString(), storeId, before(now, FLAG_AFTER_MS))
    .run();
  return result.meta.changes;
}

/** Cancels unpaid orders older than 30 minutes (pending_payment → cancelled, D9). Run after settlement. */
export async function cancelExpiredPendingOrders(db: D1Database, storeId: string, now: Date): Promise<number> {
  const result = await db
    .prepare(`UPDATE orders SET status = 'cancelled', updated_at = ? WHERE store_id = ? AND status = 'pending_payment' AND created_at <= ?`)
    .bind(now.toISOString(), storeId, before(now, CANCEL_AFTER_MS))
    .run();
  return result.meta.changes;
}
