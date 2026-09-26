import { digestOrderCapability } from './private-access.ts';

export type CustomerOrderLine = { productName: string; quantity: number; unitPriceMinor: number; lineTotalMinor: number; notes: string };

export type CustomerOrder = {
  id: string;
  orderCode: string;
  status: string;
  tableNumber: string;
  currency: string;
  totalAmountMinor: number;
  paymentReference: string;
  createdAt: string;
  items: CustomerOrderLine[];
};

type CustomerOrderRow = {
  id: string;
  order_code: string;
  status: string;
  table_number: string;
  currency: string;
  total_amount_minor: number;
  payment_reference: string;
  created_at: string;
};

type CustomerOrderLineRow = { product_name_snapshot: string; quantity: number; unit_price_snapshot_minor: number; line_total_minor: number; notes: string };

const CUSTOMER_ORDER_SQL = `
  SELECT o.id, o.order_code, o.status, t.table_number, o.currency, o.total_amount_minor, o.payment_reference, o.created_at
  FROM orders o
  JOIN tables t ON t.id = o.table_id AND t.store_id = o.store_id`;

async function readCustomerOrder(db: D1Database, storeId: string, row: CustomerOrderRow | null): Promise<CustomerOrder | null> {
  if (!row) return null;
  const { results } = await db
    .prepare(
      'SELECT product_name_snapshot, quantity, unit_price_snapshot_minor, line_total_minor, notes FROM order_items WHERE store_id = ? AND order_id = ? ORDER BY position',
    )
    .bind(storeId, row.id)
    .all<CustomerOrderLineRow>();
  return {
    id: row.id,
    orderCode: row.order_code,
    status: row.status,
    tableNumber: row.table_number,
    currency: row.currency,
    totalAmountMinor: row.total_amount_minor,
    paymentReference: row.payment_reference,
    createdAt: row.created_at,
    items: results.map((line) => ({
      productName: line.product_name_snapshot,
      quantity: line.quantity,
      unitPriceMinor: line.unit_price_snapshot_minor,
      lineTotalMinor: line.line_total_minor,
      notes: line.notes,
    })),
  };
}

export async function readCustomerOrderById(db: D1Database, storeId: string, orderId: string): Promise<CustomerOrder | null> {
  const row = await db.prepare(`${CUSTOMER_ORDER_SQL} WHERE o.store_id = ? AND o.id = ?`).bind(storeId, orderId).first<CustomerOrderRow>();
  return readCustomerOrder(db, storeId, row);
}

/** Secret Link lookup (D8): one JOIN on the capability digest; unknown or malformed tokens return null. */
export async function readOrderByCapability(db: D1Database, storeId: string, token: string | null): Promise<CustomerOrder | null> {
  const digest = await digestOrderCapability(token);
  if (!digest) return null;
  const row = await db
    .prepare(
      `${CUSTOMER_ORDER_SQL}
       JOIN order_access a ON a.order_id = o.id AND a.store_id = o.store_id
       WHERE o.store_id = ? AND a.capability_digest = ?`,
    )
    .bind(storeId, digest)
    .first<CustomerOrderRow>();
  return readCustomerOrder(db, storeId, row);
}
