export type MoneyErrorCode = 'money_malformed' | 'money_over_precision' | 'money_out_of_range' | 'money_unknown_currency' | 'money_currency_mismatch';

export class MoneyError extends Error {
  constructor(readonly code: MoneyErrorCode) {
    super(code);
    this.name = 'MoneyError';
  }
}

const DECIMAL = /^(?:0|[1-9]\d*)(?:\.(\d+))?$/;
const MAX_MINOR = BigInt(Number.MAX_SAFE_INTEGER);
const fractionDigitsByCurrency = new Map<string, number>();

export function currencyFractionDigits(currency: string): number {
  let digits = fractionDigitsByCurrency.get(currency);
  if (digits === undefined) {
    try {
      digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 0;
    } catch {
      throw new MoneyError('money_unknown_currency');
    }
    fractionDigitsByCurrency.set(currency, digits);
  }
  return digits;
}

/** Parses a plain decimal string into integer minor units. Never rounds: excess precision is an error (C4). */
export function decimalToMinor(value: string, currency: string): number {
  const match = DECIMAL.exec(value);
  if (!match) throw new MoneyError('money_malformed');
  const digits = currencyFractionDigits(currency);
  const fraction = match[1] ?? '';
  if (fraction.length > digits) throw new MoneyError('money_over_precision');
  const [whole] = value.split('.');
  const minor = BigInt(whole) * 10n ** BigInt(digits) + BigInt(fraction.padEnd(digits, '0') || '0');
  if (minor > MAX_MINOR) throw new MoneyError('money_out_of_range');
  return Number(minor);
}

export function minorToDecimal(minor: number, currency: string): string {
  if (!Number.isSafeInteger(minor) || minor < 0) throw new MoneyError('money_out_of_range');
  const digits = currencyFractionDigits(currency);
  if (digits === 0) return String(minor);
  const padded = String(minor).padStart(digits + 1, '0');
  return `${padded.slice(0, -digits)}.${padded.slice(-digits)}`;
}
