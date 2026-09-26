import { readProviderEvents } from '@qr/orders/provider-events';
import { forbiddenUnless } from './console-command-support.ts';
import { withConsoleContext } from './console-request-context.ts';
import { jsonError, jsonResponse } from './http-response.ts';

/**
 * GET /api/console/provider-events?orderId=<id> | ?unmatched=1 — owner only: raw transaction payloads are bank data.
 * `unmatched=1` surfaces money whose reference the bank garbled, which would otherwise be invisible.
 */
export async function handleConsoleProviderEventRequest(request: Request, env: Env, pathname: string): Promise<Response | null> {
  if (pathname !== '/api/console/provider-events' || request.method !== 'GET') return null;
  return withConsoleContext(request, env, async (context) => {
    const denied = forbiddenUnless(context, 'report:read');
    if (denied) return denied;
    const params = new URL(request.url).searchParams;
    const orderId = params.get('orderId');
    if (orderId) return jsonResponse({ events: await readProviderEvents(env.DB, context.storeId, { orderId }) });
    if (params.get('unmatched') === '1') return jsonResponse({ events: await readProviderEvents(env.DB, context.storeId, { unmatched: true }) });
    return jsonError(400, 'filter_required');
  });
}
