import { STORE_ID } from '@qr/identity/store';
import { settleCredit } from '@qr/orders/commands/payment-settlement';
import { cancelExpiredPendingOrders, flagStalePendingOrders, hasReconciliationCandidates } from '@qr/orders/commands/pending-order-expiry';
import { logEvent } from '../log.ts';
import { PAYFS_PROVIDER } from '../payfs-webhook-routes.ts';
import { queryPayfsTransactions } from './query-transactions.ts';

/**
 * The every-minute reconciliation cron (D6), strictly in this order within one run:
 * 1. settle every transaction the bank reports, through the webhook's own settleCredit (no second money path);
 * 2. flag unpaid orders older than 15 minutes;
 * 3. cancel unpaid orders older than 30 minutes — last, so money found in step 1 always wins over cancellation.
 */
export async function reconcilePendingOrders(env: Env, now: Date = new Date()): Promise<void> {
  if (await hasReconciliationCandidates(env.DB, STORE_ID, now)) {
    const transactions = (await queryPayfsTransactions(env)) ?? [];
    for (const facts of transactions) {
      const credit = { storeId: STORE_ID, provider: PAYFS_PROVIDER, source: 'reconciliation' as const, facts, rawPayload: JSON.stringify(facts) };
      let result = await settleCredit(env.DB, credit);
      // 'retry' means the order changed under us and nothing was committed. Unlike the webhook, nobody retries this
      // for us, so re-read once now: the order's final state yields a terminal outcome.
      if (result.kind === 'retry') result = await settleCredit(env.DB, credit);
      if (result.kind === 'retry' || result.kind === 'facts_conflict') {
        logEvent({ event: 'reconcile_settle_unresolved', transactionId: facts.transaction_id, result: result.kind });
      }
    }
  }
  const flagged = await flagStalePendingOrders(env.DB, STORE_ID, now);
  const cancelled = await cancelExpiredPendingOrders(env.DB, STORE_ID, now);
  if (flagged || cancelled) logEvent({ event: 'reconcile_expiry', flagged, cancelled });
}
