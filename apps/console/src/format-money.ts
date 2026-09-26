// Local VND formatting. Kept as its own copy (not imported from the storefront, and not routed through
// @qr/catalog/money either) so this file has exactly the same shape on both sides of D3's app boundary.
const VND = new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' });

/** Formats integer VND from the server (fractionDigits = 0): no division, no rounding. */
export function formatVnd(minor: number): string {
  return VND.format(minor);
}
