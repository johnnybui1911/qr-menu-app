import { describe, expect, it } from 'vitest';
import {
  cancelEligible,
  fulfillEligible,
  markPaidEligible,
  refundEligible,
  startPreparingEligible,
} from '@qr/orders/transitions/order-transitions';

const STATUSES = ['pending_payment', 'paid', 'preparing', 'fulfilled', 'cancelled', 'refunded'] as const;
const ALLOWED_FROM: Record<string, [(status: string) => boolean, string[]]> = {
  markPaid: [markPaidEligible, ['pending_payment']],
  startPreparing: [startPreparingEligible, ['paid']],
  fulfill: [fulfillEligible, ['preparing']],
  cancel: [cancelEligible, ['pending_payment']],
  refund: [refundEligible, ['paid', 'preparing', 'fulfilled']],
};

describe('order transition guards (D9)', () => {
  it.each(Object.keys(ALLOWED_FROM))('%s is allowed only from its source states', (name) => {
    const [guard, allowed] = ALLOWED_FROM[name];
    for (const status of STATUSES) expect(guard(status)).toBe(allowed.includes(status));
  });
});
