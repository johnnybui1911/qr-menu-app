import { describe, expect, it } from 'vitest';
import { payloadHash } from '@qr/orders/command-ledger';

describe('payloadHash', () => {
  const base = { action: 'order:prepare', orderId: 'order-1', actorUserId: 'user-1', body: { reason: 'x', nested: { b: 1, a: 2 } } };

  it('is stable and independent of key order', async () => {
    const reordered = { ...base, body: { nested: { a: 2, b: 1 }, reason: 'x' } };
    expect(await payloadHash(base)).toBe(await payloadHash(reordered));
    expect(await payloadHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([{ action: 'order:fulfill' }, { orderId: 'order-2' }, { actorUserId: 'user-2' }, { body: { reason: 'y', nested: { a: 2, b: 1 } } }])(
    'changes when %j changes',
    async (change) => {
      expect(await payloadHash({ ...base, ...change })).not.toBe(await payloadHash(base));
    },
  );
});
