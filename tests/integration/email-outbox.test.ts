import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORE_ID } from '@qr/identity/store';
import { claimDueJobs, enqueueEmailJobStatement } from '@qr/orders/email-outbox';
import worker from '../../apps/worker/src/index.ts';
import { resetDb } from '../support/test-env.ts';

const FIVE = '*/5 * * * *';
type Sent = { url: string; headers: Headers; body: Record<string, unknown> };

let sent: Sent[];
let resendStatus: number;

async function runOutbox(at: Date, overrides: Partial<Env> = {}) {
  vi.setSystemTime(at);
  const ctx = createExecutionContext();
  await worker.scheduled!({ cron: FIVE, scheduledTime: at.getTime(), type: 'scheduled', noRetry() {} } as ScheduledController, { ...env, ...overrides }, ctx);
  await waitOnExecutionContext(ctx);
}

const enqueue = (kind: 'daily_revenue_report' | 'refund_confirmed' | 'invitation', dedupeKey: string, payload: unknown) =>
  enqueueEmailJobStatement(env.DB, { storeId: STORE_ID, kind, orderId: null, dedupeKey, payload }).run();
const job = () => env.DB.prepare('SELECT * FROM order_email_jobs').first<Record<string, unknown>>();

beforeEach(async () => {
  await resetDb();
  sent = [];
  resendStatus = 200;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    sent.push({ url: request.url, headers: request.headers, body: await request.json() });
    return Response.json({ id: 'email-1' }, { status: resendStatus });
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('email outbox (D12, D23)', () => {
  it('lets exactly one claimer take a due job', async () => {
    await enqueue('refund_confirmed', 'refund:order-1', { orderCode: 'ABC123', amountMinor: 45000 });
    const now = new Date(Date.now() + 1000);
    expect(await claimDueJobs(env.DB, now, 10)).toHaveLength(1);
    expect(await claimDueJobs(env.DB, now, 10)).toHaveLength(0);
  });

  it('sends an order-less job through Resend with the job id as idempotency key and clears its payload', async () => {
    await enqueue('invitation', 'invite:inv-1', { targetEmail: 'staff@example.com', role: 'staff', token: 'raw-invite-token' });
    await runOutbox(new Date(Date.now() + 1000));
    expect(sent).toHaveLength(1);
    const row = await job();
    expect(sent[0].url).toBe(`${env.RESEND_API_BASE}/emails`);
    expect(sent[0].headers.get('idempotency-key')).toBe(row!.id);
    expect(sent[0].headers.get('authorization')).toBe(`Bearer ${env.RESEND_API_KEY}`);
    expect(sent[0].body).toMatchObject({ from: env.RESEND_FROM_ADDRESS, to: ['staff@example.com'] });
    expect(String(sent[0].body.text)).toContain(`${env.CONSOLE_ORIGIN}/console/invite#invite=raw-invite-token`);
    expect(row).toMatchObject({ status: 'sent', attempts: 1, payload_json: null, delivered_at: expect.any(String), order_id: null });
  });

  it('backs off after a failed send and does not reclaim before the delay', async () => {
    resendStatus = 500;
    await enqueue('refund_confirmed', 'refund:order-1', { orderCode: 'ABC123', amountMinor: 45000 });
    const first = new Date(Date.now() + 1000);
    await runOutbox(first);
    const afterFailure = await job();
    expect(afterFailure).toMatchObject({ status: 'pending', attempts: 1, last_error: expect.stringContaining('500') });
    expect(Date.parse(String(afterFailure!.available_at)) - first.getTime()).toBeGreaterThanOrEqual(5 * 60_000);

    await runOutbox(new Date(first.getTime() + 60_000));
    expect(sent).toHaveLength(1);

    resendStatus = 200;
    await runOutbox(new Date(first.getTime() + 6 * 60_000));
    expect(sent).toHaveLength(2);
    expect(sent[1].headers.get('idempotency-key')).toBe(sent[0].headers.get('idempotency-key'));
    expect((await job())!.status).toBe('sent');
  });

  it('retires a job after its eighth attempt and never sends it again', async () => {
    resendStatus = 500;
    await enqueue('refund_confirmed', 'refund:order-1', { orderCode: 'ABC123', amountMinor: 45000 });
    await env.DB.prepare("UPDATE order_email_jobs SET attempts = 7, payload_json = '{\"orderCode\":\"ABC123\",\"amountMinor\":1}'").run();
    await runOutbox(new Date(Date.now() + 1000));
    expect(await job()).toMatchObject({ status: 'retired', attempts: 8, payload_json: null });
    await runOutbox(new Date(Date.now() + 2 * 3_600_000));
    expect(sent).toHaveLength(1);
  });

  it('enqueues the daily revenue report once per ICT day at the closing hour', async () => {
    const closingHour = new Date('2026-09-26T16:00:00.000Z'); // 23:00 ICT
    for (const offset of [0, 5, 10]) await runOutbox(new Date(closingHour.getTime() + offset * 60_000));
    const reports = await env.DB.prepare("SELECT dedupe_key, status FROM order_email_jobs WHERE kind = 'daily_revenue_report'").all();
    expect(reports.results).toEqual([{ dedupe_key: 'daily:2026-09-26', status: 'sent' }]);
    expect(sent[0].body).toMatchObject({ to: [env.OWNER_REPORT_EMAIL] });

    await runOutbox(new Date('2026-09-27T16:05:00.000Z'));
    expect((await env.DB.prepare("SELECT count(*) AS n FROM order_email_jobs WHERE kind = 'daily_revenue_report'").first('n'))).toBe(2);
  });

  it('keeps jobs untouched when email is not configured', async () => {
    await enqueue('refund_confirmed', 'refund:order-1', { orderCode: 'ABC123', amountMinor: 45000 });
    await runOutbox(new Date(Date.now() + 1000), { RESEND_FROM_ADDRESS: '' });
    expect(sent).toHaveLength(0);
    expect(await job()).toMatchObject({ status: 'pending', attempts: 0 });
  });
});
