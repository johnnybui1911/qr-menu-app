import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../support/test-env.ts';
import { consoleRequest, createConsoleSession, type ConsoleSession } from '../support/console-session.ts';
import { creditPayload, signedWebhook } from '../support/payfs.ts';
import { insertOrder, insertTable } from '../support/seed.ts';

let owner: ConsoleSession;
let staff: ConsoleSession;

const post = (path: string, session: ConsoleSession, { key = `key-${crypto.randomUUID()}`, body }: { key?: string | null; body?: unknown } = {}) =>
  consoleRequest(path, {
    method: 'POST',
    cookie: session.cookie,
    headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const settle = async (response: Response) => ({ status: response.status, body: await response.json<Record<string, unknown>>() });
const status = (id = 'order-1') => env.DB.prepare('SELECT status FROM orders WHERE id = ?').bind(id).first<string>('status');

beforeEach(async () => {
  await resetDb();
  await insertTable('table-1', '5');
  await insertOrder('order-1', { status: 'paid', totalMinor: 45000, paymentReference: 'QM7K2P9X4B', orderCode: 'AAA001' });
  owner = await createConsoleSession({ role: 'owner' });
  staff = await createConsoleSession({ role: 'staff' });
});

afterEach(() => vi.restoreAllMocks());

describe('console order commands over HTTP', () => {
  it('lets staff prepare then fulfil a paid order', async () => {
    expect(await settle(await post('/api/console/orders/order-1/prepare', staff))).toEqual({ status: 200, body: { orderId: 'order-1', status: 'preparing' } });
    expect(await settle(await post('/api/console/orders/order-1/fulfill', staff))).toEqual({ status: 200, body: { orderId: 'order-1', status: 'fulfilled' } });
  });

  it('replays a repeated command with the same body', async () => {
    const first = await settle(await post('/api/console/orders/order-1/prepare', staff, { key: 'replay-key-0123456789' }));
    expect(await settle(await post('/api/console/orders/order-1/prepare', staff, { key: 'replay-key-0123456789' }))).toEqual(first);
  });

  it('maps conflicts and illegal transitions to 409 and unknown orders to 404', async () => {
    await insertOrder('order-2', { status: 'paid', paymentReference: 'QM00000002', orderCode: 'AAA002' });
    await post('/api/console/orders/order-1/prepare', staff, { key: 'shared-key-0123456789' });
    expect(await settle(await post('/api/console/orders/order-2/prepare', staff, { key: 'shared-key-0123456789' }))).toEqual({
      status: 409,
      body: { error: 'idempotency_conflict' },
    });
    expect(await settle(await post('/api/console/orders/order-2/fulfill', staff))).toEqual({ status: 409, body: { error: 'invalid_transition' } });
    expect((await post('/api/console/orders/ghost/prepare', staff)).status).toBe(404);
  });

  it('requires an Idempotency-Key and writes nothing without one', async () => {
    expect(await settle(await post('/api/console/orders/order-1/prepare', staff, { key: null }))).toEqual({
      status: 400,
      body: { error: 'idempotency_key_required' },
    });
    expect(await status()).toBe('paid');
  });

  it('refuses commands without a session', async () => {
    const anonymous = await consoleRequest('/api/console/orders/order-1/prepare', { method: 'POST', headers: { 'idempotency-key': 'anon-key-0123456789' } });
    expect(anonymous.status).toBe(401);
    expect(await status()).toBe('paid');
  });

  it('runs the whole lifecycle: storefront order, webhook paid, prepare, fulfil', async () => {
    await insertOrder('order-3', { totalMinor: 30000, paymentReference: 'QMLIFE0003', orderCode: 'AAA003' });
    await exports.default.fetch(await signedWebhook(creditPayload({ amount: 30000, content: 'CT QMLIFE0003' })));
    expect(await status('order-3')).toBe('paid');
    await post('/api/console/orders/order-3/prepare', staff);
    await post('/api/console/orders/order-3/fulfill', staff);
    expect(await status('order-3')).toBe('fulfilled');
    const trail = await env.DB.prepare(
      "SELECT (SELECT count(*) FROM provider_events WHERE order_id = 'order-3') AS events, (SELECT count(*) FROM order_commands WHERE order_id = 'order-3') AS commands",
    ).first();
    expect(trail).toEqual({ events: 1, commands: 2 });
  });
});

describe('GET /api/console/orders (kitchen polling)', () => {
  it('returns active tickets with needs_attention, then 304 until something changes', async () => {
    await env.DB.prepare("UPDATE orders SET needs_attention = 1 WHERE id = 'order-1'").run();
    const first = await consoleRequest('/api/console/orders', { cookie: staff.cookie });
    expect(first.status).toBe(200);
    const body = await first.json<{ orders: { id: string; needsAttention: boolean }[]; since: string }>();
    expect(body.orders).toMatchObject([{ id: 'order-1', needsAttention: true, tableNumber: '5' }]);
    const etag = first.headers.get('etag')!;

    const since = encodeURIComponent(body.since);
    const idle = await consoleRequest(`/api/console/orders?since=${since}`, { cookie: staff.cookie });
    const idleEtag = idle.headers.get('etag')!;
    expect(idle.status).toBe(200);
    const unchanged = await consoleRequest(`/api/console/orders?since=${since}`, { cookie: staff.cookie, headers: { 'if-none-match': idleEtag } });
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe('');
    expect(etag).not.toBe(idleEtag);

    await post('/api/console/orders/order-1/prepare', staff);
    const changed = await consoleRequest(`/api/console/orders?since=${since}`, { cookie: staff.cookie, headers: { 'if-none-match': idleEtag } });
    expect(changed.status).toBe(200);
    expect((await changed.json<{ orders: { status: string }[] }>()).orders).toMatchObject([{ status: 'preparing' }]);
  });

  it('rejects a malformed cursor', async () => {
    expect((await consoleRequest('/api/console/orders?since=garbage', { cookie: staff.cookie })).status).toBe(400);
  });
});

describe('refunds over HTTP (O4)', () => {
  const requestRefund = (session: ConsoleSession) => post('/api/console/orders/order-1/refund-requests', session, { body: { reason: 'Hết món' } });

  it('lets staff request, only the owner list and decide, with no money movement', async () => {
    const created = await settle(await requestRefund(staff));
    expect(created).toMatchObject({ status: 201, body: { orderId: 'order-1', status: 'pending' } });
    const refundRequestId = created.body.refundRequestId as string;

    expect((await consoleRequest('/api/console/refund-requests?status=pending', { cookie: staff.cookie })).status).toBe(403);
    const listed = await settle(await consoleRequest('/api/console/refund-requests?status=pending', { cookie: owner.cookie }));
    expect(listed.body.refundRequests).toMatchObject([{ id: refundRequestId, orderCode: 'AAA001', reason: 'Hết món', amountMinor: 45000, status: 'pending' }]);

    expect(await settle(await post(`/api/console/refund-requests/${refundRequestId}/decide`, staff, { body: { decision: 'approve' } }))).toEqual({
      status: 403,
      body: { error: 'forbidden' },
    });
    expect(await status()).toBe('paid');

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const decided = await settle(await post(`/api/console/refund-requests/${refundRequestId}/decide`, owner, { body: { decision: 'approve' } }));
    expect(decided).toEqual({ status: 200, body: { refundRequestId, orderId: 'order-1', status: 'approved', orderStatus: 'refunded' } });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await status()).toBe('refunded');
  });

  it('rejects an empty reason and a second request for the same order', async () => {
    expect((await post('/api/console/orders/order-1/refund-requests', staff, { body: { reason: '  ' } })).status).toBe(400);
    await requestRefund(staff);
    expect(await settle(await requestRefund(staff))).toEqual({ status: 409, body: { error: 'refund_already_requested' } });
  });

  it('accepts only approve or reject as a decision', async () => {
    const created = await settle(await requestRefund(staff));
    const response = await post(`/api/console/refund-requests/${created.body.refundRequestId}/decide`, owner, { body: { decision: 'maybe' } });
    expect(response.status).toBe(400);
  });
});

describe('owner-only reads', () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO provider_events (id, store_id, provider, provider_event_id, source, verified, facts_fingerprint, raw_payload, order_id, outcome) VALUES ('pe-1', 'store_default', 'payfs', 'tx-1', 'webhook', 1, ?, '{}', 'order-1', 'paid')",
      ).bind('a'.repeat(64)),
      env.DB.prepare(
        "INSERT INTO provider_events (id, store_id, provider, provider_event_id, source, verified, facts_fingerprint, raw_payload, order_id, outcome) VALUES ('pe-2', 'store_default', 'payfs', 'tx-2', 'webhook', 1, ?, '{\"content\":\"garbled\"}', NULL, 'unmatched')",
      ).bind('b'.repeat(64)),
    ]);
  });

  it('shows provider events per order and unmatched money to the owner only', async () => {
    expect((await consoleRequest('/api/console/provider-events?unmatched=1', { cookie: staff.cookie })).status).toBe(403);
    const byOrder = await settle(await consoleRequest('/api/console/provider-events?orderId=order-1', { cookie: owner.cookie }));
    expect((byOrder.body.events as { id: string }[]).map((e) => e.id)).toEqual(['pe-1']);
    const unmatched = await settle(await consoleRequest('/api/console/provider-events?unmatched=1', { cookie: owner.cookie }));
    expect(unmatched.body.events).toMatchObject([{ id: 'pe-2', outcome: 'unmatched', orderId: null, rawPayload: '{"content":"garbled"}' }]);
  });

  it('serves the daily revenue report to the owner only and validates the date', async () => {
    const today = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
    expect((await consoleRequest(`/api/console/revenue?date=${today}`, { cookie: staff.cookie })).status).toBe(403);
    expect(await settle(await consoleRequest(`/api/console/revenue?date=${today}`, { cookie: owner.cookie }))).toEqual({
      status: 200,
      body: { date: today, paidOrderCount: 1, revenueMinor: 45000, refundedOrderCount: 0, refundedMinor: 0 },
    });
    expect((await consoleRequest('/api/console/revenue?date=26-09-2026', { cookie: owner.cookie })).status).toBe(400);
  });
});
