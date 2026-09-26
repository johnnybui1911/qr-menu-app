import { transitionOrder, type KitchenAction } from '@qr/orders/commands/order-commands';
import { readKitchenInbox, type KitchenCursor } from '@qr/orders/kitchen-inbox';
import { commandFailure, forbiddenUnless, requireIdempotencyKey } from './console-command-support.ts';
import { withConsoleContext } from './console-request-context.ts';
import { jsonError, jsonResponse } from './http-response.ts';

const COMMAND_PATH = /^\/api\/console\/orders\/([^/]+)\/(prepare|fulfill)$/;
const DEFAULT_LIMIT = 100;
const CURSOR_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z),([^,]{1,64})$/;

function parseCursor(since: string | null): KitchenCursor | null | Response {
  if (since === null) return null;
  const match = CURSOR_PATTERN.exec(since);
  return match ? { updatedAt: match[1], id: match[2] } : jsonError(400, 'invalid_cursor');
}

/**
 * GET /api/console/orders?since=<updatedAt>,<id> — the kitchen poll (D7). The cursor carries both keyset columns;
 * If-None-Match with the last ETag answers 304 when nothing changed, so an idle 3-second poll costs one small read.
 */
async function getOrders(request: Request, env: Env): Promise<Response> {
  return withConsoleContext(request, env, async (context) => {
    const denied = forbiddenUnless(context, 'order:read');
    if (denied) return denied;
    const cursor = parseCursor(new URL(request.url).searchParams.get('since'));
    if (cursor instanceof Response) return cursor;
    const inbox = await readKitchenInbox(env.DB, context.storeId, { cursor, limit: DEFAULT_LIMIT });
    const headers = { etag: inbox.etag, 'cache-control': 'no-store' };
    if (request.headers.get('if-none-match') === inbox.etag) return new Response(null, { status: 304, headers });
    return jsonResponse({ orders: inbox.orders, since: inbox.cursor ? `${inbox.cursor.updatedAt},${inbox.cursor.id}` : null }, { headers });
  });
}

async function postCommand(request: Request, env: Env, orderId: string, action: KitchenAction): Promise<Response> {
  return withConsoleContext(request, env, async (context) => {
    const denied = forbiddenUnless(context, action);
    if (denied) return denied;
    const requestKey = requireIdempotencyKey(request);
    if (requestKey instanceof Response) return requestKey;
    const outcome = await transitionOrder(env.DB, { storeId: context.storeId, orderId, action, actorUserId: context.user.id, requestKey });
    return outcome.kind === 'done' || outcome.kind === 'replay' ? jsonResponse(outcome.result) : commandFailure(outcome.kind);
  });
}

export async function handleConsoleOrderRequest(request: Request, env: Env, pathname: string): Promise<Response | null> {
  if (pathname === '/api/console/orders' && request.method === 'GET') return getOrders(request, env);
  const command = COMMAND_PATH.exec(pathname);
  if (command && request.method === 'POST') return postCommand(request, env, command[1], command[2] === 'prepare' ? 'order:prepare' : 'order:fulfill');
  return null;
}
