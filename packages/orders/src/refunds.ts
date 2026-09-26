import {
  assertPreviousWriteChangedOneRow,
  checkCommandLedger,
  COMMAND_ASSERTION_FAILED,
  COMMAND_KEY_TAKEN,
  insertCommandStatement,
  payloadHash,
} from './command-ledger.ts';
import type { CommandOutcome } from './commands/order-commands.ts';
import { enqueueEmailJobStatement } from './email-outbox.ts';

// Owns all SQL for refund_requests. Approving records the refund (O4): the owner moves money by hand; no code path
// transfers money.

const REFUNDABLE_STATUSES_SQL = "('paid', 'preparing', 'fulfilled')";
const REFUND_TAKEN = /UNIQUE constraint failed: refund_requests\.store_id, refund_requests\.order_id/;

type RequestResult = { refundRequestId: string; orderId: string; status: 'pending' };
type DecisionResult = { refundRequestId: string; orderId: string; status: 'approved' | 'rejected'; orderStatus: string };

export type RefundRequestInput = { storeId: string; orderId: string; staffUserId: string; reason: string; requestKey: string };

export async function requestRefund(
  db: D1Database,
  input: RefundRequestInput,
): Promise<CommandOutcome<RequestResult> | { kind: 'refund_already_requested' }> {
  const { storeId, orderId, staffUserId, reason, requestKey } = input;
  const hash = await payloadHash({ action: 'refund:request', orderId, actorUserId: staffUserId, body: { reason } });
  const ledger = await checkCommandLedger<RequestResult>(db, storeId, requestKey, hash);
  if (ledger) return ledger;

  const result: RequestResult = { refundRequestId: crypto.randomUUID(), orderId, status: 'pending' };
  try {
    await db.batch([
      insertCommandStatement(db, { storeId, requestKey, payloadHash: hash, action: 'refund:request', orderId }, result),
      // Only an order that was actually paid can be refunded; otherwise nothing is inserted and the assertion aborts.
      db
        .prepare(
          `INSERT INTO refund_requests (id, store_id, order_id, requested_by_staff_id, reason)
           SELECT ?, store_id, id, ?, ? FROM orders WHERE store_id = ? AND id = ? AND status IN ${REFUNDABLE_STATUSES_SQL}`,
        )
        .bind(result.refundRequestId, staffUserId, reason, storeId, orderId),
      assertPreviousWriteChangedOneRow(db, storeId, orderId),
    ]);
    return { kind: 'done', result };
  } catch (error) {
    const message = String(error);
    if (COMMAND_KEY_TAKEN.test(message)) return (await checkCommandLedger<RequestResult>(db, storeId, requestKey, hash)) ?? { kind: 'idempotency_conflict' };
    if (REFUND_TAKEN.test(message)) return { kind: 'refund_already_requested' };
    if (COMMAND_ASSERTION_FAILED.test(message)) {
      const exists = await db.prepare('SELECT 1 AS found FROM orders WHERE store_id = ? AND id = ?').bind(storeId, orderId).first();
      return exists ? { kind: 'invalid_transition' } : { kind: 'not_found' };
    }
    throw error;
  }
}

export type RefundDecisionInput = { storeId: string; refundRequestId: string; decision: 'approve' | 'reject'; ownerUserId: string; requestKey: string };

/**
 * Approve: refund approved + order refunded + refund_confirmed email, in one batch. Reject: refund rejected only.
 * The WHERE status = 'pending' guard makes a second decision a 409 before the immutability trigger is ever reached.
 */
export async function decideRefund(db: D1Database, input: RefundDecisionInput, now: Date = new Date()): Promise<CommandOutcome<DecisionResult>> {
  const { storeId, refundRequestId, decision, ownerUserId, requestKey } = input;
  const refund = await db
    .prepare(
      `SELECT r.order_id, r.status, o.status AS order_status, o.order_code, o.total_amount_minor
       FROM refund_requests r JOIN orders o ON o.id = r.order_id AND o.store_id = r.store_id
       WHERE r.store_id = ? AND r.id = ?`,
    )
    .bind(storeId, refundRequestId)
    .first<{ order_id: string; status: string; order_status: string; order_code: string; total_amount_minor: number }>();
  if (!refund) return { kind: 'not_found' };

  const orderId = refund.order_id;
  const action = decision === 'approve' ? 'refund:approve' : 'refund:reject';
  const hash = await payloadHash({ action, orderId, actorUserId: ownerUserId, body: { refundRequestId } });
  const ledger = await checkCommandLedger<DecisionResult>(db, storeId, requestKey, hash);
  if (ledger) return ledger;
  if (refund.status !== 'pending') return { kind: 'invalid_transition' };

  const approved = decision === 'approve';
  const result: DecisionResult = {
    refundRequestId,
    orderId,
    status: approved ? 'approved' : 'rejected',
    orderStatus: approved ? 'refunded' : refund.order_status,
  };
  const nowIso = now.toISOString();
  const statements = [
    insertCommandStatement(db, { storeId, requestKey, payloadHash: hash, action, orderId }, result),
    db
      .prepare("UPDATE refund_requests SET status = ?, decided_at = ?, decided_by_user_id = ? WHERE store_id = ? AND id = ? AND status = 'pending'")
      .bind(result.status, nowIso, ownerUserId, storeId, refundRequestId),
    assertPreviousWriteChangedOneRow(db, storeId, orderId),
  ];
  if (approved) {
    statements.push(
      db
        .prepare(`UPDATE orders SET status = 'refunded', updated_at = ? WHERE store_id = ? AND id = ? AND status IN ${REFUNDABLE_STATUSES_SQL}`)
        .bind(nowIso, storeId, orderId),
      assertPreviousWriteChangedOneRow(db, storeId, orderId),
      enqueueEmailJobStatement(db, {
        storeId,
        kind: 'refund_confirmed',
        orderId,
        dedupeKey: `refund:${orderId}`,
        payload: { orderCode: refund.order_code, amountMinor: refund.total_amount_minor },
      }),
    );
  }
  try {
    await db.batch(statements);
    return { kind: 'done', result };
  } catch (error) {
    const message = String(error);
    if (COMMAND_KEY_TAKEN.test(message)) return (await checkCommandLedger<DecisionResult>(db, storeId, requestKey, hash)) ?? { kind: 'idempotency_conflict' };
    if (COMMAND_ASSERTION_FAILED.test(message) || /refund_decision_is_final/.test(message)) return { kind: 'invalid_transition' };
    throw error;
  }
}

export type RefundRequestView = {
  id: string;
  orderId: string;
  orderCode: string;
  tableNumber: string;
  amountMinor: number;
  orderStatus: string;
  reason: string;
  status: string;
  requestedByStaffId: string;
  createdAt: string;
  decidedAt: string | null;
};

type RefundRequestRow = {
  id: string;
  order_id: string;
  order_code: string;
  table_number: string;
  total_amount_minor: number;
  order_status: string;
  reason: string;
  status: string;
  requested_by_staff_id: string;
  created_at: string;
  decided_at: string | null;
};

/** Refund requests for the owner's review, oldest first; `status` narrows to one state. */
export async function listRefundRequests(db: D1Database, storeId: string, status: 'pending' | 'approved' | 'rejected' | null): Promise<RefundRequestView[]> {
  const { results } = await db
    .prepare(
      `SELECT r.id, r.order_id, o.order_code, t.table_number, o.total_amount_minor, o.status AS order_status, r.reason, r.status,
              r.requested_by_staff_id, r.created_at, r.decided_at
       FROM refund_requests r
       JOIN orders o ON o.id = r.order_id AND o.store_id = r.store_id
       JOIN tables t ON t.id = o.table_id AND t.store_id = o.store_id
       WHERE r.store_id = ? AND (? IS NULL OR r.status = ?)
       ORDER BY r.created_at, r.id LIMIT 200`,
    )
    .bind(storeId, status, status)
    .all<RefundRequestRow>();
  return results.map((row) => ({
    id: row.id,
    orderId: row.order_id,
    orderCode: row.order_code,
    tableNumber: row.table_number,
    amountMinor: row.total_amount_minor,
    orderStatus: row.order_status,
    reason: row.reason,
    status: row.status,
    requestedByStaffId: row.requested_by_staff_id,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  }));
}
