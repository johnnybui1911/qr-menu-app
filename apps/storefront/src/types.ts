// Shapes mirror the storefront API contract exactly (apps/worker/src/storefront-order-routes.ts,
// packages/catalog/src/catalog-read.ts). The storefront never imports @qr/* (D3), so these are re-declared here.

export type PublicProduct = {
  id: string;
  name: string;
  description: string;
  priceMinor: number;
  currency: string;
  /** false = sold out for today; still listed, never selectable. */
  isAvailable: boolean;
  /** UUID for GET /api/storefront/product-images/:id, or null when the product has no image. */
  imageId: string | null;
};

export type PublicCategory = { id: string; name: string; slug: string; products: PublicProduct[] };

export type MenuResponse = { table: { tableNumber: number }; categories: PublicCategory[] };

export type OrderItemView = {
  productName: string;
  quantity: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
  notes: string | null;
};

export type OrderStatus = 'pending_payment' | 'paid' | 'preparing' | 'fulfilled' | 'cancelled' | 'refunded';

/** The order view returned by both POST /api/storefront/orders and GET /api/storefront/orders/current. */
export type OrderView = {
  orderCode: string;
  status: OrderStatus;
  tableNumber: number;
  currency: string;
  totalAmountMinor: number;
  paymentReference: string;
  createdAt: string;
  items: OrderItemView[];
  /** Only populated while pending_payment; the server never leaks a payload for a settled order. */
  vietqrPayload: string | null;
};

/** Cart line kept client-side only; `priceMinor` is for the customer's own estimate, never sent to the server (C5). */
export type CartLine = {
  productId: string;
  name: string;
  priceMinor: number;
  quantity: number;
  notes: string;
};
