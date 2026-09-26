import { MoneyError } from './money.ts';

export type RequestedLine = { productId: string; quantity: number };

export type PricedLine = {
  productId: string;
  productName: string;
  quantity: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
};

export type LineRejectionCode = 'product_not_found' | 'product_unavailable';

export type ResolvedOrderLines =
  | { ok: true; currency: string; lines: PricedLine[]; totalAmountMinor: number }
  | { ok: false; rejected: { productId: string; code: LineRejectionCode }[] };

type PricingProductRow = { id: string; name: string; currency: string; price_minor: number; is_available: 0 | 1 };

/**
 * The single place a line item is priced (D19). Variants would be resolved here; today the unit price is the
 * product price. Throws MoneyError when the line total leaves the safe integer range.
 */
export function resolveLineItemPrice(product: { priceMinor: number }, quantity: number): { unitPriceMinor: number; lineTotalMinor: number } {
  const lineTotalMinor = product.priceMinor * quantity;
  if (!Number.isSafeInteger(lineTotalMinor)) throw new MoneyError('money_out_of_range');
  return { unitPriceMinor: product.priceMinor, lineTotalMinor };
}

/** Prices every requested line from D1 and totals them. Any missing or unavailable product rejects the whole order. */
export async function resolveOrderLineItems(db: D1Database, storeId: string, requested: RequestedLine[]): Promise<ResolvedOrderLines> {
  if (requested.length === 0) return { ok: false, rejected: [] };

  const productIds = [...new Set(requested.map((line) => line.productId))];
  const placeholders = productIds.map(() => '?').join(', ');
  const { results } = await db
    .prepare(`SELECT id, name, currency, price_minor, is_available FROM products WHERE store_id = ? AND is_active = 1 AND id IN (${placeholders})`)
    .bind(storeId, ...productIds)
    .all<PricingProductRow>();
  const productById = new Map(results.map((row) => [row.id, row]));

  const rejected: { productId: string; code: LineRejectionCode }[] = [];
  for (const productId of productIds) {
    const product = productById.get(productId);
    if (!product) rejected.push({ productId, code: 'product_not_found' });
    else if (product.is_available !== 1) rejected.push({ productId, code: 'product_unavailable' });
  }
  if (rejected.length > 0) return { ok: false, rejected };

  const currency = productById.get(productIds[0])!.currency;
  let totalAmountMinor = 0;
  const lines = requested.map(({ productId, quantity }) => {
    const product = productById.get(productId)!;
    if (product.currency !== currency) throw new MoneyError('money_currency_mismatch');
    const price = resolveLineItemPrice({ priceMinor: product.price_minor }, quantity);
    totalAmountMinor += price.lineTotalMinor;
    return { productId, productName: product.name, quantity, ...price };
  });
  if (!Number.isSafeInteger(totalAmountMinor)) throw new MoneyError('money_out_of_range');
  return { ok: true, currency, lines, totalAmountMinor };
}
