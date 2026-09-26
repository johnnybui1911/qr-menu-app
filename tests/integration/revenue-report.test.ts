import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { summarizeDailyRevenue } from '@qr/orders/revenue-report';
import { resetDb } from '../support/test-env.ts';
import { TEST_STORE, insertOrder, insertTable } from '../support/seed.ts';

beforeEach(async () => {
  await resetDb();
  await insertTable();
});

describe('summarizeDailyRevenue', () => {
  it('counts only collected orders of the ICT day and reports refunds separately', async () => {
    // 2026-09-26 in ICT (UTC+7) spans 2026-09-25T17:00Z .. 2026-09-26T17:00Z.
    const inDay = '2026-09-26T03:00:00.000Z';
    const seeds: [string, number, string, string][] = [
      ['paid', 10000, 'QM00000001', inDay],
      ['preparing', 20000, 'QM00000002', inDay],
      ['fulfilled', 30000, 'QM00000003', '2026-09-25T17:30:00.000Z'],
      ['refunded', 40000, 'QM00000004', inDay],
      ['pending_payment', 50000, 'QM00000005', inDay],
      ['cancelled', 60000, 'QM00000006', inDay],
      ['paid', 70000, 'QM00000007', '2026-09-26T17:30:00.000Z'],
    ];
    for (const [i, [status, totalMinor, paymentReference, createdAt]] of seeds.entries()) {
      await insertOrder(`order-${i}`, { status, totalMinor, paymentReference, createdAt, orderCode: `CODE0${i}` });
    }
    expect(await summarizeDailyRevenue(env.DB, TEST_STORE, '2026-09-26')).toEqual({
      date: '2026-09-26',
      paidOrderCount: 3,
      revenueMinor: 60000,
      refundedOrderCount: 1,
      refundedMinor: 40000,
    });
  });

  it('rejects a malformed date', async () => {
    await expect(summarizeDailyRevenue(env.DB, TEST_STORE, '2026-9-26')).rejects.toThrow(/date/);
  });
});
