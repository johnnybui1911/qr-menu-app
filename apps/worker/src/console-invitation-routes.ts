import { normalizeEmail } from '@qr/identity/identity-types';
import type { StoreRole } from '@qr/identity/identity-types';
import { createInvitation } from '@qr/identity/invitations';
import { resolveActiveMembership } from '@qr/identity/membership-store';
import { enqueueEmailJobStatement } from '@qr/orders/email-outbox';
import type { ConsoleSessionContext } from './console-request-context.ts';
import { withConsoleSession } from './console-request-context.ts';
import { readConsoleAuthConfig } from './environment.ts';
import { jsonError, jsonResponse } from './http-response.ts';

const MAX_BODY_BYTES = 4 * 1024;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVALID_INVITATION = /NOT NULL constraint failed: owner_invitations\.id/;

type InvitationStatus = 'pending' | 'revoked' | 'consumed';
type InvitationRow = {
  id: string;
  target_email: string;
  role: StoreRole;
  expires_at: string;
  revoked_at: string | null;
  consumed_at: string | null;
  created_at: string;
};

type ActiveOwnerIssuer = { membershipId: string; userId: string };

/**
 * All three invitation routes share this single check (Requirements): issuing an invitation is not a
 * resource-scoped action, so it goes through a direct role/status check rather than `evaluatePermission`. It also
 * deliberately does *not* distinguish "no membership" from "revoked" from "staff" — `resolveActiveMembership`
 * already only ever returns an `active` row, so anything else collapses to the same `null` here and the same
 * `issuer_not_owner` 403 at the call site (Requirements: same payload for every non-owner reason).
 */
async function resolveActiveOwnerIssuer(env: Env, context: ConsoleSessionContext): Promise<ActiveOwnerIssuer | null> {
  const membership = await resolveActiveMembership(env.DB, context.user.id, context.storeId);
  if (membership.kind !== 'resolved' || membership.membership.role !== 'owner') return null;
  return { membershipId: membership.membership.id, userId: context.user.id };
}

function invitationStatus(row: InvitationRow): InvitationStatus {
  if (row.consumed_at !== null) return 'consumed';
  if (row.revoked_at !== null) return 'revoked';
  return 'pending';
}

async function readJsonBody(request: Request): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false }> {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return { ok: false };
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? { ok: true, value: parsed as Record<string, unknown> } : { ok: false };
  } catch {
    return { ok: false };
  }
}

async function postInvitation(request: Request, env: Env, context: ConsoleSessionContext, issuer: ActiveOwnerIssuer): Promise<Response> {
  const config = readConsoleAuthConfig(env);
  if (!config) return jsonError(503, 'auth_not_configured');

  const body = await readJsonBody(request);
  if (!body.ok) return jsonError(400, 'invalid_json');
  const targetEmailRaw = body.value['targetEmail'];
  if (typeof targetEmailRaw !== 'string') return jsonError(400, 'invalid_email');
  // Normalized here, at the route, before it ever reaches SQL — the DB CHECK only re-asserts the invariant.
  const targetEmail = normalizeEmail(targetEmailRaw);
  if (targetEmail.length < 3 || targetEmail.length > 320 || !EMAIL_PATTERN.test(targetEmail)) return jsonError(400, 'invalid_email');
  const role = body.value['role'];
  if (role !== 'owner' && role !== 'staff') return jsonError(400, 'invalid_role');

  const prepared = await createInvitation(env.DB, config.invitationHmacSecret, {
    storeId: context.storeId,
    targetEmail,
    role,
    issuerMembershipId: issuer.membershipId,
    issuerUserId: issuer.userId,
  });
  // Decision #7: the invitation INSERT and its email job share one db.batch() — a rejected invitation can never
  // leave an orphaned email job, and a rejected email job can never leave a silent, un-emailed invitation.
  const enqueue = enqueueEmailJobStatement(env.DB, {
    storeId: context.storeId,
    kind: 'invitation',
    orderId: null,
    dedupeKey: `invite:${prepared.invitationId}`,
    payload: { targetEmail, role, token: prepared.token },
  });
  try {
    await env.DB.batch([prepared.statement, enqueue]);
  } catch (error) {
    if (INVALID_INVITATION.test(String(error))) return jsonError(400, 'invalid_invitation');
    throw error;
  }

  // The token travels in the URL fragment, never the path or query string (C7, D8), and this response carries
  // Referrer-Policy: no-referrer so it cannot leak through a Referer header either.
  const invitationUrl = new URL('/console/invite', env.CONSOLE_ORIGIN);
  invitationUrl.hash = `invite=${encodeURIComponent(prepared.token)}`;
  return jsonResponse(
    { id: prepared.invitationId, invitationUrl: invitationUrl.href, expiresAt: prepared.expiresAt, targetEmail, role },
    { status: 201, headers: { 'referrer-policy': 'no-referrer' } },
  );
}

async function listInvitations(env: Env, context: ConsoleSessionContext): Promise<Response> {
  const { results } = await env.DB
    .prepare('SELECT id, target_email, role, expires_at, revoked_at, consumed_at, created_at FROM owner_invitations WHERE store_id = ? ORDER BY created_at DESC, id DESC')
    .bind(context.storeId)
    .all<InvitationRow>();
  return jsonResponse({
    invitations: results.map((row) => ({
      id: row.id,
      targetEmail: row.target_email,
      role: row.role,
      status: invitationStatus(row),
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    })),
  });
}

async function revokeInvitation(env: Env, context: ConsoleSessionContext, invitationId: string): Promise<Response> {
  const result = await env.DB
    .prepare('UPDATE owner_invitations SET revoked_at = ? WHERE id = ? AND store_id = ? AND revoked_at IS NULL AND consumed_at IS NULL')
    .bind(new Date().toISOString(), invitationId, context.storeId)
    .run();
  if (result.meta.changes === 0) return jsonError(404, 'invitation_not_found');
  return jsonResponse({ revoked: true });
}

const REVOKE_PATTERN = /^\/api\/console\/invitations\/([^/]+)\/revoke$/;

/** `/api/console/invitations*`, delegated to from console-session-routes.ts's top-level dispatcher. */
export function handleConsoleInvitationRequest(request: Request, env: Env, pathname: string): Promise<Response> {
  const withActiveOwner = (route: (context: ConsoleSessionContext, issuer: ActiveOwnerIssuer) => Promise<Response>) =>
    withConsoleSession(request, env, async (context) => {
      const issuer = await resolveActiveOwnerIssuer(env, context);
      return issuer === null ? jsonError(403, 'issuer_not_owner') : route(context, issuer);
    });

  if (pathname === '/api/console/invitations' && request.method === 'POST') {
    return withActiveOwner((context, issuer) => postInvitation(request, env, context, issuer));
  }
  if (pathname === '/api/console/invitations' && request.method === 'GET') {
    return withActiveOwner((context) => listInvitations(env, context));
  }
  const revokeMatch = REVOKE_PATTERN.exec(pathname);
  if (revokeMatch && request.method === 'POST') {
    const invitationId = revokeMatch[1]!;
    return withActiveOwner((context) => revokeInvitation(env, context, invitationId));
  }
  return Promise.resolve(jsonError(404, 'not_found'));
}
