import { payfsSigningInput } from '../../apps/worker/src/payfs/canonicalize.ts';

export const TEST_WEBHOOK_API_KEY = 'test-webhook-api-key';
export const TEST_WEBHOOK_SECRET = 'test-webhook-secret';

export async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function creditPayload(overrides: Record<string, unknown> = {}) {
  return {
    account_id: '1418079746853494784',
    amount: 45000,
    bank: 'MB',
    bank_account_number: '0123456789',
    content: 'NGUYEN VAN A chuyen tien  Ma giao dich  Trace773231',
    transaction_date: '2026-09-26T05:00:00.000Z',
    transaction_id: `tx-${crypto.randomUUID()}`,
    transfer_type: 'credit',
    ...overrides,
  };
}

/** Builds a webhook request signed exactly like PayFS (canonical JSON, not the raw body). */
export async function signedWebhook(
  payload: Record<string, unknown>,
  { secret = TEST_WEBHOOK_SECRET, apiKey = TEST_WEBHOOK_API_KEY, timestamp = Math.floor(Date.now() / 1000), body = JSON.stringify(payload) } = {},
): Promise<Request> {
  const signature = await hmacHex(secret, payfsSigningInput(String(timestamp), payload));
  return new Request('http://api.test/api/payfs/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-client-api-key': apiKey, 'x-payfs-timestamp': String(timestamp), 'x-payfs-signature': signature },
    body,
  });
}
