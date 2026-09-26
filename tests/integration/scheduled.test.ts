import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORE_ID } from '@qr/identity/store';
import { enqueueEmailJobStatement } from '@qr/orders/email-outbox';
import worker from '../../apps/worker/src/index.ts';
import { resetDb } from '../support/test-env.ts';
import { insertOrder, insertTable } from '../support/seed.ts';

const run = async (cron: string) => {
  const ctx = createExecutionContext();
  await worker.scheduled!({ cron, scheduledTime: Date.now(), type: 'scheduled', noRetry() {} } as ScheduledController, env, ctx);
  await waitOnExecutionContext(ctx);
};

beforeEach(async () => {
  await resetDb();
  await insertTable();
  await insertOrder('stale', { createdAt: new Date(Date.now() - 31 * 60_000).toISOString() });
  await enqueueEmailJobStatement(env.DB, { storeId: STORE_ID, kind: 'refund_confirmed', orderId: null, dedupeKey: 'refund:x', payload: { orderCode: 'ABC123', amountMinor: 1 } }).run();
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ data: [] }));
});

afterEach(() => vi.restoreAllMocks());

describe('scheduled dispatch', () => {
  it('runs only reconciliation on */1', async () => {
    await run('*/1 * * * *');
    expect(await env.DB.prepare("SELECT status FROM orders WHERE id = 'stale'").first('status')).toBe('cancelled');
    expect(await env.DB.prepare('SELECT attempts FROM order_email_jobs').first('attempts')).toBe(0);
  });

  it('runs only the email outbox on */5', async () => {
    await run('*/5 * * * *');
    expect(await env.DB.prepare("SELECT status FROM orders WHERE id = 'stale'").first('status')).toBe('pending_payment');
    expect(await env.DB.prepare('SELECT attempts FROM order_email_jobs').first('attempts')).toBe(1);
  });
});
