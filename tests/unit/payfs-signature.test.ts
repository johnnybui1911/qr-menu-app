import { describe, expect, it } from 'vitest';
import { payfsSigningInput, sortKeysRecursive } from '../../apps/worker/src/payfs/canonicalize.ts';
import { verifyPayfsWebhook } from '../../apps/worker/src/payfs/verify-webhook.ts';
import vector from '../fixtures/payfs/test-vector.json?raw';
import { hmacHex } from '../support/payfs.ts';

const SECRET = 'whsec_example_secret_do_not_use_in_production';
const TIMESTAMP = '1758173916';
const EXPECTED = '86f02cefae56d51f72a00e04bf9d5a96b40cfe6902d54e495234c447ec706c5e';

describe('PayFS signature (D5, F11)', () => {
  it('reproduces the published test vector from any key order', async () => {
    // The fixture is already key-sorted, so it is also signed with its keys reversed to prove canonicalisation happens.
    const payload = JSON.parse(vector) as Record<string, unknown>;
    for (const variant of [payload, Object.fromEntries(Object.entries(payload).reverse())]) {
      expect(await hmacHex(SECRET, payfsSigningInput(TIMESTAMP, variant))).toBe(EXPECTED);
    }
  });

  it('accepts the published vector end to end through the verifier', async () => {
    const request = new Request('http://api.test/api/payfs/webhook', {
      method: 'POST',
      headers: { 'x-client-api-key': 'key', 'x-payfs-timestamp': TIMESTAMP, 'x-payfs-signature': EXPECTED },
      // Keys shuffled on the wire: the signature covers the canonical form, not these bytes.
      body: JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(vector)).reverse())),
    });
    const result = await verifyPayfsWebhook(request, { PAYFS_WEBHOOK_API_KEY: 'key', PAYFS_WEBHOOK_SECRET: SECRET }, Number(TIMESTAMP) * 1000);
    expect(result).toMatchObject({ ok: true, transfer: { transactionId: '1418108930751619072', amountMinor: 14000, transferType: 'credit' } });
  });

  it('gives a different digest when the raw body with reordered keys is signed', async () => {
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(vector)).reverse()));
    expect(await hmacHex(SECRET, `${TIMESTAMP}.${reordered}`)).not.toBe(EXPECTED);
  });

  it('sorts keys at every depth and keeps array order', () => {
    const sorted = sortKeysRecursive({ b: 1, a: { d: [{ z: 1, y: 2 }, 3], c: null } });
    expect(JSON.stringify(sorted)).toBe('{"a":{"c":null,"d":[{"y":2,"z":1},3]},"b":1}');
  });
});
