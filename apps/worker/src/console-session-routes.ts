import { evaluatePermission } from '@qr/identity/permissions';
import type { PermissionAction } from '@qr/identity/identity-types';
import { createAuth } from './auth.ts';
import { consoleOriginAllowed, withConsoleContext } from './console-request-context.ts';
import { isKnownConsoleRequest } from './console-route-match.ts';
import { handleConsoleOrderRequest } from './console-order-routes.ts';
import { handleConsoleProviderEventRequest } from './console-provider-event-routes.ts';
import { handleConsoleRefundRequest } from './console-refund-routes.ts';
import { handleConsoleReportRequest } from './console-report-routes.ts';
import { handleConsoleCatalogRequest } from './console-catalog-routes.ts';
import { handleConsoleInvitationRequest } from './console-invitation-routes.ts';
import { handleConsoleMembershipRequest } from './console-membership-routes.ts';
import { handleConsoleTableRequest } from './console-table-routes.ts';
import { readConsoleAuthConfig } from './environment.ts';
import { jsonError, jsonResponse, withNoStoreNoReferrer } from './http-response.ts';

/** `GET /api/console/session` filters this full action list through `evaluatePermission` so the UI never has to
 * guess what the signed-in role can do (scout-04 §4.3). */
const SESSION_ACTIONS: PermissionAction[] = [
  'menu:read',
  'menu:write',
  'menu:image:write',
  'menu:stock:toggle',
  'table:read',
  'table:write',
  'table:qr:export',
  'order:read',
  'order:prepare',
  'order:fulfill',
  'refund:request',
  'refund:decide',
  'report:read',
];

/** The only three `/api/auth/*` endpoints ever exposed (Requirements: no email/password signup or sign-in). */
const AUTH_ENDPOINTS: { method: string; pathname: string }[] = [
  { method: 'POST', pathname: '/api/auth/sign-in/social' },
  { method: 'POST', pathname: '/api/auth/sign-out' },
  { method: 'GET', pathname: '/api/auth/callback/google' },
];

function handleSessionRequest(request: Request, env: Env): Promise<Response> {
  return withConsoleContext(request, env, (context) =>
    jsonResponse({
      user: context.user,
      store: { id: context.storeId },
      role: context.identity.role,
      allowedActions: SESSION_ACTIONS.filter((action) => evaluatePermission(context.identity, action, { storeId: context.storeId })),
    }));
}

async function handleAuthRequest(request: Request, env: Env, pathname: string): Promise<Response> {
  if (!AUTH_ENDPOINTS.some((endpoint) => endpoint.method === request.method && endpoint.pathname === pathname)) {
    return withNoStoreNoReferrer(jsonError(404, 'not_found'));
  }
  const config = readConsoleAuthConfig(env);
  if (!config) return withNoStoreNoReferrer(jsonError(503, 'auth_not_configured'));
  if (!consoleOriginAllowed(request, env.CONSOLE_ORIGIN)) return withNoStoreNoReferrer(jsonError(403, 'origin_denied'));
  return withNoStoreNoReferrer(await createAuth(env, config).handler(request));
}

/**
 * The one Console-auth entry point wired into `apps/worker/src/index.ts`'s fetch chain. Owns both `/api/auth/*`
 * (better-auth's own endpoints) and `/api/console/*` (this phase's routes); returns null for anything else so the
 * chain falls through to the next handler / the final 404 (Architecture diagram).
 */
export async function handleConsoleRequest(request: Request, env: Env): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (pathname.startsWith('/api/auth/')) return handleAuthRequest(request, env, pathname);
  if (!pathname.startsWith('/api/console/')) return null;

  // Route allowlist runs before anything else, including reading the session (Requirements): an unknown route is
  // indistinguishable from a route that was never real.
  if (!isKnownConsoleRequest(request)) return jsonError(404, 'not_found');
  if (!consoleOriginAllowed(request, env.CONSOLE_ORIGIN)) return jsonError(403, 'origin_denied');

  if (pathname === '/api/console/session') return handleSessionRequest(request, env);
  if (pathname.startsWith('/api/console/invitations')) return handleConsoleInvitationRequest(request, env, pathname);
  if (pathname.startsWith('/api/console/memberships')) return handleConsoleMembershipRequest(request, env, pathname);
  if (pathname.startsWith('/api/console/categories') || pathname.startsWith('/api/console/products')) {
    return (await handleConsoleCatalogRequest(request, env, pathname)) ?? jsonError(404, 'not_found');
  }
  if (pathname.startsWith('/api/console/tables')) {
    return (await handleConsoleTableRequest(request, env, pathname)) ?? jsonError(404, 'not_found');
  }
  // Phase 7: refund routes first, since POST /orders/:id/refund-requests shares the /orders prefix.
  const phase7 =
    (await handleConsoleRefundRequest(request, env, pathname)) ??
    (await handleConsoleOrderRequest(request, env, pathname)) ??
    (await handleConsoleProviderEventRequest(request, env, pathname)) ??
    (await handleConsoleReportRequest(request, env, pathname));
  return phase7 ?? jsonError(404, 'not_found');
}
