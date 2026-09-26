import { evaluatePermission } from '@qr/identity/permissions';
import type { PermissionAction } from '@qr/identity/identity-types';
import { IDEMPOTENCY_KEY_PATTERN } from '@qr/orders/order-validation';
import type { ResolvedConsoleContext } from './console-request-context.ts';
import { jsonError } from './http-response.ts';

// Shared plumbing for the phase-7 console routes: permission, Idempotency-Key and JSON body checks with fixed errors.

export function forbiddenUnless(context: ResolvedConsoleContext, action: PermissionAction): Response | null {
  return evaluatePermission(context.identity, action, { storeId: context.storeId }) ? null : jsonError(403, 'forbidden');
}

/** Every console POST carries a client-generated Idempotency-Key (D10); it is only ever a ledger key, never SQL text. */
export function requireIdempotencyKey(request: Request): string | Response {
  const key = request.headers.get('idempotency-key');
  return key && IDEMPOTENCY_KEY_PATTERN.test(key) ? key : jsonError(400, 'idempotency_key_required');
}

/** Parses a JSON object body, rejecting unknown keys so a client cannot smuggle fields into a command. */
export async function readCommandBody(request: Request, allowed: readonly string[]): Promise<Record<string, unknown> | Response> {
  let body: unknown;
  try {
    const text = await request.text();
    body = text === '' ? {} : JSON.parse(text);
  } catch {
    return jsonError(400, 'invalid_json');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return jsonError(400, 'invalid_json');
  const unknown = Object.keys(body).find((key) => !allowed.includes(key));
  return unknown ? jsonError(400, 'unknown_field', unknown) : (body as Record<string, unknown>);
}

/** 409/404 mapping shared by every command outcome that is not a success. */
export function commandFailure(kind: string): Response {
  return kind === 'not_found' ? jsonError(404, 'not_found') : jsonError(409, kind);
}
