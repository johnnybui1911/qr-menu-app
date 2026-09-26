import { describe, expect, it } from 'vitest';
import { nextAvailableAt } from '@qr/orders/email-outbox';

describe('nextAvailableAt', () => {
  it('doubles from 5 minutes and caps at one hour', () => {
    const now = new Date('2026-09-26T00:00:00.000Z');
    const minutes = Array.from({ length: 10 }, (_, i) => (Date.parse(nextAvailableAt(i + 1, now)) - now.getTime()) / 60_000);
    expect(minutes).toEqual([5, 10, 20, 40, 60, 60, 60, 60, 60, 60]);
  });
});
