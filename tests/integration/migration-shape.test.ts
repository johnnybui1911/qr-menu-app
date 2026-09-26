import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, resetDbThrough } from '../support/test-env.ts';
import { insertCategory, insertOrder, insertProduct, insertTable } from '../support/seed.ts';

const DIGEST = 'a'.repeat(64);
const run = (sql: string, ...values: unknown[]) => env.DB.prepare(sql).bind(...values).run();

// Error text D1 surfaces for each constraint kind. Later phases map batch failures by these shapes (C12).
const FK_FAILED = /FOREIGN KEY constraint failed/;
const checkFailed = (constraintOrColumn: string) => new RegExp(`CHECK constraint failed: [^\\n]*${constraintOrColumn}`);
const notNullFailed = (column: string) => new RegExp(`NOT NULL constraint failed: ${column.replace('.', '\\.')}`);
const uniqueFailed = (columns: string) => new RegExp(`UNIQUE constraint failed: ${columns.replace(/\./g, '\\.')}`);

beforeEach(async () => {
  await resetDb();
  await insertCategory();
  await insertProduct('prod-1');
  await insertTable();
  await insertOrder();
});

/** One valid row per business table, parameterised by store id. */
const ROW_BY_TABLE: Record<string, (store: string) => Promise<unknown>> = {
  categories: (s) => run("INSERT INTO categories (id, store_id, name, slug) VALUES ('cat-x', ?, 'X', 'x')", s),
  products: (s) => run("INSERT INTO products (id, store_id, category_id, name, price_minor) VALUES ('prod-x', ?, 'cat-1', 'X', 1)", s),
  tables: (s) => run("INSERT INTO tables (id, store_id, table_number) VALUES ('table-x', ?, '99')", s),
  table_secrets: (s) => run("INSERT INTO table_secrets (id, store_id, table_id, token_digest) VALUES ('ts-x', ?, 'table-1', ?)", s, DIGEST),
  orders: (s) =>
    run(
      "INSERT INTO orders (id, store_id, order_code, table_id, currency, total_amount_minor, payment_method, payment_reference) VALUES ('order-x', ?, 'XYZ789', 'table-1', 'VND', 0, 'vietqr', 'QM0000000X')",
      s,
    ),
  order_access: (s) => run("INSERT INTO order_access (id, store_id, order_id, capability_digest) VALUES ('oa-x', ?, 'order-1', ?)", s, DIGEST),
  order_items: (s) =>
    run(
      "INSERT INTO order_items (id, store_id, order_id, product_id, product_name_snapshot, quantity, unit_price_snapshot_minor, line_total_minor, currency, position) VALUES ('oi-x', ?, 'order-1', 'prod-1', 'P', 1, 0, 0, 'VND', 0)",
      s,
    ),
  refund_requests: (s) =>
    run("INSERT INTO refund_requests (id, store_id, order_id, requested_by_staff_id, reason) VALUES ('rr-x', ?, 'order-1', 'user-1', 'r')", s),
  order_idempotency: async (s) => {
    await run("INSERT OR IGNORE INTO order_access (id, store_id, order_id, capability_digest) VALUES ('oa-1', 'store_default', 'order-1', ?)", DIGEST);
    return run(
      "INSERT INTO order_idempotency (id, store_id, request_key, capability_digest, order_id) VALUES ('oid-x', ?, 'key-0123456789abcdef', ?, 'order-1')",
      s,
      DIGEST,
    );
  },
  order_commands: (s) =>
    run(
      "INSERT INTO order_commands (id, store_id, request_key, payload_hash, action, order_id, result_json) VALUES ('oc-x', ?, 'key-0123456789abcdef', ?, 'order:prepare', 'order-1', '{}')",
      s,
      DIGEST,
    ),
  provider_events: (s) =>
    run(
      "INSERT INTO provider_events (id, store_id, provider, provider_event_id, source, verified, facts_fingerprint, raw_payload) VALUES ('pe-x', ?, 'bank', 'tx-x', 'webhook', 1, ?, '{}')",
      s,
      DIGEST,
    ),
  provider_payments: (s) =>
    run("INSERT INTO provider_payments (id, store_id, order_id, provider_event_id, amount_minor) VALUES ('pp-x', ?, 'order-1', 'tx-x', 1000)", s),
  order_email_jobs: (s) =>
    run("INSERT INTO order_email_jobs (id, store_id, kind, dedupe_key) VALUES ('job-x', ?, 'daily_revenue_report', 'daily:2026-09-19')", s),
};

describe('schema shape (0001 + 0002)', () => {
  it('covers every business table created by migrations 0001 and 0002', async () => {
    // Later migrations add identity tables (better-auth) that are not store-scoped business tables.
    await resetDbThrough(2);
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT IN ('d1_migrations', 'stores') ORDER BY name",
    ).all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(Object.keys(ROW_BY_TABLE).sort());
  });

  it.each(Object.keys(ROW_BY_TABLE))('%s requires a store_id that exists in stores', async (table) => {
    await expect(ROW_BY_TABLE[table]('store_unknown')).rejects.toThrow(FK_FAILED);
    await expect(ROW_BY_TABLE[table]('store_default')).resolves.toBeDefined();
  });

  it('restricts orders.status to the six lifecycle values, spelled cancelled', async () => {
    await expect(run("UPDATE orders SET status = 'canceled' WHERE id = 'order-1'")).rejects.toThrow(checkFailed('status'));
    for (const status of ['pending_payment', 'paid', 'preparing', 'fulfilled', 'cancelled', 'refunded']) {
      await run('UPDATE orders SET status = ? WHERE id = ?', status, 'order-1');
    }
  });

  it('restricts payment_method to vietqr', async () => {
    await expect(run("UPDATE orders SET payment_method = 'cash' WHERE id = 'order-1'")).rejects.toThrow(checkFailed('payment_method'));
  });

  it('never defaults payment_reference and enforces its format and uniqueness', async () => {
    await expect(
      run("INSERT INTO orders (id, store_id, order_code, table_id, currency, total_amount_minor, payment_method) VALUES ('o2', 'store_default', 'C2', 'table-1', 'VND', 0, 'vietqr')"),
    ).rejects.toThrow(notNullFailed('orders.payment_reference'));
    for (const bad of ['QM1234567', 'QMabcdefgh', 'XX12345678']) {
      await expect(run('UPDATE orders SET payment_reference = ? WHERE id = ?', bad, 'order-1')).rejects.toThrow(
        checkFailed('orders_payment_reference_format'),
      );
    }
    await expect(insertOrder('order-2', { orderCode: 'DEF456' })).rejects.toThrow(
      uniqueFailed('orders.store_id, orders.payment_reference'),
    );
  });

  it('keeps needs_attention boolean and off by default', async () => {
    expect(await env.DB.prepare("SELECT needs_attention FROM orders WHERE id = 'order-1'").first('needs_attention')).toBe(0);
    await expect(run("UPDATE orders SET needs_attention = 2 WHERE id = 'order-1'")).rejects.toThrow(checkFailed('needs_attention'));
  });

  it('bumps updated_at when a writer changes status or the attention flag without it', async () => {
    await run("UPDATE orders SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = 'order-1'");
    await run("UPDATE orders SET status = 'paid' WHERE id = 'order-1'");
    const afterStatus = await env.DB.prepare("SELECT updated_at FROM orders WHERE id = 'order-1'").first<string>('updated_at');
    expect(afterStatus! > '2000-01-01T00:00:00.000Z').toBe(true);

    await run("UPDATE orders SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = 'order-1'");
    await run("UPDATE orders SET needs_attention = 1 WHERE id = 'order-1'");
    expect((await env.DB.prepare("SELECT updated_at FROM orders WHERE id = 'order-1'").first<string>('updated_at'))! > '2000').toBe(true);

    // A writer that sets updated_at itself keeps its own value.
    await run("UPDATE orders SET status = 'preparing', updated_at = '2030-01-01T00:00:00.000Z' WHERE id = 'order-1'");
    expect(await env.DB.prepare("SELECT updated_at FROM orders WHERE id = 'order-1'").first('updated_at')).toBe('2030-01-01T00:00:00.000Z');
  });

  it('rejects an order line whose total is not unit price times quantity', async () => {
    await expect(
      run(
        "INSERT INTO order_items (id, store_id, order_id, product_id, product_name_snapshot, quantity, unit_price_snapshot_minor, line_total_minor, currency, position) VALUES ('oi-1', 'store_default', 'order-1', 'prod-1', 'P', 2, 20000, 39999, 'VND', 0)",
      ),
    ).rejects.toThrow(checkFailed('order_items_line_total'));
  });

  it('records at most one payment per order', async () => {
    await run("INSERT INTO provider_payments (id, store_id, order_id, provider_event_id, amount_minor) VALUES ('pp-1', 'store_default', 'order-1', 'tx-1', 1000)");
    await expect(
      run("INSERT INTO provider_payments (id, store_id, order_id, provider_event_id, amount_minor) VALUES ('pp-2', 'store_default', 'order-1', 'tx-2', 1000)"),
    ).rejects.toThrow(uniqueFailed('provider_payments.store_id, provider_payments.order_id'));
  });

  it('lets unverified provider events share an id without claiming the idempotency key', async () => {
    const insert = (id: string, verified: 0 | 1) =>
      run(
        "INSERT INTO provider_events (id, store_id, provider, provider_event_id, source, verified, facts_fingerprint, raw_payload) VALUES (?, 'store_default', 'bank', 'tx-1', 'webhook', ?, ?, '{}')",
        id,
        verified,
        verified ? DIGEST : null,
      );
    await insert('pe-1', 0);
    await insert('pe-2', 1);
    await expect(insert('pe-3', 1)).rejects.toThrow(uniqueFailed('provider_events.provider, provider_events.provider_event_id'));
  });

  it('requires a facts fingerprint on verified provider events and allows unmatched ones without an order', async () => {
    await expect(
      run("INSERT INTO provider_events (id, store_id, provider, provider_event_id, source, verified, raw_payload) VALUES ('pe-1', 'store_default', 'bank', 'tx-1', 'webhook', 1, '{}')"),
    ).rejects.toThrow(checkFailed('provider_events_verified_fingerprint'));
    await run(
      "INSERT INTO provider_events (id, store_id, provider, provider_event_id, source, verified, facts_fingerprint, raw_payload, outcome) VALUES ('pe-2', 'store_default', 'bank', 'tx-2', 'reconciliation', 1, ?, '{}', 'unmatched')",
      DIGEST,
    );
    await expect(
      run("INSERT INTO provider_events (id, store_id, provider, provider_event_id, source, verified, raw_payload) VALUES ('pe-3', 'store_default', 'bank', 'tx-3', 'manual', 0, '{}')"),
    ).rejects.toThrow(checkFailed('source'));
  });

  it.each([
    ['63 characters', 'a'.repeat(63)],
    ['uppercase hex', 'A'.repeat(64)],
    ['non-hex', 'g'.repeat(64)],
  ])('rejects a token digest with %s', async (_label, digest) => {
    await expect(
      run("INSERT INTO table_secrets (id, store_id, table_id, token_digest) VALUES ('ts-1', 'store_default', 'table-1', ?)", digest),
    ).rejects.toThrow(checkFailed('token_digest'));
  });

  it('accepts email jobs without an order, restricts kinds, and dedupes by key', async () => {
    const insert = (id: string, kind: string, dedupeKey: string) =>
      run('INSERT INTO order_email_jobs (id, store_id, kind, dedupe_key) VALUES (?, ?, ?, ?)', id, 'store_default', kind, dedupeKey);
    await insert('job-1', 'daily_revenue_report', 'daily:2026-09-19');
    await expect(insert('job-2', 'bogus', 'bogus:1')).rejects.toThrow(checkFailed('kind'));
    await expect(insert('job-3', 'daily_revenue_report', 'daily:2026-09-19')).rejects.toThrow(
      uniqueFailed('order_email_jobs.store_id, order_email_jobs.dedupe_key'),
    );
    await insert('job-4', 'invitation', 'invite:inv-1');
    await insert('job-5', 'refund_confirmed', 'refund:order-1');
  });

  it('scopes order line foreign keys to the same store and currency', async () => {
    await run("INSERT INTO stores (id, name) VALUES ('store_other', 'Other')");
    await insertCategory('cat-other', { store: 'store_other' });
    await insertProduct('prod-other', { categoryId: 'cat-other', store: 'store_other' });
    const line = (id: string, productId: string, currency: string) =>
      run(
        "INSERT INTO order_items (id, store_id, order_id, product_id, product_name_snapshot, quantity, unit_price_snapshot_minor, line_total_minor, currency, position) VALUES (?, 'store_default', 'order-1', ?, 'P', 1, 0, 0, ?, ?)",
        id,
        productId,
        currency,
        id === 'oi-1' ? 0 : 1,
      );
    await expect(line('oi-1', 'prod-other', 'VND')).rejects.toThrow(FK_FAILED);
    await expect(line('oi-2', 'prod-1', 'USD')).rejects.toThrow(FK_FAILED);
  });

  it('binds an idempotency key to the capability the order was created with', async () => {
    await run("INSERT INTO order_access (id, store_id, order_id, capability_digest) VALUES ('oa-1', 'store_default', 'order-1', ?)", DIGEST);
    await expect(
      run(
        "INSERT INTO order_idempotency (id, store_id, request_key, capability_digest, order_id) VALUES ('oid-1', 'store_default', 'key-0123456789abcdef', ?, 'order-1')",
        'b'.repeat(64),
      ),
    ).rejects.toThrow(FK_FAILED);
  });

  it('restricts provider event outcomes to the settlement vocabulary', async () => {
    const insert = (id: string, outcome: string) =>
      run(
        "INSERT INTO provider_events (id, store_id, provider, provider_event_id, source, verified, raw_payload, outcome) VALUES (?, 'store_default', 'bank', ?, 'webhook', 0, '{}', ?)",
        id,
        `unverified:${id}`,
        outcome,
      );
    await insert('pe-1', 'signature_invalid');
    await expect(insert('pe-2', 'settled')).rejects.toThrow(checkFailed('outcome'));
  });

  it('makes a refund decision final with a stable error code', async () => {
    await run(
      "INSERT INTO refund_requests (id, store_id, order_id, requested_by_staff_id, reason, status, decided_at, decided_by_user_id) VALUES ('rr-1', 'store_default', 'order-1', 'user-1', 'r', 'approved', '2026-09-19T00:00:00.000Z', 'owner-1')",
    );
    await expect(run("UPDATE refund_requests SET status = 'rejected' WHERE id = 'rr-1'")).rejects.toThrow(/refund_decision_is_final/);
  });

  it('applies cleanly on repeated resets', async () => {
    await resetDb();
    await resetDb();
    await resetDb();
    expect(await env.DB.prepare("SELECT id FROM stores WHERE id = 'store_default'").first('id')).toBe('store_default');
    expect(await env.DB.prepare('SELECT count(*) AS n FROM orders').first('n')).toBe(0);
  });
});
