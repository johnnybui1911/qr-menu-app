import { sha256Hex } from '@qr/identity/token-digest';
import { CAPABILITY_TOKEN_PATTERN } from './order-validation.ts';

/** Digest of the customer's Secret Link token; the raw token is never stored (C7). Returns null for malformed input. */
export async function digestOrderCapability(token: string | null): Promise<string | null> {
  return token && CAPABILITY_TOKEN_PATTERN.test(token) ? sha256Hex(token) : null;
}
