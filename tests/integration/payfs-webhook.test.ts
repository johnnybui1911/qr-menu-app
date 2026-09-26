import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { generateOpaqueToken } from '@qr/identity/token-digest';
import worker from '../../apps/worker/src/index.ts';
import { resetDb } from '../support/test-env.ts';
import { creditPayload, signedWebhook } from '../support/payfs.ts';
import { insertCategory, insertOrder, insertProduct, insertTable, insertTableSecret } from '../support/seed.ts';

const REFERENCE = 'QM7K2P9X4B';
const content = (reference = REFERENCE) => `NGUYEN VAN A chuyen tien  Ma giao dich  ${reference} Trace773231`;
const send = async (request: Request) => {
  const response = await exports.default.fetch(request);
  return { status: response.status, body: await response.json<Record<string, unknown>>() };
};
const orderRow = () =>
  env.DB.prepare("SELECT status, needs_attention FROM orders WHERE id = 'order-1'").first<{ status: string; needs_attention: number }>();
const count = (sql: string) => env.DB.prepare(`SELECT count(*) AS n FROM ${sql}`).first<number>('n');

async function callWorker(request: Request, overrides: Partial<Env>) {
  const ctx = createExecutionContext();
  const response = await worker.fetch!(request as Request<unknown, IncomingRequestCfProperties>, { ...env, ...overrides }, ctx);
  await waitOnExecutionContext(ctx);
  return { status: response.status, body: await response.json() };
}

beforeEach(async () => {
  await resetDb();
  await insertTable();
  await insertOrder('order-1', { totalMinor: 45000, paymentReference: REFERENCE });
});

describe('POST /api/payfs/webhook — verification (D5)', () => {
  it('rejects bodies over 16 KB before reading them', async () => {
    const huge = await signedWebhook(creditPayload({ content: 'x'.repeat(17 * 1024) }));
    expect(await send(huge)).toEqual({ status: 413, body: { error: 'payload_too_large' } });
    expect(await count('provider_events')).toBe(0);
  });

  it('rejects a wrong API key without recording anything', async () => {
    expect(await send(await signedWebhook(creditPayload({ content: content() }), { apiKey: 'wrong' }))).toEqual({
      status: 401,
      body: { error: 'unauthorized' },
    });
    expect(await count('provider_events')).toBe(0);
  });

  it('rejects a correctly signed but stale timestamp', async () => {
    const stale = await signedWebhook(creditPayload({ content: content() }), { timestamp: Math.floor(Date.now() / 1000) - 301 });
    expect((await send(stale)).status).toBe(401);
    expect((await orderRow())!.status).toBe('pending_payment');
  });

  it('rejects malformed JSON', async () => {
    expect((await send(await signedWebhook({}, { body: '{"a":' }))).status).toBe(400);
  });

  it('records a signature mismatch without claiming the transaction id, so a valid retry still settles', async () => {
    const payload = creditPayload({ amount: 45000, content: content() });
    const tampered = await signedWebhook(payload, { body: JSON.stringify({ ...payload, amount: 45001 }) });
    expect((await send(tampered)).status).toBe(401);
    const unverified = await env.DB.prepare('SELECT provider_event_id, verified, raw_payload, outcome FROM provider_events').all();
    expect(unverified.results).toEqual([
      { provider_event_id: expect.stringMatching(/^unverified:[0-9a-f]{64}$/), verified: 0, raw_payload: JSON.stringify({ ...payload, amount: 45001 }), outcome: 'signature_invalid' },
    ]);

    expect(await send(await signedWebhook(payload))).toEqual({ status: 200, body: { outcome: 'paid' } });
    expect((await orderRow())!.status).toBe('paid');
  });

  it.each(['sha256=abc', 'a'.repeat(63), `${'a'.repeat(62)}zz`])('rejects a malformed signature header %s', async (signature) => {
    const request = await signedWebhook(creditPayload({ content: content() }));
    request.headers.set('x-payfs-signature', signature);
    expect((await send(request)).status).toBe(401);
    expect(await count('provider_events WHERE verified = 1')).toBe(0);
  });

  it.each([{ PAYFS_WEBHOOK_SECRET: '' }, { PAYFS_WEBHOOK_API_KEY: undefined }])('fails closed when a webhook secret is missing %j', async (overrides) => {
    const response = await callWorker(await signedWebhook(creditPayload({ content: content() })), overrides);
    expect(response).toEqual({ status: 503, body: { error: 'payfs_not_configured' } });
    expect((await orderRow())!.status).toBe('pending_payment');
  });

  it('acknowledges a debit without touching any order', async () => {
    expect(await send(await signedWebhook(creditPayload({ transfer_type: 'debit', content: content() })))).toEqual({
      status: 200,
      body: { outcome: 'ignored_debit' },
    });
    expect(await orderRow()).toEqual({ status: 'pending_payment', needs_attention: 0 });
    expect(await count("provider_events WHERE outcome = 'ignored_debit'")).toBe(1);
  });
});

describe('POST /api/payfs/webhook — settlement', () => {
  it('marks the matching order paid in one batch and enqueues no email', async () => {
    expect(await send(await signedWebhook(creditPayload({ content: content() })))).toEqual({ status: 200, body: { outcome: 'paid' } });
    expect(await orderRow()).toEqual({ status: 'paid', needs_attention: 0 });
    expect(await count("provider_payments WHERE order_id = 'order-1' AND amount_minor = 45000")).toBe(1);
    expect(await count("provider_events WHERE order_id = 'order-1' AND outcome = 'paid' AND verified = 1 AND source = 'webhook'")).toBe(1);
    expect(await count('order_email_jobs')).toBe(0);
  });

  it('treats a replay of the same transaction as already processed', async () => {
    const payload = creditPayload({ content: content() });
    await send(await signedWebhook(payload));
    expect(await send(await signedWebhook(payload))).toEqual({ status: 200, body: { outcome: 'already_processed' } });
    expect(await count('provider_payments')).toBe(1);
    expect(await count('provider_events')).toBe(1);
  });

  it('rejects the same transaction id with different facts and never retargets money', async () => {
    const payload = creditPayload({ content: content() });
    await send(await signedWebhook(payload));
    expect(await send(await signedWebhook({ ...payload, amount: 99000 }))).toEqual({ status: 400, body: { error: 'provider_facts_conflict' } });
    expect(await count('provider_payments')).toBe(1);
  });

  it('does not mark an underpaid order paid and flags it for the owner', async () => {
    expect(await send(await signedWebhook(creditPayload({ amount: 44999, content: content() })))).toEqual({
      status: 200,
      body: { outcome: 'amount_mismatch' },
    });
    expect(await orderRow()).toEqual({ status: 'pending_payment', needs_attention: 1 });
    expect(await count("provider_events WHERE outcome = 'amount_mismatch' AND order_id = 'order-1'")).toBe(1);
  });

  it('records a second payment for an already-paid order without double counting', async () => {
    await send(await signedWebhook(creditPayload({ content: content() })));
    expect(await send(await signedWebhook(creditPayload({ content: content() })))).toEqual({ status: 200, body: { outcome: 'already_paid' } });
    expect(await orderRow()).toEqual({ status: 'paid', needs_attention: 1 });
    expect(await count('provider_payments')).toBe(1);
    expect(await count("provider_events WHERE outcome = 'already_paid'")).toBe(1);
    expect(await count('order_email_jobs')).toBe(0);
  });

  it('records money for a cancelled order without reviving it', async () => {
    await env.DB.prepare("UPDATE orders SET status = 'cancelled' WHERE id = 'order-1'").run();
    expect(await send(await signedWebhook(creditPayload({ content: content() })))).toEqual({ status: 200, body: { outcome: 'unmatched_payment' } });
    expect(await orderRow()).toEqual({ status: 'cancelled', needs_attention: 1 });
    expect(await count('provider_payments')).toBe(0);
  });

  it.each([
    ['no reference', 'chuyen tien an trua', 'unmatched'],
    ['two references', `${REFERENCE} ${'QMAAAAAAAA'}`, 'unmatched_ambiguous'],
    ['an unknown reference', content('QMZZZZZZZZ'), 'order_not_found'],
  ])('records a credit with %s without an order', async (_label, transferContent, outcome) => {
    expect(await send(await signedWebhook(creditPayload({ content: transferContent })))).toEqual({ status: 200, body: { outcome } });
    expect(await count(`provider_events WHERE outcome = '${outcome}' AND order_id IS NULL`)).toBe(1);
    expect((await orderRow())!.status).toBe('pending_payment');
  });

  it('leaves no partial ledger when the settle batch aborts, and settles on retry', async () => {
    await env.DB.prepare(
      'CREATE TRIGGER sabotage_payment AFTER INSERT ON provider_payments BEGIN DELETE FROM provider_payments WHERE id = NEW.id; END',
    ).run();
    const payload = creditPayload({ content: content() });
    expect(await send(await signedWebhook(payload))).toEqual({ status: 503, body: { error: 'settlement_retry' } });
    expect((await orderRow())!.status).toBe('pending_payment');
    expect(await count('provider_payments')).toBe(0);
    expect(await count('provider_events')).toBe(0);

    await env.DB.prepare('DROP TRIGGER sabotage_payment').run();
    expect(await send(await signedWebhook(payload))).toEqual({ status: 200, body: { outcome: 'paid' } });
  });

  it('settles well inside PayFS’s 30 second response budget', async () => {
    const started = Date.now();
    await send(await signedWebhook(creditPayload({ content: content() })));
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('money path end to end (M1)', () => {
  it('pays an order placed through the storefront route', async () => {
    await insertCategory();
    await insertProduct('coffee', { priceMinor: 25000 });
    const tableToken = generateOpaqueToken();
    const orderToken = generateOpaqueToken();
    await insertTableSecret('table-1', tableToken);
    const created = await exports.default.fetch('http://api.test/api/storefront/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-table-token': tableToken, 'idempotency-key': crypto.randomUUID(), 'x-order-token': orderToken },
      body: JSON.stringify({ items: [{ productId: 'coffee', quantity: 2 }] }),
    });
    const order = await created.json<{ paymentReference: string; totalAmountMinor: number }>();

    const paid = await send(await signedWebhook(creditPayload({ amount: order.totalAmountMinor, content: `CT ${order.paymentReference.toLowerCase()} FT2609` })));
    expect(paid).toEqual({ status: 200, body: { outcome: 'paid' } });
    const current = await exports.default.fetch('http://api.test/api/storefront/orders/current', { headers: { 'x-order-token': orderToken } });
    expect(await current.json()).toMatchObject({ status: 'paid', vietqrPayload: null });
  });
});
