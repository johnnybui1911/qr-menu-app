import { resolveActiveMembership } from '@qr/identity/membership-store';
import type { ConsoleSessionContext } from './console-request-context.ts';
import { withConsoleSession } from './console-request-context.ts';
import { jsonError, jsonResponse } from './http-response.ts';

async function revokeMembership(env: Env, context: ConsoleSessionContext, membershipId: string): Promise<Response> {
  // Same uniform check as the invitation routes: absent, revoked, or staff all collapse to the same 403 — none of
  // them may be distinguishable from the others.
  const issuer = await resolveActiveMembership(env.DB, context.user.id, context.storeId);
  if (issuer.kind !== 'resolved' || issuer.membership.role !== 'owner') return jsonError(403, 'issuer_not_owner');

  // D20: Owners must be able to revoke staff without touching the database by hand — but never their own seat,
  // which would leave the store with no active Owner at all.
  if (membershipId === issuer.membership.id) return jsonError(400, 'cannot_revoke_self');

  const now = new Date().toISOString();
  const result = await env.DB
    .prepare("UPDATE store_memberships SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE id = ? AND store_id = ? AND status = 'active'")
    .bind(now, now, membershipId, context.storeId)
    .run();
  if (result.meta.changes === 0) return jsonError(404, 'membership_not_found');
  return jsonResponse({ revoked: true });
}

const REVOKE_PATTERN = /^\/api\/console\/memberships\/([^/]+)\/revoke$/;

/** `/api/console/memberships/:id/revoke`, delegated to from console-session-routes.ts's top-level dispatcher. */
export function handleConsoleMembershipRequest(request: Request, env: Env, pathname: string): Promise<Response> {
  const match = REVOKE_PATTERN.exec(pathname);
  if (match && request.method === 'POST') {
    const membershipId = match[1]!;
    return withConsoleSession(request, env, (context) => revokeMembership(env, context, membershipId));
  }
  return Promise.resolve(jsonError(404, 'not_found'));
}
