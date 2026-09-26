import { describe, expect, it } from 'vitest';
import { parseOrderRequest } from '@qr/orders/order-validation';

describe('parseOrderRequest (D11.1)', () => {
  it('rejects a client-supplied item price', () => {
    expect(parseOrderRequest({ items: [{ productId: 'p1', quantity: 1, price: 1 }] })).toEqual({
      ok: false,
      code: 'unknown_field',
      field: 'items[0].price',
    });
  });

  it('rejects a client-supplied order total', () => {
    expect(parseOrderRequest({ items: [{ productId: 'p1', quantity: 1 }], total: 1 })).toEqual({
      ok: false,
      code: 'unknown_field',
      field: 'total',
    });
  });

  it('accepts productId, quantity and notes and defaults notes to empty', () => {
    expect(parseOrderRequest({ items: [{ productId: 'p1', quantity: 2, notes: 'ít đá' }, { productId: 'p2', quantity: 1 }] })).toEqual({
      ok: true,
      items: [
        { productId: 'p1', quantity: 2, notes: 'ít đá' },
        { productId: 'p2', quantity: 1, notes: '' },
      ],
    });
  });

  it.each([
    [null, 'body'],
    [{ items: [] }, 'items'],
    [{ items: 'x' }, 'items'],
    [{ items: [{ productId: '', quantity: 1 }] }, 'items[0].productId'],
    [{ items: [{ productId: 'p1', quantity: 0 }] }, 'items[0].quantity'],
    [{ items: [{ productId: 'p1', quantity: 100 }] }, 'items[0].quantity'],
    [{ items: [{ productId: 'p1', quantity: 1.5 }] }, 'items[0].quantity'],
    [{ items: [{ productId: 'p1', quantity: 1, notes: 'x'.repeat(501) }] }, 'items[0].notes'],
    [{ items: Array.from({ length: 51 }, () => ({ productId: 'p1', quantity: 1 })) }, 'items'],
  ])('rejects invalid input %j at %s', (body, field) => {
    expect(parseOrderRequest(body)).toEqual({ ok: false, code: 'invalid_field', field });
  });
});
