import { STORE_ID } from '@qr/identity/store';
import { settleCredit } from '@qr/orders/commands/payment-settlement';
import { recordUnverifiedEvent } from '@qr/orders/provider-events';
import { logEvent } from './log.ts';
import { verifyPayfsWebhook } from './payfs/verify-webhook.ts';

export const PAYFS_PROVIDER = 'payfs';

/**
 * POST /api/payfs/webhook. Unmatched outcomes answer 200 because PayFS retries non-2xx for ~2.8 hours and a retry
 * cannot make them match; only failures a retry can fix (settlement_retry) or sender errors get a non-2xx.
 */
export async function handlePayfsWebhook(request: Request, env: Env): Promise<Response | null> {
  if (new URL(request.url).pathname !== '/api/payfs/webhook') return null;
  if (request.method !== 'POST') return Response.json({ error: 'not_found' }, { status: 404 });

  const verification = await verifyPayfsWebhook(request, env);
  if (!verification.ok) {
    if (verification.unverifiedBody !== undefined) {
      await recordUnverifiedEvent(env.DB, { storeId: STORE_ID, provider: PAYFS_PROVIDER, source: 'webhook', rawPayload: verification.unverifiedBody });
    }
    logEvent({ event: 'payfs_webhook_rejected', status: verification.status, error: verification.error });
    return Response.json({ error: verification.error }, { status: verification.status });
  }

  const { transfer } = verification;
  const result = await settleCredit(env.DB, {
    storeId: STORE_ID,
    provider: PAYFS_PROVIDER,
    source: 'webhook',
    facts: { transaction_id: transfer.transactionId, amount: transfer.amountMinor, content: transfer.content, transfer_type: transfer.transferType },
    rawPayload: transfer.rawPayload,
  });
  logEvent({ event: 'payfs_webhook', transactionId: transfer.transactionId, result: result.kind, outcome: 'outcome' in result ? result.outcome : null });
  switch (result.kind) {
    case 'recorded':
      return Response.json({ outcome: result.outcome });
    case 'already_processed':
      return Response.json({ outcome: 'already_processed' });
    case 'facts_conflict':
      return Response.json({ error: 'provider_facts_conflict' }, { status: 400 });
    case 'retry':
      return Response.json({ error: 'settlement_retry' }, { status: 503 });
  }
}
