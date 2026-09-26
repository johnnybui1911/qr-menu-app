import { useEffect, useMemo, useRef, useState } from 'react';
import { apiGet, apiSend, type ConsoleSession } from './api-client.ts';
import { formatVnd } from './format-money.ts';

type OrderStatus = 'pending_payment' | 'paid' | 'preparing' | 'fulfilled' | 'cancelled' | 'refunded';

type KitchenOrderItem = { productName: string; quantity: number; notes: string | null };

type KitchenOrder = {
  id: string;
  orderCode: string;
  tableNumber: string;
  status: OrderStatus;
  totalAmountMinor: number;
  needsAttention: boolean;
  createdAt: string;
  updatedAt: string;
  items: KitchenOrderItem[];
};

type ProviderEvent = { id: string; source: string; verified: boolean; outcome: string; createdAt: string };

const POLL_INTERVAL_MS = 3000;
// The kitchen board only ever displays tickets a cook still has to act on; anything else (fulfilled, cancelled,
// refunded, still-unpaid) is a delta telling the board to drop that id, never to render it.
const ACTIVE_STATUSES: Partial<Record<OrderStatus, true>> = { paid: true, preparing: true };

function mergeOrders(previous: Map<string, KitchenOrder>, incoming: KitchenOrder[]): Map<string, KitchenOrder> {
  const next = new Map(previous);
  for (const incomingOrder of incoming) {
    if (ACTIVE_STATUSES[incomingOrder.status]) next.set(incomingOrder.id, incomingOrder);
    else next.delete(incomingOrder.id);
  }
  return next;
}

function groupByTable(orders: Map<string, KitchenOrder>): [string, KitchenOrder[]][] {
  const byTable = new Map<string, KitchenOrder[]>();
  for (const kitchenOrder of orders.values()) {
    const existing = byTable.get(kitchenOrder.tableNumber);
    if (existing) existing.push(kitchenOrder);
    else byTable.set(kitchenOrder.tableNumber, [kitchenOrder]);
  }
  return [...byTable.entries()].sort(([left], [right]) => left.localeCompare(right, 'vi', { numeric: true }));
}

export function KitchenBoard({ session }: { session: ConsoleSession }) {
  const [orders, setOrders] = useState<Map<string, KitchenOrder>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [busyOrderIds, setBusyOrderIds] = useState<Set<string>>(new Set());
  const [refundDrafts, setRefundDrafts] = useState<Record<string, string>>({});
  const [eventsByOrder, setEventsByOrder] = useState<Record<string, ProviderEvent[] | 'loading'>>({});
  const cursorRef = useRef<string | null>(null);
  const etagRef = useRef<string | null>(null);
  const commandKeys = useRef(new Map<string, string>());

  const canPrepare = session.allowedActions.includes('order:prepare');
  const canFulfill = session.allowedActions.includes('order:fulfill');
  const canRequestRefund = session.allowedActions.includes('refund:request');
  const canSeeEvents = session.allowedActions.includes('report:read');

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      const query = cursorRef.current ? `?since=${encodeURIComponent(cursorRef.current)}` : '';
      const headers: Record<string, string> = {};
      if (etagRef.current) headers['if-none-match'] = etagRef.current;
      const result = await apiGet<{ orders: KitchenOrder[]; since: string | null }>(`/api/console/orders${query}`, { headers });
      if (cancelled || result.status === 304) return;
      if (result.status !== 200 || result.data === null || !('orders' in result.data)) {
        setError('Không tải được danh sách đơn, đang thử lại.');
        return;
      }
      cursorRef.current = result.data.since;
      etagRef.current = result.headers.get('etag');
      setError(null);
      setOrders((previous) => mergeOrders(previous, result.data && 'orders' in result.data ? result.data.orders : []));
    }

    poll();
    const timer = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const grouped = useMemo(() => groupByTable(orders), [orders]);

  async function runCommand(orderId: string, action: 'prepare' | 'fulfill') {
    const commandKey = `${orderId}:${action}`;
    const idempotencyKey = commandKeys.current.get(commandKey) ?? crypto.randomUUID();
    commandKeys.current.set(commandKey, idempotencyKey);
    setBusyOrderIds((previous) => new Set(previous).add(orderId));
    const result = await apiSend(`/api/console/orders/${orderId}/${action}`, 'POST', undefined, { idempotencyKey });
    setBusyOrderIds((previous) => {
      const next = new Set(previous);
      next.delete(orderId);
      return next;
    });
    if (result.status !== 200) {
      setError('Không thực hiện được thao tác, vui lòng thử lại.');
      return;
    }
    commandKeys.current.delete(commandKey);
    setOrders((previous) => {
      const next = new Map(previous);
      if (action === 'fulfill') {
        next.delete(orderId);
        return next;
      }
      const existing = next.get(orderId);
      if (existing) next.set(orderId, { ...existing, status: 'preparing' });
      return next;
    });
  }

  async function submitRefundRequest(orderId: string) {
    const reason = (refundDrafts[orderId] ?? '').trim();
    if (reason.length === 0) return;
    const commandKey = `${orderId}:refund-request`;
    const idempotencyKey = commandKeys.current.get(commandKey) ?? crypto.randomUUID();
    commandKeys.current.set(commandKey, idempotencyKey);
    const result = await apiSend(`/api/console/orders/${orderId}/refund-requests`, 'POST', { reason }, { idempotencyKey });
    if (result.status !== 201) {
      setError('Không gửi được yêu cầu hoàn tiền.');
      return;
    }
    commandKeys.current.delete(commandKey);
    setRefundDrafts((previous) => {
      const next = { ...previous };
      delete next[orderId];
      return next;
    });
  }

  async function toggleProviderEvents(orderId: string) {
    if (eventsByOrder[orderId] !== undefined) {
      setEventsByOrder((previous) => {
        const next = { ...previous };
        delete next[orderId];
        return next;
      });
      return;
    }
    setEventsByOrder((previous) => ({ ...previous, [orderId]: 'loading' }));
    const result = await apiGet<{ events: ProviderEvent[] }>(`/api/console/provider-events?orderId=${orderId}`);
    setEventsByOrder((previous) => ({ ...previous, [orderId]: result.status === 200 && result.data && 'events' in result.data ? result.data.events : [] }));
  }

  return (
    <section className="console-screen kitchen-board" aria-label="Màn bếp">
      <h1>Bếp</h1>
      {error && (
        <p className="console-error" role="alert">
          {error}
        </p>
      )}
      {grouped.length === 0 && <p>Chưa có đơn nào đang chờ.</p>}
      {grouped.map(([tableNumber, tableOrders]) => (
        <div key={tableNumber} className="kitchen-table-group">
          <h2>Bàn {tableNumber}</h2>
          <ul className="kitchen-ticket-list">
            {tableOrders.map((kitchenOrder) => (
              <li key={kitchenOrder.id} data-testid={`ticket-${kitchenOrder.id}`} className="kitchen-ticket" data-status={kitchenOrder.status}>
                <div className="kitchen-ticket-header">
                  <strong>{kitchenOrder.orderCode}</strong>
                  {kitchenOrder.needsAttention && <span className="badge badge-attention">Cần chú ý</span>}
                </div>
                <ul className="kitchen-ticket-items">
                  {kitchenOrder.items.map((item, index) => (
                    <li key={index}>
                      {item.quantity}× {item.productName}
                      {item.notes && <span className="kitchen-ticket-note"> — {item.notes}</span>}
                    </li>
                  ))}
                </ul>
                <p className="kitchen-ticket-total">{formatVnd(kitchenOrder.totalAmountMinor)}</p>
                <div className="kitchen-ticket-actions">
                  {kitchenOrder.status === 'paid' && canPrepare && (
                    <button type="button" disabled={busyOrderIds.has(kitchenOrder.id)} onClick={() => runCommand(kitchenOrder.id, 'prepare')}>
                      Nhận đơn & Chế biến
                    </button>
                  )}
                  {kitchenOrder.status === 'preparing' && canFulfill && (
                    <button type="button" disabled={busyOrderIds.has(kitchenOrder.id)} onClick={() => runCommand(kitchenOrder.id, 'fulfill')}>
                      Giao món
                    </button>
                  )}
                  {kitchenOrder.needsAttention && canSeeEvents && (
                    <button type="button" onClick={() => toggleProviderEvents(kitchenOrder.id)}>
                      Xem giao dịch
                    </button>
                  )}
                </div>
                {canRequestRefund && (
                  <div className="kitchen-refund-request">
                    <label htmlFor={`refund-reason-${kitchenOrder.id}`}>Lý do hoàn tiền</label>
                    <textarea
                      id={`refund-reason-${kitchenOrder.id}`}
                      value={refundDrafts[kitchenOrder.id] ?? ''}
                      onChange={(event) => setRefundDrafts((previous) => ({ ...previous, [kitchenOrder.id]: event.target.value }))}
                    />
                    <button type="button" disabled={(refundDrafts[kitchenOrder.id] ?? '').trim().length === 0} onClick={() => submitRefundRequest(kitchenOrder.id)}>
                      Yêu cầu hoàn tiền
                    </button>
                  </div>
                )}
                {eventsByOrder[kitchenOrder.id] !== undefined && (
                  <div className="kitchen-provider-events">
                    {eventsByOrder[kitchenOrder.id] === 'loading' ? (
                      <p>Đang tải giao dịch…</p>
                    ) : (
                      <ul>
                        {(eventsByOrder[kitchenOrder.id] as ProviderEvent[]).map((event) => (
                          <li key={event.id}>
                            {event.source} — {event.outcome}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
