import { describe, expect, it } from 'vitest';
import { buildVietQrPayload, crc16Ccitt, readMerchantConfig } from '../../apps/worker/src/vietqr.ts';
import sample from '../fixtures/vietqr/sample.txt?raw';

function parseTlv(payload: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (let i = 0; i < payload.length; ) {
    const id = payload.slice(i, i + 2);
    const length = Number(payload.slice(i + 2, i + 4));
    fields.set(id, payload.slice(i + 4, i + 4 + length));
    i += 4 + length;
  }
  return fields;
}

describe('VietQR payload', () => {
  it('computes the published CRC-16/CCITT-FALSE check value', () => {
    expect(crc16Ccitt('123456789')).toBe('29B1');
  });

  it('reproduces a published VietQR string byte for byte', () => {
    const payload = buildVietQrPayload({ bankBin: '970415', accountNumber: '0011001932418' }, { amountMinor: 120000, content: 'ung ho lu lut' });
    expect(payload).toBe(sample.trim());
  });

  it('carries the payment reference and amount in their fields, ending in a valid CRC', () => {
    const payload = buildVietQrPayload({ bankBin: '970422', accountNumber: '0123456789' }, { amountMinor: 45000, content: 'QM7K2P9X4B' });
    const fields = parseTlv(payload);
    expect(fields.get('54')).toBe('45000');
    expect(fields.get('53')).toBe('704');
    expect(parseTlv(fields.get('62')!).get('08')).toBe('QM7K2P9X4B');
    const merchant = parseTlv(fields.get('38')!);
    expect(merchant.get('00')).toBe('A000000727');
    expect(parseTlv(merchant.get('01')!)).toEqual(new Map([['00', '970422'], ['01', '0123456789']]));
    expect(payload.slice(-8, -4)).toBe('6304');
    expect(payload.slice(-4)).toBe(crc16Ccitt(payload.slice(0, -4)));
  });
});

describe('readMerchantConfig', () => {
  it.each([
    [{ PAYFS_MERCHANT_BANK_BIN: '', PAYFS_MERCHANT_ACCOUNT: '0123456789' }],
    [{ PAYFS_MERCHANT_BANK_BIN: '97042', PAYFS_MERCHANT_ACCOUNT: '0123456789' }],
    [{ PAYFS_MERCHANT_BANK_BIN: '970422', PAYFS_MERCHANT_ACCOUNT: '' }],
    [{ PAYFS_MERCHANT_BANK_BIN: '970422', PAYFS_MERCHANT_ACCOUNT: '0123 456' }],
    [{}],
  ])('fails closed on missing or malformed receiving account %j', (env) => {
    expect(readMerchantConfig(env)).toBeNull();
  });

  it('accepts a 6-digit BIN and an alphanumeric account', () => {
    expect(readMerchantConfig({ PAYFS_MERCHANT_BANK_BIN: '970422', PAYFS_MERCHANT_ACCOUNT: '0123456789' })).toEqual({
      bankBin: '970422',
      accountNumber: '0123456789',
    });
  });
});
