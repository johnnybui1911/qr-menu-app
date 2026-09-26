import { resolveActiveMembership } from '@qr/identity/membership-store';
import type { ConsoleIdentityContext } from '@qr/identity/identity-types';
import { STORE_ID } from '@qr/identity/store';
import { createAuth } from './auth.ts';
import { readConsoleAuthConfig } from './environment.ts';
import { jsonError, withConsoleAuthHeaders } from './http-response.ts';
import { logEvent } from './log.ts';

export type ResolvedConsoleContext = {
  storeId: string;
  user: { id: string; email: string; name: string };
  identity: ConsoleIdentityContext;
};

export type ConsoleContextResolution =
  | { kind: 'service-unavailable'; authHeaders: Headers }
  | { kind: 'unauthenticated'; authHeaders: Headers }
  | { kind: 'store-access-denied'; authHeaders: Headers }
  | { kind: 'resolved'; authHeaders: Headers; context: ResolvedConsoleContext };

export type ConsoleSessionContext = { storeId: string; user: { id: string; email: string; name: string } };

export type ConsoleSessionResolution =
  | { kind: 'service-unavailable'; authHeaders: Headers }
  | { kind: 'unauthenticated'; authHeaders: Headers }
  | { kind: 'session'; authHeaders: Headers; context: ConsoleSessionContext };

/**
 * Authenticates the request (session only, no membership lookup) — the shared first half of every `/api/console/*`
 * request. Most routes need the full `resolveConsoleRequestContext` below; the three invitation routes and the
 * membership-revoke route stop here and run their own `resolveActiveMembership` so a missing, revoked, or
 * wrong-role membership can all collapse into the exact same rejection payload (Requirements: "issuer_not_owner"
 * must not distinguish "no membership" from "revoked" from "staff" — any distinction would leak which is true).
 */
export async function resolveConsoleSession(request: Request, env: Env): Promise<ConsoleSessionResolution> {
  const authHeaders = new Headers();
  const config = readConsoleAuthConfig(env);
  if (!config) return { kind: 'service-unavailable', authHeaders };
  try {
    const sessionResult = await createAuth(env, config).api.getSession({ headers: request.headers, returnHeaders: true });
    for (const cookie of sessionResult.headers.getSetCookie()) authHeaders.append('set-cookie', cookie);
    const session = sessionResult.response;
    if (!session) return { kind: 'unauthenticated', authHeaders };
    return { kind: 'session', authHeaders, context: { storeId: STORE_ID, user: { id: session.user.id, email: session.user.email, name: session.user.name } } };
  } catch (error) {
    // Fail closed, but never silently: an exception here is a server fault, not missing configuration.
    logEvent({ event: 'console_session_failed', incidentId: crypto.randomUUID(), error: String(error) });
    return { kind: 'service-unavailable', authHeaders };
  }
}

/**
 * The single place `role`/`membershipStatus` is derived for a Console request that needs a resolved *active*
 * membership (D15): re-reads `store_memberships` via `resolveActiveMembership` on every call, never trusts
 * anything cached in the session cookie. `authHeaders` carries every `Set-Cookie` better-auth's `getSession`
 * produced (cookie rolling / expiry), forwarded by the caller through `withConsoleAuthHeaders` on every branch,
 * including the error branches.
 */
export async function resolveConsoleRequestContext(request: Request, env: Env): Promise<ConsoleContextResolution> {
  const sessionResolution = await resolveConsoleSession(request, env);
  if (sessionResolution.kind !== 'session') return sessionResolution;

  const membership = await resolveActiveMembership(env.DB, sessionResolution.context.user.id, STORE_ID);
  if (membership.kind !== 'resolved') return { kind: 'store-access-denied', authHeaders: sessionResolution.authHeaders };

  return {
    kind: 'resolved',
    authHeaders: sessionResolution.authHeaders,
    context: {
      storeId: STORE_ID,
      user: sessionResolution.context.user,
      identity: {
        kind: 'console',
        storeId: STORE_ID,
        userId: sessionResolution.context.user.id,
        membershipId: membership.membership.id,
        role: membership.membership.role,
        membershipStatus: membership.membership.status,
      },
    },
  };
}

/**
 * `trustedOrigins` alone is not enough (scout-04 §7.2): every non-safe method must also carry a matching `Origin`
 * header and a `Sec-Fetch-Site` that is either absent or `same-origin`. GET/HEAD/OPTIONS are always allowed —
 * OPTIONS never mutates state and Console never serves cross-origin preflight (unlike the storefront CORS surface).
 */
export function consoleOriginAllowed(request: Request, consoleOrigin: string): boolean {
  if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') return true;
  if (request.headers.get('origin') !== consoleOrigin) return false;
  const fetchSite = request.headers.get('sec-fetch-site');
  return fetchSite === null || fetchSite === 'same-origin';
}

const RESOLUTION_ERROR: Record<Exclude<ConsoleContextResolution['kind'], 'resolved'>, { status: number; error: string }> = {
  'service-unavailable': { status: 503, error: 'auth_not_configured' },
  unauthenticated: { status: 401, error: 'unauthenticated' },
  'store-access-denied': { status: 403, error: 'store_access_denied' },
};

/**
 * The shared entry point for every `/api/console/*` route: resolve the request context, translate an unresolved
 * outcome into its fixed HTTP status, otherwise hand the resolved context to `onResolved` — and forward the
 * accumulated `Set-Cookie` headers onto whichever response comes out, unconditionally (scout-04 §7.7).
 */
export async function withConsoleContext(request: Request, env: Env, onResolved: (context: ResolvedConsoleContext) => Promise<Response> | Response): Promise<Response> {
  const resolution = await resolveConsoleRequestContext(request, env);
  const response =
    resolution.kind === 'resolved'
      ? await onResolved(resolution.context)
      : jsonError(RESOLUTION_ERROR[resolution.kind].status, RESOLUTION_ERROR[resolution.kind].error);
  return withConsoleAuthHeaders(response, resolution.authHeaders);
}

const SESSION_RESOLUTION_ERROR: Record<Exclude<ConsoleSessionResolution['kind'], 'session'>, { status: number; error: string }> = {
  'service-unavailable': { status: 503, error: 'auth_not_configured' },
  unauthenticated: { status: 401, error: 'unauthenticated' },
};

/**
 * The entry point for routes that must apply their own uniform authorization instead of the generic
 * `store-access-denied` mapping — the three invitation routes and membership-revoke (Requirements). Only
 * authentication (401/503) is handled here; `onSession` is responsible for resolving membership itself and
 * deciding what counts as authorized.
 */
export async function withConsoleSession(request: Request, env: Env, onSession: (context: ConsoleSessionContext) => Promise<Response> | Response): Promise<Response> {
  const resolution = await resolveConsoleSession(request, env);
  const response =
    resolution.kind === 'session'
      ? await onSession(resolution.context)
      : jsonError(SESSION_RESOLUTION_ERROR[resolution.kind].status, SESSION_RESOLUTION_ERROR[resolution.kind].error);
  return withConsoleAuthHeaders(response, resolution.authHeaders);
}
