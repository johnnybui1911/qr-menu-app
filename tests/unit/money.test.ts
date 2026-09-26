import { describe, expect, it } from 'vitest';
import { MoneyError, currencyFractionDigits, decimalToMinor, minorToDecimal } from '@qr/catalog/money';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof MoneyError) return error.code;
    throw error;
  }
  return 'no_error';
};

describe('money (C4)', () => {
  it('uses zero fraction digits for VND and two for USD', () => {
    expect(currencyFractionDigits('VND')).toBe(0);
    expect(currencyFractionDigits('USD')).toBe(2);
  });

  it('rejects VND fractions instead of rounding', () => {
    expect(code(() => decimalToMinor('45000.50', 'VND'))).toBe('money_over_precision');
    expect(code(() => decimalToMinor('45000.0', 'VND'))).toBe('money_over_precision');
  });

  it('round-trips whole VND amounts', () => {
    expect(decimalToMinor('45000', 'VND')).toBe(45000);
    expect(minorToDecimal(decimalToMinor('45000', 'VND'), 'VND')).toBe('45000');
    expect(decimalToMinor('24.50', 'USD')).toBe(2450);
    expect(minorToDecimal(2405, 'USD')).toBe('24.05');
  });

  it('rejects amounts above the safe integer ceiling without overflowing', () => {
    expect(code(() => decimalToMinor('99999999999999999', 'VND'))).toBe('money_out_of_range');
    expect(decimalToMinor(String(Number.MAX_SAFE_INTEGER), 'VND')).toBe(Number.MAX_SAFE_INTEGER);
    expect(code(() => minorToDecimal(Number.MAX_SAFE_INTEGER + 1, 'VND'))).toBe('money_out_of_range');
  });

  it.each(['-1', '1e3', ' 100', '100 ', '01', '1.', '.5', '', '4,5'])('rejects malformed input %j', (value) => {
    expect(code(() => decimalToMinor(value, 'VND'))).toBe('money_malformed');
  });

  it('rejects non-integer or negative minor values', () => {
    expect(code(() => minorToDecimal(1.5, 'VND'))).toBe('money_out_of_range');
    expect(code(() => minorToDecimal(-1, 'VND'))).toBe('money_out_of_range');
  });
});
