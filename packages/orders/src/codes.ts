const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
// Largest multiple of 36 below 256: bytes at or above it are redrawn so every character is equally likely.
const UNBIASED_BYTE_LIMIT = 252;
const PAYMENT_REFERENCE_PREFIX = 'QM';
const PAYMENT_REFERENCE_BODY_LENGTH = 8;
const ORDER_CODE_LENGTH = 6;

/** Finds a payment reference inside free-form bank transfer content (D18). Built from the generator's constants. */
export const PAYMENT_REFERENCE_PATTERN = new RegExp(`${PAYMENT_REFERENCE_PREFIX}[${ALPHABET}]{${PAYMENT_REFERENCE_BODY_LENGTH}}`);

function randomBase36(length: number): string {
  let out = '';
  while (out.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length))) {
      if (byte < UNBIASED_BYTE_LIMIT && out.length < length) out += ALPHABET[byte % ALPHABET.length];
    }
  }
  return out;
}

/** Bank reconciliation code: QM + 8 base36 characters, generated only here (C8). */
export function generatePaymentReference(): string {
  return PAYMENT_REFERENCE_PREFIX + randomBase36(PAYMENT_REFERENCE_BODY_LENGTH);
}

/** Short human-facing order code for kitchen tickets; deliberately a different shape from the payment reference. */
export function generateOrderCode(): string {
  return randomBase36(ORDER_CODE_LENGTH);
}
