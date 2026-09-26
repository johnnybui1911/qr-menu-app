import { sha256Hex } from '@qr/identity/token-digest';

// Owns all SQL for provider_events and provider_payments (C3). Provider-neutral: the worker passes the provider name.

export type ProviderEventSource = 'webhook' | 'reconciliation';
export type ProviderEventOutcome =
  | 'paid'
  | 'already_paid'
  | 'amount_mismatch'
  | 'order_not_found'
  | 'unmatched'
  | 'unmatched_ambiguous'
  | 'unmatched_payment'
  | 'ignored_debit'
  | 'signature_invalid';

/** The only fields that identify a bank transfer; webhook and reconciliation must fingerprint the same set. */
export const PROVIDER_FACT_FIELDS = ['transaction_id', 'amount', 'content', 'transfer_type'] as const;
export type ProviderFacts = { transaction_id: string; amount: number; content: string; transfer_type: string };

export function fingerprintFacts(facts: ProviderFacts): Promise<string> {
  const values = PROVIDER_FACT_FIELDS.map((field) => (field === 'content' ? facts.content.trim().normalize('NFKC') : facts[field]));
  return sha256Hex(JSON.stringify(values));
}

export type ProviderEventInput = {
  storeId: string;
  provider: string;
  providerEventId: string;
  source: ProviderEventSource;
  verified: boolean;
  factsFingerprint: string | null;
  rawPayload: string;
  orderId: string | null;
  outcome: ProviderEventOutcome;
};

export function insertProviderEventStatement(db: D1Database, event: ProviderEventInput): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO provider_events (id, store_id, provider, provider_event_id, source, verified, facts_fingerprint, raw_payload, order_id, outcome)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      event.storeId,
      event.provider,
      event.providerEventId,
      event.source,
      event.verified ? 1 : 0,
      event.factsFingerprint,
      event.rawPayload,
      event.orderId,
      event.outcome,
    );
}

export function insertProviderPaymentStatement(
  db: D1Database,
  payment: { storeId: string; orderId: string; providerEventId: string; amountMinor: number },
): D1PreparedStatement {
  return db
    .prepare('INSERT INTO provider_payments (id, store_id, order_id, provider_event_id, amount_minor) VALUES (?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), payment.storeId, payment.orderId, payment.providerEventId, payment.amountMinor);
}

export function readVerifiedEvent(
  db: D1Database,
  provider: string,
  providerEventId: string,
): Promise<{ facts_fingerprint: string; outcome: ProviderEventOutcome | null } | null> {
  return db
    .prepare('SELECT facts_fingerprint, outcome FROM provider_events WHERE provider = ? AND provider_event_id = ? AND verified = 1')
    .bind(provider, providerEventId)
    .first();
}

/**
 * Keeps the raw body of a delivery whose signature did not verify. Its id is derived from the body, never from the
 * unverified transaction id, so it cannot occupy the idempotency key of the genuine event.
 */
export async function recordUnverifiedEvent(
  db: D1Database,
  event: { storeId: string; provider: string; source: ProviderEventSource; rawPayload: string },
): Promise<void> {
  await insertProviderEventStatement(db, {
    ...event,
    providerEventId: `unverified:${await sha256Hex(event.rawPayload)}`,
    verified: false,
    factsFingerprint: null,
    orderId: null,
    outcome: 'signature_invalid',
  }).run();
}

export type ProviderEventView = {
  id: string;
  provider: string;
  providerEventId: string;
  source: ProviderEventSource;
  verified: boolean;
  orderId: string | null;
  outcome: ProviderEventOutcome | null;
  rawPayload: string;
  createdAt: string;
};

type ProviderEventRow = {
  id: string;
  provider: string;
  provider_event_id: string;
  source: ProviderEventSource;
  verified: number;
  order_id: string | null;
  outcome: ProviderEventOutcome | null;
  raw_payload: string;
  created_at: string;
};

const PROVIDER_EVENT_SELECT_SQL =
  'SELECT id, provider, provider_event_id, source, verified, order_id, outcome, raw_payload, created_at FROM provider_events';

/**
 * Owner view of recorded payments. `unmatched` lists verified money no order claims (order_id IS NULL) — the only place
 * a transfer with a garbled reference becomes visible before its order would be cancelled.
 */
export async function readProviderEvents(db: D1Database, storeId: string, filter: { orderId: string } | { unmatched: true }): Promise<ProviderEventView[]> {
  const statement =
    'orderId' in filter
      ? db.prepare(`${PROVIDER_EVENT_SELECT_SQL} WHERE store_id = ? AND order_id = ? ORDER BY created_at DESC, id LIMIT 200`).bind(storeId, filter.orderId)
      : db.prepare(`${PROVIDER_EVENT_SELECT_SQL} WHERE store_id = ? AND order_id IS NULL AND verified = 1 ORDER BY created_at DESC, id LIMIT 200`).bind(storeId);
  const { results } = await statement.all<ProviderEventRow>();
  return results.map((row) => ({
    id: row.id,
    provider: row.provider,
    providerEventId: row.provider_event_id,
    source: row.source,
    verified: row.verified === 1,
    orderId: row.order_id,
    outcome: row.outcome,
    rawPayload: row.raw_payload,
    createdAt: row.created_at,
  }));
}
