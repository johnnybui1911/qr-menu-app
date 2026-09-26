import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifyPayfsWebhook } from '../../apps/worker/src/payfs/verify-webhook.ts';

describe('scripts/dev/sign-payfs-payload.ts', () => {
  it('produces a webhook the worker verifier accepts, offline', async () => {
    // Keys out of order and Vietnamese content: only a shared canonicalisation makes both sides agree.
    const payload = { transfer_type: 'credit', content: 'Thanh toán  QM7K2P9X4B', amount: 45000, transaction_id: 'tx-dev-1', bank: 'MB' };
    const file = join(mkdtempSync(join(tmpdir(), 'qr-sign-')), 'payload.json');
    writeFileSync(file, JSON.stringify(payload));
    const output = execFileSync('npx', ['tsx', 'scripts/dev/sign-payfs-payload.ts', '--payload', file, '--secret', 's3cret', '--api-key', 'k3y', '--timestamp', '1758173916'], {
      encoding: 'utf8',
    });
    const { headers, body } = JSON.parse(output) as { headers: Record<string, string>; body: string };
    expect(headers['x-payfs-timestamp']).toBe('1758173916');

    const request = new Request('http://local/api/payfs/webhook', { method: 'POST', headers, body });
    const result = await verifyPayfsWebhook(request, { PAYFS_WEBHOOK_API_KEY: 'k3y', PAYFS_WEBHOOK_SECRET: 's3cret' }, 1758173916 * 1000);
    expect(result).toMatchObject({ ok: true, transfer: { transactionId: 'tx-dev-1', amountMinor: 45000 } });
  });
});
