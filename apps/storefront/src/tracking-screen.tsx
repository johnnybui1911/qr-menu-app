import { useEffect, useRef, useState } from 'react';
import { request } from './api-client.ts';
import type { OrderStatus, OrderView } from './types.ts';

const POLL_INTERVAL_MS = 3000;
const STEPS: { status: OrderStatus; label: string }[] = [
  { status: 'paid', label: 'Đã thanh toán' },
  { status: 'preparing', label: 'Đang chuẩn bị' },
  { status: 'fulfilled', label: 'Đã giao món' },
];
const TERMINAL_STATUSES: OrderStatus[] = ['fulfilled', 'refunded', 'cancelled'];

export type TrackingScreenProps = { orderToken: string; order: OrderView };

export function TrackingScreen({ orderToken, order: initialOrder }: TrackingScreenProps) {
  const [order, setOrder] = useState(initialOrder);
  const orderRef = useRef(order);
  orderRef.current = order;

  useEffect(() => {
    if (TERMINAL_STATUSES.includes(initialOrder.status)) return;
    const pollId = setInterval(async () => {
      if (TERMINAL_STATUSES.includes(orderRef.current.status)) {
        clearInterval(pollId);
        return;
      }
      const result = await request<OrderView>({ path: '/api/storefront/orders/current', orderToken });
      if (result.ok) setOrder(result.data);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(pollId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const currentStepIndex = STEPS.findIndex((step) => step.status === order.status);

  return (
    <section aria-label="Theo dõi đơn" className="tracking-screen">
      <p className="order-code">Đơn {order.orderCode}</p>
      {order.status === 'refunded' && <p role="status">Đơn đã được hoàn tiền.</p>}
      {order.status === 'cancelled' && <p role="status">Đơn đã huỷ.</p>}
      {order.status !== 'refunded' && order.status !== 'cancelled' && (
        <ol className="tracking-steps">
          {STEPS.map((step, index) => (
            <li
              key={step.status}
              aria-current={step.status === order.status ? 'step' : undefined}
              className={index <= currentStepIndex ? 'tracking-step done' : 'tracking-step'}
            >
              {step.label}
            </li>
          ))}
        </ol>
      )}
      <p className="secret-link-note">
        Lưu đường dẫn này để tra cứu đơn sau này: <code>{`${location.origin}/o#${orderToken}`}</code>
      </p>
    </section>
  );
}
