import { createTable, issueTableToken, listTables, updateTable } from '@qr/catalog/tables-write';
import { evaluatePermission } from '@qr/identity/permissions';
import type { ResolvedConsoleContext } from './console-request-context.ts';
import { withConsoleContext } from './console-request-context.ts';
import { jsonError, jsonResponse } from './http-response.ts';

const MAX_JSON_BODY_BYTES = 4 * 1024;

async function readJsonBody(request: Request): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false }> {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_JSON_BODY_BYTES) return { ok: false };
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? { ok: true, value: parsed as Record<string, unknown> } : { ok: false };
  } catch {
    return { ok: false };
  }
}

function forbidden(context: ResolvedConsoleContext, action: 'table:read' | 'table:write' | 'table:qr:export'): Response | null {
  return evaluatePermission(context.identity, action, { storeId: context.storeId }) ? null : jsonError(403, 'forbidden');
}

const WRITE_RESULT_STATUS: Record<string, number> = { table_number_taken: 409, not_found: 404, rotation_conflict: 409 };

async function getTables(env: Env, context: ResolvedConsoleContext): Promise<Response> {
  const forbid = forbidden(context, 'table:read');
  if (forbid) return forbid;
  return jsonResponse({ tables: await listTables(env.DB, context.storeId) });
}

async function postTable(request: Request, env: Env, context: ResolvedConsoleContext): Promise<Response> {
  const forbid = forbidden(context, 'table:write');
  if (forbid) return forbid;
  const body = await readJsonBody(request);
  if (!body.ok || typeof body.value.tableNumber !== 'string') return jsonError(400, 'invalid_field');
  const result = await createTable(env.DB, context.storeId, body.value.tableNumber);
  return result.ok ? jsonResponse({ id: result.id }, { status: 201 }) : jsonError(WRITE_RESULT_STATUS[result.code] ?? 400, result.code);
}

async function patchTable(request: Request, env: Env, context: ResolvedConsoleContext, id: string): Promise<Response> {
  const forbid = forbidden(context, 'table:write');
  if (forbid) return forbid;
  const body = await readJsonBody(request);
  if (!body.ok) return jsonError(400, 'invalid_json');
  const patch: { tableNumber?: string; isActive?: boolean } = {};
  if (typeof body.value.tableNumber === 'string') patch.tableNumber = body.value.tableNumber;
  if (typeof body.value.isActive === 'boolean') patch.isActive = body.value.isActive;
  const result = await updateTable(env.DB, context.storeId, id, patch);
  return result.ok ? jsonResponse({ ok: true }) : jsonError(WRITE_RESULT_STATUS[result.code] ?? 400, result.code);
}

/**
 * "Export QR" (D17): a new token is returned exactly once, never re-readable. The response is marked no-store /
 * no-referrer so it is never cached or leaked through a Referer header, matching the invitation-creation response.
 */
async function postTableQr(env: Env, context: ResolvedConsoleContext, id: string): Promise<Response> {
  const forbid = forbidden(context, 'table:qr:export');
  if (forbid) return forbid;
  const result = await issueTableToken(env.DB, context.storeId, id);
  if (!result.ok) return jsonError(WRITE_RESULT_STATUS[result.code] ?? 400, result.code);
  const tokenUrl = `${env.STOREFRONT_ORIGIN}/t#${result.token}`;
  return jsonResponse({ tokenUrl, qrPayload: tokenUrl }, { headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
}

const TABLE_ID_PATTERN = /^\/api\/console\/tables\/([^/]+)$/;
const TABLE_QR_PATTERN = /^\/api\/console\/tables\/([^/]+)\/qr$/;

/** `/api/console/tables*`, delegated to from the top-level dispatcher. */
export function handleConsoleTableRequest(request: Request, env: Env, pathname: string): Promise<Response> | null {
  if (pathname === '/api/console/tables') {
    if (request.method === 'GET') return withConsoleContext(request, env, (context) => getTables(env, context));
    if (request.method === 'POST') return withConsoleContext(request, env, (context) => postTable(request, env, context));
  }
  const qrMatch = TABLE_QR_PATTERN.exec(pathname);
  if (qrMatch && request.method === 'POST') {
    const id = qrMatch[1]!;
    return withConsoleContext(request, env, (context) => postTableQr(env, context, id));
  }
  const idMatch = TABLE_ID_PATTERN.exec(pathname);
  if (idMatch && request.method === 'PATCH') {
    const id = idMatch[1]!;
    return withConsoleContext(request, env, (context) => patchTable(request, env, context, id));
  }
  return null;
}
