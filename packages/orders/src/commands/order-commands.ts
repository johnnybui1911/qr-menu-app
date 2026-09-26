import {
  assertPreviousWriteChangedOneRow,
  checkCommandLedger,
  COMMAND_ASSERTION_FAILED,
  COMMAND_KEY_TAKEN,
  insertCommandStatement,
  payloadHash,
} from '../command-ledger.ts';
import { fulfillEligible, startPreparingEligible, type OrderStatus } from '../transitions/order-transitions.ts';

export type KitchenAction = 'order:prepare' | 'order:fulfill';
type TransitionResult = { orderId: string; status: OrderStatus };

export type CommandOutcome<T> =
  | { kind: 'done'; result: T }
  | { kind: 'replay'; result: T }
  | { kind: 'idempotency_conflict' }
  | { kind: 'invalid_transition' }
  | { kind: 'not_found' };

const TRANSITIONS: Record<KitchenAction, { from: OrderStatus; to: OrderStatus; eligible: (status: string) => boolean }> = {
  'order:prepare': { from: 'paid', to: 'preparing', eligible: startPreparingEligible },
  'order:fulfill': { from: 'preparing', to: 'fulfilled', eligible: fulfillEligible },
};

export type TransitionInput = { storeId: string; orderId: string; action: KitchenAction; actorUserId: string; requestKey: string };

/** paid → preparing → fulfilled from the console. Illegal or lost-race transitions are 409s with no side effect. */
export async function transitionOrder(db: D1Database, input: TransitionInput, now: Date = new Date()): Promise<CommandOutcome<TransitionResult>> {
  const { storeId, orderId, action, actorUserId, requestKey } = input;
  const transition = TRANSITIONS[action];
  const hash = await payloadHash({ action, orderId, actorUserId, body: null });
  const ledger = await checkCommandLedger<TransitionResult>(db, storeId, requestKey, hash);
  if (ledger) return ledger;

  const order = await db.prepare('SELECT status FROM orders WHERE store_id = ? AND id = ?').bind(storeId, orderId).first<{ status: string }>();
  if (!order) return { kind: 'not_found' };
  if (!transition.eligible(order.status)) return { kind: 'invalid_transition' };

  const result: TransitionResult = { orderId, status: transition.to };
  try {
    await db.batch([
      insertCommandStatement(db, { storeId, requestKey, payloadHash: hash, action, orderId }, result),
      db
        .prepare('UPDATE orders SET status = ?, updated_at = ? WHERE store_id = ? AND id = ? AND status = ?')
        .bind(transition.to, now.toISOString(), storeId, orderId, transition.from),
      assertPreviousWriteChangedOneRow(db, storeId, orderId),
    ]);
    return { kind: 'done', result };
  } catch (error) {
    const message = String(error);
    if (COMMAND_KEY_TAKEN.test(message)) return (await checkCommandLedger<TransitionResult>(db, storeId, requestKey, hash)) ?? { kind: 'idempotency_conflict' };
    if (COMMAND_ASSERTION_FAILED.test(message)) return { kind: 'invalid_transition' };
    throw error;
  }
}
