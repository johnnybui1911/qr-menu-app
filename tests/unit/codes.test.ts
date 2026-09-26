import { describe, expect, it } from 'vitest';
import { PAYMENT_REFERENCE_PATTERN, generateOrderCode, generatePaymentReference } from '@qr/orders/codes';

describe('payment_reference (D18, C8)', () => {
  it('generates QM + 8 base36 characters that the matching pattern recognises', () => {
    const references = Array.from({ length: 200 }, generatePaymentReference);
    for (const reference of references) {
      expect(reference).toMatch(/^QM[0-9A-Z]{8}$/);
      expect(reference.match(PAYMENT_REFERENCE_PATTERN)?.[0]).toBe(reference);
    }
    const seen = new Set(references.flatMap((r) => [...r.slice(2)]));
    expect(seen.size).toBe(36);
  });

  it('finds a generated reference inside bank transfer noise', () => {
    const reference = generatePaymentReference();
    const content = `MBVCB.123456.${reference} chuyen tien.CT tu 0123456789 NGUYEN VAN A`;
    expect(content.match(PAYMENT_REFERENCE_PATTERN)?.[0]).toBe(reference);
  });
});

describe('order_code', () => {
  it('is 6 base36 characters and never mistaken for a payment reference', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateOrderCode();
      expect(code).toMatch(/^[0-9A-Z]{6}$/);
      expect(PAYMENT_REFERENCE_PATTERN.test(code)).toBe(false);
    }
  });
});
