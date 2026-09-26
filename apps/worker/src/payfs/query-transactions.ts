import type { ProviderFacts } from '@qr/orders/provider-events';
import { logEvent } from '../log.ts';

const REQUEST_TIMEOUT_MS = 10_000;
const LIST_KEYS = ['data', 'transactions', 'items'] as const;

/**
 * Defensive parser for GET /v1.1/transactions. The response shape is unconfirmed until a PayFS account exists (O7);
 * when it is known, only this function changes. Keeps exactly the fact fields settlement needs and skips anything else.
 */
export function parseTransactions(body: unknown): ProviderFacts[] {
  let list: unknown = body;
  if (!Array.isArray(list) && typeof list === 'object' && list !== null) {
    const container = list as Record<string, unknown>;
    list = LIST_KEYS.map((key) => container[key]).find(Array.isArray);
  }
  if (!Array.isArray(list)) return [];
  const facts: ProviderFacts[] = [];
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { transaction_id, amount, content, transfer_type } = entry as Record<string, unknown>;
    const transactionId = typeof transaction_id === 'number' && Number.isSafeInteger(transaction_id) ? String(transaction_id) : transaction_id;
    if (typeof transactionId !== 'string' || transactionId.length === 0) continue;
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) continue;
    if (typeof content !== 'string' || typeof transfer_type !== 'string') continue;
    facts.push({ transaction_id: transactionId, amount, content, transfer_type });
  }
  return facts;
}

/** Recent account transactions, or null when the token is missing or the call fails (the cron's other steps still run). */
export async function queryPayfsTransactions(env: Env): Promise<ProviderFacts[] | null> {
  if (!env.PAYFS_API_TOKEN) {
    logEvent({ event: 'reconcile_skipped_no_token' });
    return null;
  }
  try {
    const response = await fetch(`${env.PAYFS_API_BASE}/v1.1/transactions`, {
      headers: { authorization: `Bearer ${env.PAYFS_API_TOKEN}`, accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      logEvent({ event: 'reconcile_api_failed', status: response.status });
      return null;
    }
    return parseTransactions(await response.json());
  } catch (error) {
    logEvent({ event: 'reconcile_api_failed', error: String(error) });
    return null;
  }
}
