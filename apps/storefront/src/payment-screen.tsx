import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { request } from './api-client.ts';
import { formatVnd } from './format-money.ts';
import type { OrderView } from './types.ts';

const POLL_INTERVAL_MS = 3000;
const COUNTDOWN_TICK_MS = 1000;
const PAYMENT_WINDOW_MS = 30 * 60 * 1000;

export type PaymentScreenProps = {
  orderToken: string;
  order: OrderView;
  onPaid: (order: OrderView) => void;
  onExpiredOrCancelled: () => void;
};

function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function PaymentScreen({ orderToken, order, onPaid, onExpiredOrCancelled }: PaymentScreenProps) {
  const deadlineMs = new Date(order.createdAt).getTime() + PAYMENT_WINDOW_MS;
  const [expired, setExpired] = useState(order.status === 'cancelled' || deadlineMs - Date.now() <= 0);
  const [remainingMs, setRemainingMs] = useState(deadlineMs - Date.now());
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  useEffect(() => {
    if (expired || !order.vietqrPayload) return;
    let cancelled = false;
    QRCode.toDataURL(order.vietqrPayload).then((dataUrl) => {
      if (!cancelled) setQrDataUrl(dataUrl);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (expired) return;
    const countdownId = setInterval(() => {
      const left = deadlineMs - Date.now();
      setRemainingMs(left);
      if (left <= 0) {
        setExpired(true);
        onExpiredOrCancelled();
      }
    }, COUNTDOWN_TICK_MS);
    return () => clearInterval(countdownId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (expired) return;
    const pollId = setInterval(async () => {
      const result = await request<OrderView>({ path: '/api/storefront/orders/current', orderToken });
      if (!result.ok) return;
      if (result.data.status === 'paid') {
        onPaid(result.data);
      } else if (result.data.status === 'cancelled') {
        setExpired(true);
        onExpiredOrCancelled();
      }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(pollId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (expired) {
    return (
      <section aria-label="Thanh toán" className="payment-expired">
        <p role="alert">Đơn đã huỷ, vui lòng đặt lại.</p>
      </section>
    );
  }

  return (
    <section aria-label="Thanh toán" className="payment-screen">
      <p className="payment-amount">{formatVnd(order.totalAmountMinor)}</p>
      <p className="payment-reference">Mã tham chiếu: {order.paymentReference}</p>
      {qrDataUrl && <img src={qrDataUrl} alt="Mã QR VietQR để thanh toán" width={240} height={240} />}
      <p className="payment-countdown" role="timer">
        Hết hạn sau {formatCountdown(remainingMs)}
      </p>
      <p className="secret-link-note">
        Lưu đường dẫn này để tra cứu đơn sau này: <code>{`${location.origin}/o#${orderToken}`}</code>
      </p>
    </section>
  );
}
