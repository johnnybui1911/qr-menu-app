import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../apps/worker/src/index.ts';
import { resetDb } from '../support/test-env.ts';
import { creditPayload, signedWebhook } from '../support/payfs.ts';
import { insertOrder, insertTable } from '../support/seed.ts';

const REFERENCE = 'QM7K2P9X4B';
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const credit = (overrides: Record<string, unknown> = {}) => ({
  transaction_id: 'tx-late-1',
  amount: 45000,
  content: `NGUYEN VAN A chuyen tien ${REFERENCE} Trace773231`,
  transfer_type: 'credit',
  ...overrides,
});

let apiCalls: Request[];
let apiBody: unknown;

async function reconcile(overrides: Partial<Env> = {}) {
  const ctx = createExecutionContext();
  const controller = { cron: '*/1 * * * *', scheduledTime: Date.now(), type: 'scheduled', noRetry() {} } as ScheduledController;
  await worker.scheduled!(controller, { ...env, ...overrides }, ctx);
  await waitOnExecutionContext(ctx);
}

const order = (id = 'order-1') =>
  env.DB.prepare('SELECT status, needs_attention FROM orders WHERE id = ?').bind(id).first<{ status: string; needs_attention: number }>();
const count = (sql: string) => env.DB.prepare(`SELECT count(*) AS n FROM ${sql}`).first<number>('n');

beforeEach(async () => {
  await resetDb();
  await insertTable();
  apiCalls = [];
  apiBody = { data: [] };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    apiCalls.push(new Request(input, init));
    return Response.json(apiBody);
  });
});

afterEach(() => vi.restoreAllMocks());

describe('*/1 reconciliation (D6)', () => {
  it('rescues a 3-minute-old order through the webhook settlement path', async () => {
    await insertOrder('order-1', { totalMinor: 45000, paymentReference: REFERENCE, createdAt: minutesAgo(3) });
    apiBody = { data: [credit()] };
    await reconcile();
    expect(apiCalls).toHaveLength(1);
    expect(apiCalls[0].url).toBe(`${env.PAYFS_API_BASE}/v1.1/transactions`);
    expect(apiCalls[0].headers.get('authorization')).toBe(`Bearer ${env.PAYFS_API_TOKEN}`);
    expect(await order()).toEqual({ status: 'paid', needs_attention: 0 });
    expect(await count("provider_events WHERE outcome = 'paid' AND source = 'reconciliation'")).toBe(1);
    expect(await count('provider_payments')).toBe(1);
    expect(await count('order_email_jobs')).toBe(0);
  });

  it('shares the idempotency ledger with the webhook', async () => {
    await insertOrder('order-1', { totalMinor: 45000, paymentReference: REFERENCE, createdAt: minutesAgo(3) });
    apiBody = { data: [credit()] };
    await reconcile();
    vi.restoreAllMocks();
    const late = await exports.default.fetch(await signedWebhook(creditPayload(credit())));
    expect(await late.json()).toEqual({ outcome: 'already_processed' });
    expect(await count('provider_payments')).toBe(1);
  });

  it('does not call the API for orders younger than two minutes', async () => {
    await insertOrder('order-1', { totalMinor: 45000, paymentReference: REFERENCE, createdAt: minutesAgo(1) });
    await reconcile();
    expect(apiCalls).toHaveLength(0);
    expect((await order())!.status).toBe('pending_payment');
  });

  it('flags an unpaid order after 15 minutes and keeps it alive', async () => {
    await insertOrder('order-1', { totalMinor: 45000, paymentReference: REFERENCE, createdAt: minutesAgo(16) });
    await reconcile();
    expect(await order()).toEqual({ status: 'pending_payment', needs_attention: 1 });
  });

  it('cancels an unpaid order after 30 minutes, idempotently', async () => {
    await insertOrder('order-1', { totalMinor: 45000, paymentReference: REFERENCE, createdAt: minutesAgo(31) });
    await reconcile();
    expect((await order())!.status).toBe('cancelled');
    const snapshot = await env.DB.prepare('SELECT * FROM orders').all();
    await reconcile();
    expect((await env.DB.prepare('SELECT * FROM orders').all()).results).toEqual(snapshot.results);
  });

  it('settles money found in the same run before cancelling', async () => {
    await insertOrder('order-1', { totalMinor: 45000, paymentReference: REFERENCE, createdAt: minutesAgo(31) });
    apiBody = { data: [credit()] };
    await reconcile();
    expect((await order())!.status).toBe('paid');
  });

  it('records money for a recently cancelled order without reviving it', async () => {
    await insertOrder('order-1', { status: 'cancelled', totalMinor: 45000, paymentReference: REFERENCE, createdAt: minutesAgo(40) });
    apiBody = { data: [credit()] };
    await reconcile();
    expect(await order()).toEqual({ status: 'cancelled', needs_attention: 1 });
    expect(await count("provider_events WHERE outcome = 'unmatched_payment' AND order_id = 'order-1'")).toBe(1);
    expect(await count('provider_payments')).toBe(0);
  });

  it('does not rescue an underpaid order', async () => {
    await insertOrder('order-1', { totalMinor: 45000, paymentReference: REFERENCE, createdAt: minutesAgo(3) });
    apiBody = { data: [credit({ amount: 44000 })] };
    await reconcile();
    expect(await order()).toEqual({ status: 'pending_payment', needs_attention: 1 });
    expect(await count("provider_events WHERE outcome = 'amount_mismatch'")).toBe(1);
  });

  it('skips the API without a token but still flags and cancels', async () => {
    await insertOrder('order-1', { totalMinor: 45000, paymentReference: 'QM0000000A', createdAt: minutesAgo(16) });
    await insertOrder('order-2', { totalMinor: 45000, paymentReference: 'QM0000000B', orderCode: 'CODE02', createdAt: minutesAgo(31) });
    await reconcile({ PAYFS_API_TOKEN: '' });
    expect(apiCalls).toHaveLength(0);
    expect(await order('order-1')).toEqual({ status: 'pending_payment', needs_attention: 1 });
    expect((await order('order-2'))!.status).toBe('cancelled');
  });

  it('leaves orders outside pending_payment untouched', async () => {
    for (const [i, status] of ['paid', 'preparing', 'fulfilled', 'refunded'].entries()) {
      await insertOrder(`order-${i}`, { status, paymentReference: `QM000000${i}Z`, orderCode: `CODE0${i}`, createdAt: minutesAgo(45) });
    }
    const before = await env.DB.prepare('SELECT * FROM orders ORDER BY id').all();
    await reconcile();
    expect((await env.DB.prepare('SELECT * FROM orders ORDER BY id').all()).results).toEqual(before.results);
  });

  it('handles 200 pending orders with a single API call', async () => {
    const statements = Array.from({ length: 200 }, (_, i) =>
      env.DB.prepare(
        "INSERT INTO orders (id, store_id, order_code, table_id, currency, total_amount_minor, payment_method, payment_reference, created_at) VALUES (?, 'store_default', ?, 'table-1', 'VND', 1000, 'vietqr', ?, ?)",
      ).bind(`bulk-${i}`, `B${String(i).padStart(5, '0')}`, `QMB${String(i).padStart(7, '0')}`, minutesAgo(5)),
    );
    await env.DB.batch(statements);
    apiBody = { data: [credit({ transaction_id: 'bulk-tx', amount: 1000, content: 'CT QMB0000042' })] };
    const started = Date.now();
    await reconcile();
    expect(apiCalls).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect((await order('bulk-42'))!.status).toBe('paid');
  });
});
