import { useState } from 'react';
import QRCode from 'qrcode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { PaymentScreen } from '../../apps/storefront/src/payment-screen.tsx';
import { TrackingScreen } from '../../apps/storefront/src/tracking-screen.tsx';
import type { OrderView } from '../../apps/storefront/src/types.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const ORDER_TOKEN = 'd'.repeat(43);
const PAYLOAD = '00020101021126APIVIETQRSAMPLEPAYLOAD5303704540510005802VN6304ABCD';

function pendingOrder(overrides: Partial<OrderView> = {}): OrderView {
  return {
    orderCode: 'ORD-1',
    status: 'pending_payment',
    tableNumber: 3,
    currency: 'VND',
    totalAmountMinor: 45000,
    paymentReference: 'QM00000001',
    createdAt: new Date().toISOString(),
    items: [],
    vietqrPayload: PAYLOAD,
    ...overrides,
  };
}

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('PaymentScreen', () => {
  it('T7: renders the QR from the exact server payload, never a client-built one', async () => {
    const toDataURL = vi.spyOn(QRCode, 'toDataURL');
    await render(<PaymentScreen orderToken={ORDER_TOKEN} order={pendingOrder()} onPaid={vi.fn()} onExpiredOrCancelled={vi.fn()} />);

    await vi.waitFor(() => expect(toDataURL).toHaveBeenCalled());
    expect(toDataURL.mock.calls[0][0]).toBe(PAYLOAD);
  });

  it('T8: switches to the tracking screen (with the Secret Link) once polling reports paid, and drops the QR', async () => {
    vi.useFakeTimers();
    const order = pendingOrder();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(order))
      .mockResolvedValueOnce(jsonResponse({ ...order, status: 'paid' }));

    function Harness() {
      const [current, setCurrent] = useState<OrderView>(order);
      const [paid, setPaid] = useState(false);
      return paid ? (
        <TrackingScreen orderToken={ORDER_TOKEN} order={current} />
      ) : (
        <PaymentScreen
          orderToken={ORDER_TOKEN}
          order={current}
          onPaid={(next) => {
            setCurrent(next);
            setPaid(true);
          }}
          onExpiredOrCancelled={vi.fn()}
        />
      );
    }

    const screen = await render(<Harness />);
    await expect.element(screen.getByRole('img')).toBeVisible();

    await vi.advanceTimersByTimeAsync(3000);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(3000);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));

    await vi.waitFor(() => expect(screen.getByRole('img').elements().length).toBe(0));
    await expect.element(screen.getByText(`/o#${ORDER_TOKEN}`)).toBeInTheDocument();
  });

  it('T9: treats an order older than 30 minutes as cancelled, without ever showing a QR or creating a new order', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const order = pendingOrder({ createdAt: new Date(Date.now() - 31 * 60 * 1000).toISOString() });

    const screen = await render(<PaymentScreen orderToken={ORDER_TOKEN} order={order} onPaid={vi.fn()} onExpiredOrCancelled={vi.fn()} />);

    await expect.element(screen.getByText('Đơn đã huỷ, vui lòng đặt lại.')).toBeInTheDocument();
    expect(screen.getByRole('img').elements().length).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
