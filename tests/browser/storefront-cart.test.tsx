import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { Cart } from '../../apps/storefront/src/cart.tsx';
import { readCart, writeCart } from '../../apps/storefront/src/cart-storage.ts';
import type { CartLine, OrderView } from '../../apps/storefront/src/types.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const ORDER_VIEW: OrderView = {
  orderCode: 'ORD-1',
  status: 'pending_payment',
  tableNumber: 7,
  currency: 'VND',
  totalAmountMinor: 10000,
  paymentReference: 'QM12345678',
  createdAt: new Date().toISOString(),
  items: [{ productName: 'Trà đá', quantity: 2, unitPriceMinor: 5000, lineTotalMinor: 10000, notes: null }],
  vietqrPayload: '000201...',
};

const TABLE_TOKEN = 'b'.repeat(43);

function makeCart(): CartLine[] {
  return [{ productId: 'p1', name: 'Trà đá', priceMinor: 5000, quantity: 2, notes: 'ít đá' }];
}

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Cart', () => {
  it('T4: sends only productId/quantity/notes in the order body — never price or total', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(ORDER_VIEW, 201));
    const onOrderPlaced = vi.fn();

    const screen = await render(
      <Cart tableToken={TABLE_TOKEN} cart={makeCart()} onQuantityChange={vi.fn()} onNotesChange={vi.fn()} onRemove={vi.fn()} onOrderPlaced={onOrderPlaced} />,
    );

    await screen.getByRole('button', { name: /đặt đơn/i }).click();
    await vi.waitFor(() => expect(onOrderPlaced).toHaveBeenCalled());

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ items: [{ productId: 'p1', quantity: 2, notes: 'ít đá' }] });
  });

  it('T5: keeps the same Idempotency-Key across a network retry, and mints a new one for the next order', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('network down'))
      .mockResolvedValueOnce(jsonResponse(ORDER_VIEW, 201))
      .mockResolvedValueOnce(jsonResponse({ ...ORDER_VIEW, orderCode: 'ORD-2' }, 201));
    const onOrderPlaced = vi.fn();

    const screen = await render(
      <Cart tableToken={TABLE_TOKEN} cart={makeCart()} onQuantityChange={vi.fn()} onNotesChange={vi.fn()} onRemove={vi.fn()} onOrderPlaced={onOrderPlaced} />,
    );

    await screen.getByRole('button', { name: /đặt đơn/i }).click();
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(onOrderPlaced).toHaveBeenCalledTimes(1));

    const key1 = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers).get('idempotency-key');
    const key2 = new Headers((fetchSpy.mock.calls[1][1] as RequestInit).headers).get('idempotency-key');
    expect(key2).toBe(key1);

    await screen.rerender(
      <Cart
        tableToken={TABLE_TOKEN}
        cart={[{ productId: 'p2', name: 'Cà phê sữa', priceMinor: 20000, quantity: 1, notes: '' }]}
        onQuantityChange={vi.fn()}
        onNotesChange={vi.fn()}
        onRemove={vi.fn()}
        onOrderPlaced={onOrderPlaced}
      />,
    );
    await screen.getByRole('button', { name: /đặt đơn/i }).click();
    await vi.waitFor(() => expect(onOrderPlaced).toHaveBeenCalledTimes(2));

    const key3 = new Headers((fetchSpy.mock.calls[2][1] as RequestInit).headers).get('idempotency-key');
    expect(key3).not.toBe(key1);
  });

  it('T6: a cart saved for one table is never read back for a different table', async () => {
    const tokenA = 'a'.repeat(43);
    const tokenB = 'c'.repeat(43);
    await writeCart(tokenA, makeCart());

    expect(await readCart(tokenA)).toEqual(makeCart());
    expect(await readCart(tokenB)).toEqual([]);
  });
});
