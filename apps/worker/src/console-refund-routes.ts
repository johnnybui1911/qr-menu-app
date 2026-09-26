import { decideRefund, listRefundRequests, requestRefund } from '@qr/orders/refunds';
import { commandFailure, forbiddenUnless, readCommandBody, requireIdempotencyKey } from './console-command-support.ts';
import { withConsoleContext } from './console-request-context.ts';
import { jsonError, jsonResponse } from './http-response.ts';

const REQUEST_PATH = /^\/api\/console\/orders\/([^/]+)\/refund-requests$/;
const DECIDE_PATH = /^\/api\/console\/refund-requests\/([^/]+)\/decide$/;
const MAX_REASON_LENGTH = 1000;
const LIST_STATUSES: Record<string, 'pending' | 'approved' | 'rejected'> = { pending: 'pending', approved: 'approved', rejected: 'rejected' };

// Refunds are recorded, never paid out by code (O4): the owner transfers money by hand and then approves.

async function createRequest(request: Request, env: Env, orderId: string): Promise<Response> {
  return withConsoleContext(request, env, async (context) => {
    const denied = forbiddenUnless(context, 'refund:request');
    if (denied) return denied;
    const requestKey = requireIdempotencyKey(request);
    if (requestKey instanceof Response) return requestKey;
    const body = await readCommandBody(request, ['reason']);
    if (body instanceof Response) return body;
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (reason.length === 0 || reason.length > MAX_REASON_LENGTH) return jsonError(400, 'invalid_reason');
    const outcome = await requestRefund(env.DB, { storeId: context.storeId, orderId, staffUserId: context.user.id, reason, requestKey });
    return outcome.kind === 'done' || outcome.kind === 'replay' ? jsonResponse(outcome.result, { status: 201 }) : commandFailure(outcome.kind);
  });
}

async function decide(request: Request, env: Env, refundRequestId: string): Promise<Response> {
  return withConsoleContext(request, env, async (context) => {
    const denied = forbiddenUnless(context, 'refund:decide');
    if (denied) return denied;
    const requestKey = requireIdempotencyKey(request);
    if (requestKey instanceof Response) return requestKey;
    const body = await readCommandBody(request, ['decision']);
    if (body instanceof Response) return body;
    if (body.decision !== 'approve' && body.decision !== 'reject') return jsonError(400, 'invalid_decision');
    const outcome = await decideRefund(env.DB, { storeId: context.storeId, refundRequestId, decision: body.decision, ownerUserId: context.user.id, requestKey });
    return outcome.kind === 'done' || outcome.kind === 'replay' ? jsonResponse(outcome.result) : commandFailure(outcome.kind);
  });
}

/** GET /api/console/refund-requests?status= — the owner's review queue (needed to reach the decide route at all). */
async function list(request: Request, env: Env): Promise<Response> {
  return withConsoleContext(request, env, async (context) => {
    const denied = forbiddenUnless(context, 'refund:decide');
    if (denied) return denied;
    const status = new URL(request.url).searchParams.get('status');
    if (status !== null && !LIST_STATUSES[status]) return jsonError(400, 'invalid_status');
    return jsonResponse({ refundRequests: await listRefundRequests(env.DB, context.storeId, status === null ? null : LIST_STATUSES[status]) });
  });
}

export async function handleConsoleRefundRequest(request: Request, env: Env, pathname: string): Promise<Response | null> {
  const created = REQUEST_PATH.exec(pathname);
  if (created && request.method === 'POST') return createRequest(request, env, created[1]);
  const decided = DECIDE_PATH.exec(pathname);
  if (decided && request.method === 'POST') return decide(request, env, decided[1]);
  if (pathname === '/api/console/refund-requests' && request.method === 'GET') return list(request, env);
  return null;
}
