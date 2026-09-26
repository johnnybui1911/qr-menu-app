import { PAYMENT_REFERENCE_PATTERN } from '../codes.ts';
import {
  fingerprintFacts,
  insertProviderEventStatement,
  insertProviderPaymentStatement,
  readVerifiedEvent,
  type ProviderEventOutcome,
  type ProviderEventSource,
  type ProviderFacts,
} from '../provider-events.ts';
import { markPaidEligible } from '../transitions/order-transitions.ts';

export type ReferenceMatch = { reference: string } | { reference: null; reason: 'none' | 'ambiguous' };

/** Finds the single payment reference in bank transfer content (D18). Two different references never guess. */
export function matchPaymentReference(content: string): ReferenceMatch {
  const found = new Set(content.toUpperCase().match(new RegExp(PAYMENT_REFERENCE_PATTERN.source, 'g')) ?? []);
  if (found.size === 1) return { reference: [...found][0] };
  return { reference: null, reason: found.size === 0 ? 'none' : 'ambiguous' };
}

export type CreditInput = {
  storeId: string;
  provider: string;
  source: ProviderEventSource;
  facts: ProviderFacts;
  rawPayload: string;
};

export type SettlementResult =
  | { kind: 'recorded'; outcome: ProviderEventOutcome }
  | { kind: 'already_processed' }
  | { kind: 'facts_conflict' }
  /** Nothing was committed and a retry can succeed; the caller must answer non-2xx. */
  | { kind: 'retry' };

const PAYMENT_TAKEN = /UNIQUE constraint failed: provider_payments\.store_id, provider_payments\.order_id/;
const EVENT_TAKEN = /UNIQUE constraint failed: provider_events\.provider, provider_events\.provider_event_id/;
const SETTLE_ASSERTION_FAILED = /NOT NULL constraint failed: orders\.order_code/;

type SettlementOrderRow = { id: string; status: string; total_amount_minor: number };

/**
 * The single money-recording path for webhooks and reconciliation (D10). Every verified transfer ends as exactly one
 * provider_events row with a final outcome, written in the same batch as any order change it causes.
 */
export async function settleCredit(db: D1Database, input: CreditInput, now: string = new Date().toISOString()): Promise<SettlementResult> {
  const { storeId, provider, source, facts, rawPayload } = input;
  const providerEventId = facts.transaction_id;
  const fingerprint = await fingerprintFacts(facts);

  const againstLedger = async (): Promise<SettlementResult | null> => {
    const existing = await readVerifiedEvent(db, provider, providerEventId);
    if (!existing) return null;
    if (existing.facts_fingerprint !== fingerprint) return { kind: 'facts_conflict' };
    // Every insert below carries a final outcome, so a NULL one is foreign data: surface it instead of acknowledging.
    return existing.outcome === null ? { kind: 'retry' } : { kind: 'already_processed' };
  };
  const event = (outcome: ProviderEventOutcome, orderId: string | null) =>
    insertProviderEventStatement(db, { storeId, provider, providerEventId, source, verified: true, factsFingerprint: fingerprint, rawPayload, orderId, outcome });
  const flag = (orderId: string) =>
    db.prepare('UPDATE orders SET needs_attention = 1, updated_at = ? WHERE store_id = ? AND id = ?').bind(now, storeId, orderId);
  const record = async (outcome: ProviderEventOutcome, orderId: string | null): Promise<SettlementResult> => {
    try {
      await db.batch(orderId ? [event(outcome, orderId), flag(orderId)] : [event(outcome, null)]);
      return { kind: 'recorded', outcome };
    } catch (error) {
      if (EVENT_TAKEN.test(String(error))) return (await againstLedger()) ?? { kind: 'retry' };
      throw error;
    }
  };

  const duplicate = await againstLedger();
  if (duplicate) return duplicate;
  if (facts.transfer_type !== 'credit') return record('ignored_debit', null);

  const match = matchPaymentReference(facts.content);
  if (match.reference === null) return record(match.reason === 'ambiguous' ? 'unmatched_ambiguous' : 'unmatched', null);

  const order = await db
    .prepare('SELECT id, status, total_amount_minor FROM orders WHERE store_id = ? AND payment_reference = ?')
    .bind(storeId, match.reference)
    .first<SettlementOrderRow>();
  if (!order) return record('order_not_found', null);
  if (order.status === 'cancelled') return record('unmatched_payment', order.id);
  if (!markPaidEligible(order.status)) return record('already_paid', order.id);
  if (order.total_amount_minor !== facts.amount) return record('amount_mismatch', order.id);

  try {
    await db.batch([
      event('paid', order.id),
      db
        .prepare("UPDATE orders SET status = 'paid', updated_at = ? WHERE store_id = ? AND id = ? AND status = 'pending_payment'")
        .bind(now, storeId, order.id),
      insertProviderPaymentStatement(db, { storeId, orderId: order.id, providerEventId, amountMinor: facts.amount }),
      // Commit assertion: aborts the batch unless the order is paid with this payment and this event recorded.
      db
        .prepare(
          `UPDATE orders SET order_code = CASE
             WHEN status = 'paid'
              AND EXISTS (SELECT 1 FROM provider_payments WHERE store_id = ? AND order_id = ? AND provider_event_id = ?)
              AND EXISTS (SELECT 1 FROM provider_events WHERE provider = ? AND provider_event_id = ? AND verified = 1 AND outcome = 'paid')
             THEN order_code ELSE NULL END
           WHERE store_id = ? AND id = ?`,
        )
        .bind(storeId, order.id, providerEventId, provider, providerEventId, storeId, order.id),
    ]);
    return { kind: 'recorded', outcome: 'paid' };
  } catch (error) {
    const message = String(error);
    if (PAYMENT_TAKEN.test(message)) return record('already_paid', order.id);
    if (EVENT_TAKEN.test(message)) return (await againstLedger()) ?? { kind: 'retry' };
    // The order left pending_payment between the read and the batch (a competing payment fails earlier on
    // PAYMENT_TAKEN or EVENT_TAKEN). Nothing was committed; the retry re-reads the order and records the right outcome.
    if (SETTLE_ASSERTION_FAILED.test(message)) return { kind: 'retry' };
    throw error;
  }
}
