// T10 (phase 10): "missing RESEND_FROM_ADDRESS or OWNER_REPORT_EMAIL → job neither sends nor retires, only logs
// `email_not_configured`" — two env vars, two failure modes. `tests/integration/email-outbox.test.ts` (phase 5)
// already has "keeps jobs untouched when email is not configured" for a missing RESEND_FROM_ADDRESS; this file
// adds only the delta that test does not cover: OWNER_REPORT_EMAIL missing on its own, and the `email_not_configured`
// log line itself (neither is asserted anywhere else — checked before writing this file, not duplicated).
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORE_ID } from '@qr/identity/store';
import { enqueueEmailJobStatement } from '@qr/orders/email-outbox';
import worker from '../../apps/worker/src/index.ts';
import { resetDb } from '../support/test-env.ts';

const FIVE = '*/5 * * * *';

async function runOutbox(at: Date, overrides: Partial<Env>) {
  vi.setSystemTime(at);
  const ctx = createExecutionContext();
  await worker.scheduled!({ cron: FIVE, scheduledTime: at.getTime(), type: 'scheduled', noRetry() {} } as ScheduledController, { ...env, ...overrides }, ctx);
  await waitOnExecutionContext(ctx);
}

const enqueue = (dedupeKey: string) =>
  enqueueEmailJobStatement(env.DB, { storeId: STORE_ID, kind: 'refund_confirmed', orderId: null, dedupeKey, payload: { orderCode: 'ABC123', amountMinor: 1000 } }).run();
const job = () => env.DB.prepare('SELECT * FROM order_email_jobs').first<Record<string, unknown>>();

beforeEach(async () => {
  await resetDb();
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('email delivery requires full config (T10, D23)', () => {
  it('missing OWNER_REPORT_EMAIL alone (RESEND_FROM_ADDRESS present) keeps the job pending and untouched', async () => {
    await enqueue('refund:order-owner-missing');
    await runOutbox(new Date(Date.now() + 1000), { OWNER_REPORT_EMAIL: '' });
    expect(await job()).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('logs exactly "email_not_configured" (not a stack trace, not silence) when config is incomplete', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await enqueue('refund:order-log-check');
    await runOutbox(new Date(Date.now() + 1000), { RESEND_FROM_ADDRESS: '' });
    const events = logSpy.mock.calls.map(([line]) => JSON.parse(String(line)) as { event?: string });
    expect(events).toContainEqual({ event: 'email_not_configured' });
  });
});
