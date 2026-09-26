import { useRef, useState } from 'react';
import { NetworkError, request } from './api-client.ts';
import { formatVnd } from './format-money.ts';
import { createOrderAttempt, type OrderAttempt } from './order-attempt.ts';
import type { CartLine, OrderView } from './types.ts';

// Backoff between automatic retries of the same (Idempotency-Key, order token) pair — 3 retries, 1s/2s/4s
// (decision #5). After that we stop and show a manual retry button that still keeps the same pair.
const RETRY_DELAYS_MS = [1000, 2000, 4000];

type SubmitStatus =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'retrying'; attempt: number }
  | { kind: 'unavailable'; productIds: Set<string> }
  | { kind: 'error'; message: string };

export type CartProps = {
  tableToken: string;
  cart: CartLine[];
  onQuantityChange: (productId: string, quantity: number) => void;
  onNotesChange: (productId: string, notes: string) => void;
  onRemove: (productId: string) => void;
  onOrderPlaced: (order: OrderView, orderToken: string) => void;
};

export function Cart({ tableToken, cart, onQuantityChange, onNotesChange, onRemove, onOrderPlaced }: CartProps) {
  const [status, setStatus] = useState<SubmitStatus>({ kind: 'idle' });
  const attemptRef = useRef<OrderAttempt | null>(null);

  const estimateMinor = cart.reduce((sum, line) => sum + line.priceMinor * line.quantity, 0);

  async function submit() {
    if (cart.length === 0) return;
    const attempt = attemptRef.current ?? (attemptRef.current = createOrderAttempt());
    setStatus({ kind: 'submitting' });

    for (let attemptNumber = 0; attemptNumber <= RETRY_DELAYS_MS.length; attemptNumber++) {
      try {
        const result = await request<OrderView>({
          method: 'POST',
          path: '/api/storefront/orders',
          tableToken,
          orderToken: attempt.orderToken,
          idempotencyKey: attempt.idempotencyKey,
          body: { items: cart.map((line) => ({ productId: line.productId, quantity: line.quantity, notes: line.notes })) },
        });

        if (result.ok) {
          attemptRef.current = null;
          setStatus({ kind: 'idle' });
          onOrderPlaced(result.data, attempt.orderToken);
          return;
        }
        if (result.code === 'items_unavailable') {
          setStatus({ kind: 'unavailable', productIds: new Set((result.items ?? []).map((item) => item.productId)) });
          return;
        }
        // A key/token collision means this pair cannot be trusted for a replay; abandon it and let the user retry fresh.
        if (result.code === 'idempotency_conflict' || result.code === 'order_token_in_use') attemptRef.current = null;
        setStatus({ kind: 'error', message: 'Có lỗi xảy ra, vui lòng thử lại.' });
        return;
      } catch (error) {
        const isLastAttempt = attemptNumber === RETRY_DELAYS_MS.length;
        if (!(error instanceof NetworkError) || isLastAttempt) {
          setStatus({ kind: 'error', message: 'Mất kết nối, vui lòng thử lại.' });
          return;
        }
        setStatus({ kind: 'retrying', attempt: attemptNumber + 1 });
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, RETRY_DELAYS_MS[attemptNumber]);
        await promise;
      }
    }
  }

  const busy = status.kind === 'submitting' || status.kind === 'retrying';

  return (
    <section aria-label="Giỏ hàng" className="cart">
      <h2>Giỏ hàng</h2>
      {cart.length === 0 ? (
        <p>Giỏ hàng trống</p>
      ) : (
        <ul className="cart-list">
          {cart.map((line) => {
            const unavailable = status.kind === 'unavailable' && status.productIds.has(line.productId);
            return (
              <li key={line.productId} className={unavailable ? 'cart-line cart-line-unavailable' : 'cart-line'}>
                <span className="cart-line-name">{line.name}</span>
                {unavailable && <span className="cart-line-error">Món này vừa hết, vui lòng bỏ khỏi giỏ</span>}
                <div className="cart-line-controls">
                  <button
                    type="button"
                    aria-label={`Giảm số lượng ${line.name}`}
                    disabled={line.quantity <= 1}
                    onClick={() => onQuantityChange(line.productId, line.quantity - 1)}
                  >
                    −
                  </button>
                  <span aria-label={`Số lượng ${line.name}`}>{line.quantity}</span>
                  <button
                    type="button"
                    aria-label={`Tăng số lượng ${line.name}`}
                    disabled={line.quantity >= 99}
                    onClick={() => onQuantityChange(line.productId, line.quantity + 1)}
                  >
                    +
                  </button>
                  <button type="button" onClick={() => onRemove(line.productId)}>
                    Xoá
                  </button>
                </div>
                <label>
                  Ghi chú
                  <input type="text" value={line.notes} maxLength={500} onChange={(event) => onNotesChange(line.productId, event.target.value)} />
                </label>
                <span className="cart-line-price">{formatVnd(line.priceMinor * line.quantity)}</span>
              </li>
            );
          })}
        </ul>
      )}
      <p className="cart-total">Tạm tính (ước tính): {formatVnd(estimateMinor)}</p>
      {status.kind === 'error' && <p role="alert">{status.message}</p>}
      {status.kind === 'unavailable' && <p role="alert">Một số món trong giỏ đã hết, vui lòng điều chỉnh trước khi đặt lại.</p>}
      {status.kind === 'retrying' && <p role="status">Đang thử kết nối lại… (lần {status.attempt})</p>}
      <button type="button" disabled={cart.length === 0 || busy} onClick={submit}>
        {status.kind === 'error' ? 'Thử lại' : 'Đặt đơn'}
      </button>
    </section>
  );
}
