import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { STORE_ID } from '@qr/identity/store';
import { transitionOrder } from '@qr/orders/commands/order-commands';
import { decideRefund, requestRefund } from '@qr/orders/refunds';
import { resetDb } from '../support/test-env.ts';
import { insertOrder, insertTable } from '../support/seed.ts';

const snapshot = async () =>
  Object.fromEntries(
    await Promise.all(
      ['orders', 'order_commands', 'order_email_jobs', 'provider_events', 'refund_requests'].map(async (table) => [
        table,
        (await env.DB.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).results,
      ]),
    ),
  );
const status = (id = 'order-1') => env.DB.prepare('SELECT status FROM orders WHERE id = ?').bind(id).first<string>('status');
const key = () => `key-${crypto.randomUUID()}`;

beforeEach(async () => {
  await resetDb();
  await insertTable();
  await insertOrder('order-1', { status: 'paid', totalMinor: 45000, paymentReference: 'QM00000001', orderCode: 'AAA001' });
});

describe('transitionOrder (D9, D10 console tier)', () => {
  it('moves paid → preparing → fulfilled with one ledger row per command', async () => {
    const prepare = await transitionOrder(env.DB, { storeId: STORE_ID, orderId: 'order-1', action: 'order:prepare', actorUserId: 'staff-1', requestKey: key() });
    expect(prepare).toEqual({ kind: 'done', result: { orderId: 'order-1', status: 'preparing' } });
    const fulfill = await transitionOrder(env.DB, { storeId: STORE_ID, orderId: 'order-1', action: 'order:fulfill', actorUserId: 'staff-1', requestKey: key() });
    expect(fulfill).toEqual({ kind: 'done', result: { orderId: 'order-1', status: 'fulfilled' } });
    expect(await env.DB.prepare('SELECT count(*) AS n FROM order_commands').first('n')).toBe(2);
  });

  it('replays the stored result for the same key and payload without re-running the transition', async () => {
    const input = { storeId: STORE_ID, orderId: 'order-1', action: 'order:prepare' as const, actorUserId: 'staff-1', requestKey: key() };
    const first = await transitionOrder(env.DB, input);
    const touched = await env.DB.prepare("SELECT updated_at FROM orders WHERE id = 'order-1'").first('updated_at');
    expect(await transitionOrder(env.DB, input)).toEqual({ kind: 'replay', result: first.kind === 'done' ? first.result : null });
    expect(await env.DB.prepare("SELECT updated_at FROM orders WHERE id = 'order-1'").first('updated_at')).toBe(touched);
  });

  it('rejects a reused key with a different payload', async () => {
    await insertOrder('order-2', { status: 'paid', paymentReference: 'QM00000002', orderCode: 'AAA002' });
    const requestKey = key();
    await transitionOrder(env.DB, { storeId: STORE_ID, orderId: 'order-1', action: 'order:prepare', actorUserId: 'staff-1', requestKey });
    expect(await transitionOrder(env.DB, { storeId: STORE_ID, orderId: 'order-2', action: 'order:prepare', actorUserId: 'staff-1', requestKey })).toEqual({
      kind: 'idempotency_conflict',
    });
    expect(await status('order-2')).toBe('paid');
  });

  it('refuses an illegal transition with no side effect at all', async () => {
    await env.DB.prepare("UPDATE orders SET status = 'pending_payment' WHERE id = 'order-1'").run();
    const before = await snapshot();
    expect(await transitionOrder(env.DB, { storeId: STORE_ID, orderId: 'order-1', action: 'order:fulfill', actorUserId: 'staff-1', requestKey: key() })).toEqual({
      kind: 'invalid_transition',
    });
    expect(await snapshot()).toEqual(before);
  });

  it('lets only one of two racing commands perform the same transition', async () => {
    const [a, b] = await Promise.all([
      transitionOrder(env.DB, { storeId: STORE_ID, orderId: 'order-1', action: 'order:prepare', actorUserId: 'staff-1', requestKey: key() }),
      transitionOrder(env.DB, { storeId: STORE_ID, orderId: 'order-1', action: 'order:prepare', actorUserId: 'staff-2', requestKey: key() }),
    ]);
    expect([a.kind, b.kind].sort()).toEqual(['done', 'invalid_transition']);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM order_commands').first('n')).toBe(1);
  });

  it('answers not_found for an unknown order', async () => {
    expect(await transitionOrder(env.DB, { storeId: STORE_ID, orderId: 'ghost', action: 'order:prepare', actorUserId: 'staff-1', requestKey: key() })).toEqual({
      kind: 'not_found',
    });
  });
});

describe('refunds (O4: recorded, never money movement)', () => {
  const request = (orderId = 'order-1', requestKey = key()) =>
    requestRefund(env.DB, { storeId: STORE_ID, orderId, staffUserId: 'staff-1', reason: 'Hết món', requestKey });
  const decide = (refundRequestId: string, decision: 'approve' | 'reject', requestKey = key()) =>
    decideRefund(env.DB, { storeId: STORE_ID, refundRequestId, decision, ownerUserId: 'owner-1', requestKey });

  it('records a staff request as pending', async () => {
    const result = await request();
    expect(result).toMatchObject({ kind: 'done', result: { orderId: 'order-1', status: 'pending' } });
    expect(await env.DB.prepare('SELECT status, requested_by_staff_id, reason FROM refund_requests').first()).toEqual({
      status: 'pending',
      requested_by_staff_id: 'staff-1',
      reason: 'Hết món',
    });
  });

  it('allows one request per order', async () => {
    await request();
    expect(await request()).toEqual({ kind: 'refund_already_requested' });
    expect(await env.DB.prepare('SELECT count(*) AS n FROM refund_requests').first('n')).toBe(1);
  });

  it('refuses a refund for an order that was never paid', async () => {
    await env.DB.prepare("UPDATE orders SET status = 'pending_payment' WHERE id = 'order-1'").run();
    expect(await request()).toEqual({ kind: 'invalid_transition' });
    expect(await env.DB.prepare('SELECT count(*) AS n FROM refund_requests').first('n')).toBe(0);
  });

  it.each(['paid', 'preparing', 'fulfilled'])('approves from %s: order refunded and confirmation email queued in one batch', async (from) => {
    await env.DB.prepare('UPDATE orders SET status = ? WHERE id = ?').bind(from, 'order-1').run();
    const requested = await request();
    const refundRequestId = requested.kind === 'done' ? requested.result.refundRequestId : '';
    expect(await decide(refundRequestId, 'approve')).toMatchObject({ kind: 'done', result: { status: 'approved', orderStatus: 'refunded' } });
    expect(await status()).toBe('refunded');
    const jobs = await env.DB.prepare('SELECT kind, dedupe_key, order_id, payload_json FROM order_email_jobs').all();
    expect(jobs.results).toEqual([
      { kind: 'refund_confirmed', dedupe_key: 'refund:order-1', order_id: 'order-1', payload_json: JSON.stringify({ orderCode: 'AAA001', amountMinor: 45000 }) },
    ]);
  });

  it('rejects without touching the order or queueing email', async () => {
    const requested = await request();
    const refundRequestId = requested.kind === 'done' ? requested.result.refundRequestId : '';
    expect(await decide(refundRequestId, 'reject')).toMatchObject({ kind: 'done', result: { status: 'rejected', orderStatus: 'paid' } });
    expect(await status()).toBe('paid');
    expect(await env.DB.prepare('SELECT count(*) AS n FROM order_email_jobs').first('n')).toBe(0);
  });

  it('treats a decision as final', async () => {
    const requested = await request();
    const refundRequestId = requested.kind === 'done' ? requested.result.refundRequestId : '';
    await decide(refundRequestId, 'approve');
    const before = await snapshot();
    expect(await decide(refundRequestId, 'reject')).toEqual({ kind: 'invalid_transition' });
    expect(await snapshot()).toEqual(before);
  });

  it('aborts an approval whose order can no longer be refunded, leaving the request pending', async () => {
    const requested = await request();
    const refundRequestId = requested.kind === 'done' ? requested.result.refundRequestId : '';
    await env.DB.prepare("UPDATE orders SET status = 'refunded' WHERE id = 'order-1'").run();
    expect(await decide(refundRequestId, 'approve')).toEqual({ kind: 'invalid_transition' });
    expect(await env.DB.prepare('SELECT status FROM refund_requests').first('status')).toBe('pending');
    expect(await env.DB.prepare('SELECT count(*) AS n FROM order_email_jobs').first('n')).toBe(0);
  });
});
