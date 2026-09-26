import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { generateOpaqueToken } from '@qr/identity/token-digest';
import { STORE_ID } from '@qr/identity/store';
import { createOrder, createOrderStatements } from '@qr/orders/commands/order-write';
import { resetDb } from '../support/test-env.ts';
import worker from '../../apps/worker/src/index.ts';
import { insertCategory, insertOrder, insertProduct, insertTable, insertTableSecret } from '../support/seed.ts';

const TABLE_TOKEN = generateOpaqueToken();
const NOT_FOUND = { status: 404, body: { error: 'not_found' } };

type OrderHeaders = { tableToken?: string; idempotencyKey?: string; orderToken?: string };

function postOrder(body: unknown, headers: OrderHeaders = {}) {
  const { tableToken = TABLE_TOKEN, idempotencyKey = crypto.randomUUID(), orderToken = generateOpaqueToken() } = headers;
  return exports.default.fetch('http://api.test/api/storefront/orders', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: env.STOREFRONT_ORIGIN,
      'x-table-token': tableToken,
      'idempotency-key': idempotencyKey,
      'x-order-token': orderToken,
    },
    body: JSON.stringify(body),
  });
}

const getCurrent = (orderToken: string) =>
  exports.default.fetch('http://api.test/api/storefront/orders/current', { headers: { origin: env.STOREFRONT_ORIGIN, 'x-order-token': orderToken } });

const settle = async (response: Response) => ({ status: response.status, body: await response.json() });
const count = (table: string) => env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<number>('n');

beforeEach(async () => {
  await resetDb();
  await insertCategory();
  await insertProduct('coffee', { priceMinor: 20000 });
  await insertProduct('tea', { priceMinor: 15000 });
  await insertTable('table-1', '5');
  await insertTableSecret('table-1', TABLE_TOKEN);
});

describe('POST /api/storefront/orders', () => {
  it('totals on the server from D1 prices and snapshots them per line', async () => {
    const response = await postOrder({ items: [{ productId: 'coffee', quantity: 2 }, { productId: 'tea', quantity: 1, notes: 'ít đá' }] });
    expect(response.status).toBe(201);
    const body = await response.json<Record<string, unknown>>();
    expect(body).toMatchObject({ status: 'pending_payment', totalAmountMinor: 55000, currency: 'VND' });
    expect(body.paymentReference).toMatch(/^QM[0-9A-Z]{8}$/);
    expect(body.orderCode).toMatch(/^[0-9A-Z]{6}$/);
    expect(body.vietqrPayload).toContain(`0810${body.paymentReference}`);
    const lines = await env.DB.prepare('SELECT product_id, quantity, unit_price_snapshot_minor, line_total_minor, notes FROM order_items ORDER BY position').all();
    expect(lines.results).toEqual([
      { product_id: 'coffee', quantity: 2, unit_price_snapshot_minor: 20000, line_total_minor: 40000, notes: '' },
      { product_id: 'tea', quantity: 1, unit_price_snapshot_minor: 15000, line_total_minor: 15000, notes: 'ít đá' },
    ]);
  });

  it('keeps the price snapshot when the menu price changes later', async () => {
    const orderToken = generateOpaqueToken();
    await postOrder({ items: [{ productId: 'coffee', quantity: 1 }] }, { orderToken });
    await env.DB.prepare("UPDATE products SET price_minor = 99000 WHERE id = 'coffee'").run();
    const current = await (await getCurrent(orderToken)).json<Record<string, unknown>>();
    expect(current).toMatchObject({ totalAmountMinor: 20000, items: [{ productName: 'Product coffee', unitPriceMinor: 20000, lineTotalMinor: 20000 }] });
  });

  it('replays a retry with the same key and capability without creating a second order', async () => {
    const headers = { idempotencyKey: 'retry-key-0123456789', orderToken: generateOpaqueToken() };
    const bodies = [];
    for (let i = 0; i < 5; i++) bodies.push(await settle(await postOrder({ items: [{ productId: 'coffee', quantity: 1 }] }, headers)));
    for (const replay of bodies) expect(replay).toEqual(bodies[0]);
    expect(bodies[0].status).toBe(201);
    expect(await count('orders')).toBe(1);
  });

  it('refuses to rebind a key to another capability', async () => {
    const idempotencyKey = 'conflict-key-0123456789';
    await postOrder({ items: [{ productId: 'coffee', quantity: 1 }] }, { idempotencyKey });
    const second = await settle(await postOrder({ items: [{ productId: 'coffee', quantity: 1 }] }, { idempotencyKey }));
    expect(second).toEqual({ status: 409, body: { error: 'idempotency_conflict' } });
    expect(await count('orders')).toBe(1);
  });

  it('rejects the whole order when an item is unavailable and names it', async () => {
    await env.DB.prepare("UPDATE products SET is_available = 0 WHERE id = 'tea'").run();
    const response = await settle(await postOrder({ items: [{ productId: 'coffee', quantity: 1 }, { productId: 'tea', quantity: 1 }] }));
    expect(response).toEqual({ status: 409, body: { error: 'items_unavailable', items: [{ productId: 'tea', code: 'product_unavailable' }] } });
    expect(await count('orders')).toBe(0);
  });

  it('answers every table-token failure with the same 404', async () => {
    await insertTableSecret('table-1', 'expired-token-0123456789012345678901234567', '2000-01-01T00:00:00.000Z');
    const items = { items: [{ productId: 'coffee', quantity: 1 }] };
    const responses = [
      await settle(await postOrder(items, { tableToken: generateOpaqueToken() })),
      await settle(await postOrder(items, { tableToken: 'not a token' })),
      await settle(await postOrder(items, { tableToken: 'expired-token-0123456789012345678901234567' })),
    ];
    for (const response of responses) expect(response).toEqual(NOT_FOUND);
  });

  it('honours a rotated table token until its grace window ends', async () => {
    const rotated = generateOpaqueToken();
    await insertTableSecret('table-1', rotated, new Date(Date.now() + 15 * 60_000).toISOString());
    expect((await postOrder({ items: [{ productId: 'coffee', quantity: 1 }] }, { tableToken: rotated })).status).toBe(201);
    await env.DB.prepare('UPDATE table_secrets SET revoked_at = ? WHERE revoked_at IS NOT NULL').bind(new Date(Date.now() - 1000).toISOString()).run();
    expect(await settle(await postOrder({ items: [{ productId: 'coffee', quantity: 1 }] }, { tableToken: rotated }))).toEqual(NOT_FOUND);
  });

  it('rejects client-supplied prices before touching the database', async () => {
    expect(await settle(await postOrder({ items: [{ productId: 'coffee', quantity: 1, price: 1 }] }))).toEqual({
      status: 400,
      body: { error: 'unknown_field', field: 'items[0].price' },
    });
  });

  it.each([
    ['idempotency-key', 'short', 'idempotency_key_invalid'],
    ['x-order-token', 'too-short', 'order_token_invalid'],
  ])('requires a well-formed %s', async (header, value, error) => {
    const headers = header === 'idempotency-key' ? { idempotencyKey: value } : { orderToken: value };
    expect(await settle(await postOrder({ items: [{ productId: 'coffee', quantity: 1 }] }, headers))).toEqual({ status: 400, body: { error } });
  });

  it('never stores or echoes the raw tokens', async () => {
    const orderToken = generateOpaqueToken();
    const response = await postOrder({ items: [{ productId: 'coffee', quantity: 1 }] }, { orderToken });
    expect(await response.text()).not.toContain(orderToken);
    for (const table of ['orders', 'order_access', 'order_idempotency', 'order_items', 'table_secrets']) {
      const dump = JSON.stringify((await env.DB.prepare(`SELECT * FROM ${table}`).all()).results);
      expect(dump).not.toContain(orderToken);
      expect(dump).not.toContain(TABLE_TOKEN);
    }
  });

  it('regenerates the payment reference when it collides', async () => {
    await insertOrder('existing', { paymentReference: 'QMTAKEN000', orderCode: 'OLD001' });
    const references = ['QMTAKEN000', 'QMFRESH000'];
    const result = await createOrder(env.DB, {
      storeId: STORE_ID,
      tableId: 'table-1',
      idempotencyKey: 'collision-key-0123456789',
      orderToken: generateOpaqueToken(),
      items: [{ productId: 'coffee', quantity: 1, notes: '' }],
      generatePaymentReference: () => references.shift()!,
    });
    expect(result).toMatchObject({ ok: true, order: { paymentReference: 'QMFRESH000' } });
  });

  it('answers 503 and creates nothing when the receiving account is not configured', async () => {
    const request = new Request('http://api.test/api/storefront/orders', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-table-token': TABLE_TOKEN,
        'idempotency-key': crypto.randomUUID(),
        'x-order-token': generateOpaqueToken(),
      },
      body: JSON.stringify({ items: [{ productId: 'coffee', quantity: 1 }] }),
    });
    const ctx = createExecutionContext();
    const incoming = request as Request<unknown, IncomingRequestCfProperties>;
    const response = await worker.fetch!(incoming, { ...env, PAYFS_MERCHANT_ACCOUNT: '' }, ctx);
    await waitOnExecutionContext(ctx);
    expect(await settle(response)).toEqual({ status: 503, body: { error: 'payment_unavailable' } });
    expect(await count('orders')).toBe(0);
  });
});

describe('order batch total assertion (D11.4)', () => {
  it('rolls back the whole batch when the stored total disagrees with its lines', async () => {
    const statements = await createOrderStatements(env.DB, {
      orderId: 'order-bad',
      storeId: STORE_ID,
      tableId: 'table-1',
      orderCode: 'BAD001',
      paymentReference: 'QMBAD00001',
      currency: 'VND',
      totalAmountMinor: 20001,
      lines: [{ productId: 'coffee', productName: 'Coffee', quantity: 1, unitPriceMinor: 20000, lineTotalMinor: 20000, notes: '' }],
      idempotencyKey: 'bad-total-key-0123456789',
      orderToken: generateOpaqueToken(),
    });
    await expect(env.DB.batch(statements)).rejects.toThrow(/NOT NULL constraint failed: orders\.order_code/);
    expect(await count('orders')).toBe(0);
    expect(await count('order_items')).toBe(0);
    expect(await count('order_access')).toBe(0);
  });
});

describe('GET /api/storefront/orders/current', () => {
  it('returns only the order bound to the presented capability', async () => {
    const tokenA = generateOpaqueToken();
    const tokenB = generateOpaqueToken();
    const a = await (await postOrder({ items: [{ productId: 'coffee', quantity: 1 }] }, { orderToken: tokenA })).json<{ orderCode: string }>();
    await postOrder({ items: [{ productId: 'tea', quantity: 2 }] }, { orderToken: tokenB });

    const current = await settle(await getCurrent(tokenA));
    expect(current.status).toBe(200);
    expect(current.body).toMatchObject({ orderCode: a.orderCode, status: 'pending_payment', tableNumber: '5', items: [{ productName: 'Product coffee', quantity: 1 }] });
    expect(await settle(await getCurrent(generateOpaqueToken()))).toEqual(NOT_FOUND);
    expect(await settle(await getCurrent('garbage'))).toEqual(NOT_FOUND);
  });
});
