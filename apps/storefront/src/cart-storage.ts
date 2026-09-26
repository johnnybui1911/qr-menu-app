// The cart lives in sessionStorage, keyed by a short digest of the table token — never the raw token (a leaked
// digest cannot be replayed as a capability) and never localStorage (decision #1: closing the tab drops the cart,
// which matches "you are physically at this table right now" and stops another table's old cart from resurrecting).

import type { CartLine } from './types.ts';

const DIGEST_BYTES = 8;

async function tableDigest(tableToken: string): Promise<string> {
  const bytes = new TextEncoder().encode(tableToken);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .slice(0, DIGEST_BYTES)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function readCart(tableToken: string): Promise<CartLine[]> {
  const raw = sessionStorage.getItem(`qr-menu-cart:${await tableDigest(tableToken)}`);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CartLine[]) : [];
  } catch {
    return [];
  }
}

export async function writeCart(tableToken: string, cart: CartLine[]): Promise<void> {
  const key = `qr-menu-cart:${await tableDigest(tableToken)}`;
  if (cart.length === 0) sessionStorage.removeItem(key);
  else sessionStorage.setItem(key, JSON.stringify(cart));
}
