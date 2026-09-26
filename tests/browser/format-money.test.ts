import { describe, expect, it } from 'vitest';
import { formatVnd } from '../../apps/storefront/src/format-money.ts';

describe('formatVnd', () => {
  it.each([
    [45000, '45.000\u00a0₫'],
    [0, '0\u00a0₫'],
    [1250000, '1.250.000\u00a0₫'],
  ])('formats integer VND %i without dividing or rounding', (minor, expected) => {
    expect(formatVnd(minor)).toBe(expected);
  });
});
