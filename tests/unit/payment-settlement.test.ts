import { describe, expect, it } from 'vitest';
import { generatePaymentReference } from '@qr/orders/codes';
import { matchPaymentReference } from '@qr/orders/commands/payment-settlement';

describe('matchPaymentReference (D18)', () => {
  it('finds every generated reference inside real-world bank transfer noise', () => {
    for (let i = 0; i < 200; i++) {
      const reference = generatePaymentReference();
      const content = `NGUYEN VAN A chuyen tien  Ma giao dich  ${reference} Trace773231`;
      expect(matchPaymentReference(content)).toEqual({ reference });
      expect(matchPaymentReference(content.toLowerCase())).toEqual({ reference });
    }
  });

  it('refuses to guess when content carries two different references', () => {
    const content = `${generatePaymentReference()} va ${generatePaymentReference()}`;
    expect(matchPaymentReference(content)).toEqual({ reference: null, reason: 'ambiguous' });
  });

  it('accepts the same reference repeated and reports none when absent', () => {
    const reference = generatePaymentReference();
    expect(matchPaymentReference(`${reference} ${reference}`)).toEqual({ reference });
    expect(matchPaymentReference('chuyen tien an trua')).toEqual({ reference: null, reason: 'none' });
  });
});
