import { env } from 'cloudflare:workers';
import { sha256Hex } from '@qr/identity/token-digest';

export const TEST_STORE = 'store_default';

export async function insertCategory(id = 'cat-1', { displayOrder = 0, isActive = 1, store = TEST_STORE } = {}) {
  await env.DB.prepare('INSERT INTO categories (id, store_id, name, slug, display_order, is_active) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, store, `Category ${id}`, id, displayOrder, isActive)
    .run();
  return id;
}

export async function insertProduct(
  id: string,
  { categoryId = 'cat-1', priceMinor = 20000, isAvailable = 1, displayOrder = 0, store = TEST_STORE, currency = 'VND' } = {},
) {
  await env.DB.prepare(
    'INSERT INTO products (id, store_id, category_id, name, currency, price_minor, is_available, display_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(id, store, categoryId, `Product ${id}`, currency, priceMinor, isAvailable, displayOrder)
    .run();
  return id;
}

export async function insertTable(id = 'table-1', number = '1') {
  await env.DB.prepare('INSERT INTO tables (id, store_id, table_number) VALUES (?, ?, ?)').bind(id, TEST_STORE, number).run();
  return id;
}

export async function insertOrder(
  id = 'order-1',
  {
    tableId = 'table-1',
    status = 'pending_payment',
    totalMinor = 0,
    paymentReference = 'QM00000001',
    orderCode = 'ABC123',
    createdAt = new Date().toISOString(),
  } = {},
) {
  await env.DB.prepare(
    `INSERT INTO orders (id, store_id, order_code, table_id, status, currency, total_amount_minor, payment_method, payment_reference, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'VND', ?, 'vietqr', ?, ?, ?)`,
  )
    .bind(id, TEST_STORE, orderCode, tableId, status, totalMinor, paymentReference, createdAt, createdAt)
    .run();
  return id;
}

/** Stores the digest of `token` for `tableId`; `revokedAt` sets the end of the rotation grace window. */
export async function insertTableSecret(tableId: string, token: string, revokedAt: string | null = null) {
  await env.DB.prepare('INSERT INTO table_secrets (id, store_id, table_id, token_digest, revoked_at) VALUES (?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), TEST_STORE, tableId, await sha256Hex(token), revokedAt)
    .run();
}
