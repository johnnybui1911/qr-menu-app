import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { STORE_ID } from '@qr/identity/store';
import { readKitchenInbox } from '@qr/orders/kitchen-inbox';
import { resetDb } from '../support/test-env.ts';
import { insertCategory, insertOrder, insertProduct, insertTable } from '../support/seed.ts';

const at = (minute: number) => `2026-09-26T10:${String(minute).padStart(2, '0')}:00.000Z`;
async function order(id: string, status: string, updatedAt: string, needsAttention = 0) {
  await insertOrder(id, { status, paymentReference: `QM${id.toUpperCase().padEnd(8, '0').slice(0, 8)}`, orderCode: id.toUpperCase().padEnd(6, '0').slice(0, 6) });
  // Setting updated_at in the same statement keeps the touch trigger from overriding it.
  await env.DB.prepare('UPDATE orders SET updated_at = ?, needs_attention = ? WHERE id = ?').bind(updatedAt, needsAttention, id).run();
}

beforeEach(async () => {
  await resetDb();
  await insertTable('table-1', '5');
});

describe('readKitchenInbox (D7)', () => {
  it('starts from the active orders only: paid and preparing', async () => {
    await order('aaa', 'paid', at(1));
    await order('bbb', 'preparing', at(2));
    await order('ccc', 'pending_payment', at(3));
    await order('ddd', 'fulfilled', at(4));
    await order('eee', 'cancelled', at(5));
    const inbox = await readKitchenInbox(env.DB, STORE_ID, { cursor: null, limit: 100 });
    expect(inbox.orders.map((o) => [o.id, o.status, o.tableNumber])).toEqual([
      ['aaa', 'paid', '5'],
      ['bbb', 'preparing', '5'],
    ]);
  });

  it('then returns only what changed after the cursor, including orders leaving the kitchen', async () => {
    await order('aaa', 'paid', at(1));
    const first = await readKitchenInbox(env.DB, STORE_ID, { cursor: null, limit: 100 });
    await order('bbb', 'paid', at(2));
    await env.DB.prepare("UPDATE orders SET status = 'fulfilled', updated_at = ? WHERE id = 'aaa'").bind(at(3)).run();
    await order('ccc', 'pending_payment', at(4));
    const next = await readKitchenInbox(env.DB, STORE_ID, { cursor: first.cursor, limit: 100 });
    expect(next.orders.map((o) => [o.id, o.status])).toEqual([
      ['bbb', 'paid'],
      ['aaa', 'fulfilled'],
    ]);
  });

  it('pages through orders sharing one updated_at without losing or repeating any', async () => {
    await order('aaa', 'paid', at(1));
    const start = await readKitchenInbox(env.DB, STORE_ID, { cursor: null, limit: 100 });
    for (const id of ['bbb', 'ccc', 'ddd']) await order(id, 'paid', at(5));
    const page1 = await readKitchenInbox(env.DB, STORE_ID, { cursor: start.cursor, limit: 2 });
    const page2 = await readKitchenInbox(env.DB, STORE_ID, { cursor: page1.cursor, limit: 2 });
    expect(page1.orders.map((o) => o.id)).toEqual(['bbb', 'ccc']);
    expect(page2.orders.map((o) => o.id)).toEqual(['ddd']);
    expect(page1.cursor).toEqual({ updatedAt: at(5), id: 'ccc' });
  });

  it('keeps the cursor and ETag stable when nothing changed', async () => {
    await order('aaa', 'paid', at(1));
    const first = await readKitchenInbox(env.DB, STORE_ID, { cursor: null, limit: 100 });
    const again = await readKitchenInbox(env.DB, STORE_ID, { cursor: first.cursor, limit: 100 });
    const third = await readKitchenInbox(env.DB, STORE_ID, { cursor: first.cursor, limit: 100 });
    expect(again.orders).toEqual([]);
    expect(again.cursor).toEqual(first.cursor);
    expect(third.etag).toBe(again.etag);
    expect(again.etag).not.toBe(first.etag);
  });

  it('carries needs_attention and line items for the kitchen ticket', async () => {
    await order('aaa', 'paid', at(1), 1);
    await insertCategory('c');
    await insertProduct('p', { categoryId: 'c' });
    await env.DB.prepare(
      "INSERT INTO order_items (id, store_id, order_id, product_id, product_name_snapshot, quantity, unit_price_snapshot_minor, line_total_minor, currency, notes, position) VALUES ('li-1', 'store_default', 'aaa', 'p', 'Cà phê sữa', 2, 0, 0, 'VND', 'ít đá', 0)",
    ).run();
    const [ticket] = (await readKitchenInbox(env.DB, STORE_ID, { cursor: null, limit: 100 })).orders;
    expect(ticket).toMatchObject({ id: 'aaa', needsAttention: true, items: [{ productName: 'Cà phê sữa', quantity: 2, notes: 'ít đá' }] });
  });

  it('reads through the kitchen index and never more than the limit', async () => {
    const statements = Array.from({ length: 500 }, (_, i) =>
      env.DB.prepare(
        "INSERT INTO orders (id, store_id, order_code, table_id, status, currency, total_amount_minor, payment_method, payment_reference, updated_at) VALUES (?, 'store_default', ?, 'table-1', 'paid', 'VND', 0, 'vietqr', ?, ?)",
      ).bind(`o${String(i).padStart(4, '0')}`, `K${String(i).padStart(5, '0')}`, `QMK${String(i).padStart(7, '0')}`, at(i % 60)),
    );
    await env.DB.batch(statements);
    const inbox = await readKitchenInbox(env.DB, STORE_ID, { cursor: { updatedAt: at(0), id: '' }, limit: 100 });
    expect(inbox.orders).toHaveLength(100);
    const plan = await env.DB.prepare(
      "EXPLAIN QUERY PLAN SELECT id FROM orders WHERE store_id = ? AND status IN ('paid','preparing','fulfilled','refunded') AND (updated_at > ? OR (updated_at = ? AND id > ?)) ORDER BY updated_at, id LIMIT 100",
    )
      .bind(STORE_ID, at(0), at(0), '')
      .all<{ detail: string }>();
    expect(plan.results.map((r) => r.detail).join(' | ')).toMatch(/orders_kitchen_idx/);
  });
});
