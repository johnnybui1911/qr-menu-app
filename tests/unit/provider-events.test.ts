import { describe, expect, it } from 'vitest';
import { fingerprintFacts } from '@qr/orders/provider-events';

describe('fingerprintFacts', () => {
  it('hashes only the shared fact fields, so webhook and reconciliation records agree', async () => {
    const webhook = { transaction_id: 'tx-1', amount: 45000, content: 'CT QM7K2P9X4B', transfer_type: 'credit', bank_account_number: '0123', bank: 'MB' };
    const reconciliation = { transaction_id: 'tx-1', amount: 45000, content: ' CT QM7K2P9X4B ', transfer_type: 'credit' };
    expect(await fingerprintFacts(webhook)).toBe(await fingerprintFacts(reconciliation));
    expect(await fingerprintFacts(webhook)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when any fact changes', async () => {
    const base = { transaction_id: 'tx-1', amount: 45000, content: 'CT', transfer_type: 'credit' };
    const digest = await fingerprintFacts(base);
    for (const change of [{ amount: 45001 }, { content: 'CT2' }, { transfer_type: 'debit' }, { transaction_id: 'tx-2' }]) {
      expect(await fingerprintFacts({ ...base, ...change })).not.toBe(digest);
    }
  });
});
