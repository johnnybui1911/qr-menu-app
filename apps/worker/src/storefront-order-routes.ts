import { readPublicMenu } from '@qr/catalog/catalog-read';
import { resolveTableByToken } from '@qr/catalog/tables-read';
import { STORE_ID } from '@qr/identity/store';
import { createOrder } from '@qr/orders/commands/order-write';
import { readOrderByCapability, type CustomerOrder } from '@qr/orders/order-read';
import { CAPABILITY_TOKEN_PATTERN, IDEMPOTENCY_KEY_PATTERN, parseOrderRequest } from '@qr/orders/order-validation';
import { logEvent } from './log.ts';
import { storefrontPreflight, withStorefrontCors } from './storefront-cors.ts';
import { buildVietQrPayload, readMerchantConfig, type MerchantAccount } from './vietqr.ts';

const MAX_BODY_BYTES = 16 * 1024;

/** Every storefront error goes through here, so all token failures share one 404 body (D8). */
function jsonError(error: string, status: number, extra: Record<string, unknown> = {}): Response {
  return Response.json({ error, ...extra }, { status });
}

function orderView(order: CustomerOrder, merchant: MerchantAccount | null) {
  return {
    orderCode: order.orderCode,
    status: order.status,
    tableNumber: order.tableNumber,
    currency: order.currency,
    totalAmountMinor: order.totalAmountMinor,
    paymentReference: order.paymentReference,
    createdAt: order.createdAt,
    items: order.items,
    vietqrPayload:
      order.status === 'pending_payment' && merchant
        ? buildVietQrPayload(merchant, { amountMinor: order.totalAmountMinor, content: order.paymentReference })
        : null,
  };
}

async function readJson(request: Request): Promise<{ ok: true; body: unknown } | { ok: false }> {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return { ok: false };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

async function getMenu(request: Request, env: Env): Promise<Response> {
  const table = await resolveTableByToken(env.DB, STORE_ID, request.headers.get('x-table-token'), new Date().toISOString());
  if (!table) return jsonError('not_found', 404);
  return Response.json({ table: { tableNumber: table.tableNumber }, categories: await readPublicMenu(env.DB, STORE_ID) });
}

async function postOrder(request: Request, env: Env): Promise<Response> {
  const json = await readJson(request);
  if (!json.ok) return jsonError('invalid_json', 400);
  const parsed = parseOrderRequest(json.body);
  if (!parsed.ok) return jsonError(parsed.code, 400, { field: parsed.field });

  const table = await resolveTableByToken(env.DB, STORE_ID, request.headers.get('x-table-token'), new Date().toISOString());
  if (!table) return jsonError('not_found', 404);

  const idempotencyKey = request.headers.get('idempotency-key') ?? '';
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) return jsonError('idempotency_key_invalid', 400);
  const orderToken = request.headers.get('x-order-token') ?? '';
  if (!CAPABILITY_TOKEN_PATTERN.test(orderToken)) return jsonError('order_token_invalid', 400);

  // No order is created when the customer could not be shown how to pay for it.
  const merchant = readMerchantConfig(env);
  if (!merchant) return jsonError('payment_unavailable', 503);

  const result = await createOrder(env.DB, { storeId: STORE_ID, tableId: table.id, idempotencyKey, orderToken, items: parsed.items });
  if (result.ok) {
    if (!result.replayed) logEvent({ event: 'order_created', orderCode: result.order.orderCode, tableId: table.id });
    return Response.json(orderView(result.order, merchant), { status: 201 });
  }
  switch (result.code) {
    case 'items_unavailable':
      return jsonError('items_unavailable', 409, { items: result.items });
    case 'idempotency_conflict':
    case 'order_token_in_use':
      return jsonError(result.code, 409);
    case 'total_mismatch': {
      // Prices are resolved and written in one request, so a disagreeing total is a bug, not a client error.
      const incidentId = crypto.randomUUID();
      logEvent({ event: 'order_total_assertion_failed', incidentId, tableId: table.id });
      return jsonError('internal_error', 500, { incidentId });
    }
    case 'payment_reference_exhausted':
      return jsonError('payment_unavailable', 503);
  }
}

async function getCurrentOrder(request: Request, env: Env): Promise<Response> {
  const order = await readOrderByCapability(env.DB, STORE_ID, request.headers.get('x-order-token'));
  if (!order) return jsonError('not_found', 404);
  return Response.json(orderView(order, readMerchantConfig(env)));
}

/** Handles /api/storefront/*; returns null for paths it does not own. */
export async function handleStorefrontRequest(request: Request, env: Env): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith('/api/storefront/')) return null;
  if (request.method === 'OPTIONS') return storefrontPreflight(request, env);

  let response: Response;
  if (pathname === '/api/storefront/menu' && request.method === 'GET') response = await getMenu(request, env);
  else if (pathname === '/api/storefront/orders' && request.method === 'POST') response = await postOrder(request, env);
  else if (pathname === '/api/storefront/orders/current' && request.method === 'GET') response = await getCurrentOrder(request, env);
  else response = jsonError('not_found', 404);
  return withStorefrontCors(request, env, response);
}
