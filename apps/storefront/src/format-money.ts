// Local VND formatting. The storefront never imports @qr/* (D3), so this does not reuse packages/catalog/money.
const VND = new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' });

/** Formats integer VND from the server (fractionDigits = 0): no division, no rounding. */
export function formatVnd(minor: number): string {
  return VND.format(minor);
}
