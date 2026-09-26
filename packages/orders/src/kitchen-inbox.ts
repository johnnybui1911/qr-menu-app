import { sha256Hex } from '@qr/identity/token-digest';

// Kitchen polling (D7): keyset pagination on (updated_at, id) over orders_kitchen_idx, so each 3-second poll reads
// only what changed.

export type KitchenCursor = { updatedAt: string; id: string };

export type KitchenTicket = {
  id: string;
  orderCode: string;
  tableNumber: string;
  status: string;
  totalAmountMinor: number;
  needsAttention: boolean;
  createdAt: string;
  updatedAt: string;
  items: { productName: string; quantity: number; notes: string }[];
};

export type KitchenInbox = { orders: KitchenTicket[]; cursor: KitchenCursor | null; etag: string };

// A first load shows only work in progress; later polls also return orders leaving the kitchen so clients can drop them.
const ACTIVE_STATUSES_SQL = "('paid', 'preparing')";
const TRACKED_STATUSES_SQL = "('paid', 'preparing', 'fulfilled', 'refunded')";

const MAX_IDS_PER_QUERY = 90;
const TICKET_COLUMNS_SQL = `o.id, o.order_code, t.table_number, o.status, o.total_amount_minor, o.needs_attention, o.created_at, o.updated_at`;

type TicketRow = {
  id: string;
  order_code: string;
  table_number: string;
  status: string;
  total_amount_minor: number;
  needs_attention: number;
  created_at: string;
  updated_at: string;
};

export async function readKitchenInbox(db: D1Database, storeId: string, request: { cursor: KitchenCursor | null; limit: number }): Promise<KitchenInbox> {
  const { cursor, limit } = request;
  const rows = cursor
    ? await db
        .prepare(
          `SELECT ${TICKET_COLUMNS_SQL} FROM orders o JOIN tables t ON t.id = o.table_id AND t.store_id = o.store_id
           WHERE o.store_id = ? AND o.status IN ${TRACKED_STATUSES_SQL}
             AND (o.updated_at > ? OR (o.updated_at = ? AND o.id > ?))
           ORDER BY o.updated_at, o.id LIMIT ?`,
        )
        .bind(storeId, cursor.updatedAt, cursor.updatedAt, cursor.id, limit)
        .all<TicketRow>()
    : await db
        .prepare(
          `SELECT ${TICKET_COLUMNS_SQL} FROM orders o JOIN tables t ON t.id = o.table_id AND t.store_id = o.store_id
           WHERE o.store_id = ? AND o.status IN ${ACTIVE_STATUSES_SQL}
           ORDER BY o.updated_at, o.id LIMIT ?`,
        )
        .bind(storeId, limit)
        .all<TicketRow>();

  const items = new Map<string, KitchenTicket['items']>();
  const orderIds = rows.results.map((row) => row.id);
  // D1 allows at most 100 bound parameters per statement.
  for (let start = 0; start < orderIds.length; start += MAX_IDS_PER_QUERY) {
    const chunk = orderIds.slice(start, start + MAX_IDS_PER_QUERY);
    const placeholders = chunk.map(() => '?').join(', ');
    const { results } = await db
      .prepare(
        `SELECT order_id, product_name_snapshot, quantity, notes FROM order_items
         WHERE store_id = ? AND order_id IN (${placeholders}) ORDER BY order_id, position`,
      )
      .bind(storeId, ...chunk)
      .all<{ order_id: string; product_name_snapshot: string; quantity: number; notes: string }>();
    for (const line of results) {
      const list = items.get(line.order_id) ?? [];
      list.push({ productName: line.product_name_snapshot, quantity: line.quantity, notes: line.notes });
      items.set(line.order_id, list);
    }
  }

  const orders = rows.results.map((row) => ({
    id: row.id,
    orderCode: row.order_code,
    tableNumber: row.table_number,
    status: row.status,
    totalAmountMinor: row.total_amount_minor,
    needsAttention: row.needs_attention === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    items: items.get(row.id) ?? [],
  }));
  const last = orders.at(-1);
  const nextCursor = last ? { updatedAt: last.updatedAt, id: last.id } : cursor;
  return { orders, cursor: nextCursor, etag: `"${(await sha256Hex(JSON.stringify([nextCursor, orders.length]))).slice(0, 32)}"` };
}
