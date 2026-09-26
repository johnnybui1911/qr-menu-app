// VietQR (NAPAS) payload: EMVCo TLV fields, CRC-16/CCITT-FALSE over everything up to and including "6304".

export type MerchantAccount = { bankBin: string; accountNumber: string };

const NAPAS_GUID = 'A000000727';
const SERVICE_TRANSFER_TO_ACCOUNT = 'QRIBFTTA';
const CURRENCY_VND = '704';
const INITIATION_DYNAMIC = '12';

function tlv(id: string, value: string): string {
  if (value.length > 99) throw new RangeError(`VietQR field ${id} exceeds 99 characters`);
  return `${id}${String(value.length).padStart(2, '0')}${value}`;
}

export function crc16Ccitt(input: string): string {
  let crc = 0xffff;
  for (const byte of new TextEncoder().encode(input)) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** A one-time (dynamic) transfer QR for `amountMinor` VND with `content` as the transfer description. */
export function buildVietQrPayload(account: MerchantAccount, transfer: { amountMinor: number; content: string }): string {
  const merchant = tlv('00', NAPAS_GUID) + tlv('01', tlv('00', account.bankBin) + tlv('01', account.accountNumber)) + tlv('02', SERVICE_TRANSFER_TO_ACCOUNT);
  const body =
    tlv('00', '01') +
    tlv('01', INITIATION_DYNAMIC) +
    tlv('38', merchant) +
    tlv('53', CURRENCY_VND) +
    tlv('54', String(transfer.amountMinor)) +
    tlv('58', 'VN') +
    tlv('62', tlv('08', transfer.content)) +
    '6304';
  return body + crc16Ccitt(body);
}

/** Receiving account from configuration; null when missing or malformed so no QR with wrong details is ever shown. */
export function readMerchantConfig(env: { PAYFS_MERCHANT_BANK_BIN?: string; PAYFS_MERCHANT_ACCOUNT?: string }): MerchantAccount | null {
  const bankBin = env.PAYFS_MERCHANT_BANK_BIN ?? '';
  const accountNumber = env.PAYFS_MERCHANT_ACCOUNT ?? '';
  if (!/^\d{6}$/.test(bankBin) || !/^[0-9A-Za-z]{1,19}$/.test(accountNumber)) return null;
  return { bankBin, accountNumber };
}
