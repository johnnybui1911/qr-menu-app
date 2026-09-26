// One (Idempotency-Key, order token) pair identifies a single order-placement *attempt* (phase 9 decision #5). Both
// are generated together, client-side, and kept stable across retries of the same attempt; a fresh pair is minted
// only after the attempt succeeds or is abandoned for a new one.

export type OrderAttempt = { idempotencyKey: string; orderToken: string };

export function createOrderAttempt(): OrderAttempt {
  return { idempotencyKey: crypto.randomUUID(), orderToken: randomOrderToken() };
}

/** The order token IS the Secret Link capability (32 random bytes, base64url — C7); the server never issues it. */
function randomOrderToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
