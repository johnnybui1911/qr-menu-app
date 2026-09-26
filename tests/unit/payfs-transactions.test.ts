import { describe, expect, it } from 'vitest';
import { parseTransactions } from '../../apps/worker/src/payfs/query-transactions.ts';

const valid = { transaction_id: 'tx-1', amount: 45000, content: 'CT QM7K2P9X4B', transfer_type: 'credit', bank: 'MB', extra: { nested: true } };
const expected = [{ transaction_id: 'tx-1', amount: 45000, content: 'CT QM7K2P9X4B', transfer_type: 'credit' }];

describe('parseTransactions (shape unconfirmed until O7)', () => {
  it.each([
    ['a root array', [valid]],
    ['data', { data: [valid] }],
    ['transactions', { transactions: [valid] }],
    ['items', { items: [valid] }],
  ])('reads the list under %s and keeps only the fact fields', (_label, body) => {
    expect(parseTransactions(body)).toEqual(expected);
  });

  it('skips entries missing a required fact and accepts numeric transaction ids', () => {
    const { amount: _amount, ...withoutAmount } = valid;
    expect(parseTransactions([withoutAmount, { ...valid, transaction_id: 1418108930751619 }, { ...valid, amount: '45000' }])).toEqual([
      { ...expected[0], transaction_id: '1418108930751619' },
    ]);
  });

  it.each([null, {}, 'text', [1, 2, 3]])('returns nothing for %j', (body) => {
    expect(parseTransactions(body)).toEqual([]);
  });
});
