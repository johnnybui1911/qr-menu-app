// Route allowlist checked before any session read (Requirements): an unlisted method+path combination is a 404,
// same as a real 404, so probing for routes cannot be distinguished from probing for nothing. Phases 7 and 8
// append their own routes to `ROUTES` (plan.md file-ownership table); this file is created here.

const ID_SEGMENT = '[^/]+';

type ConsoleRoute = { method: string; pattern: RegExp };

const ROUTES: ConsoleRoute[] = [
  { method: 'GET', pattern: /^\/api\/console\/session$/ },
  { method: 'GET', pattern: /^\/api\/console\/invitations$/ },
  { method: 'POST', pattern: /^\/api\/console\/invitations$/ },
  { method: 'POST', pattern: new RegExp(`^/api/console/invitations/${ID_SEGMENT}/revoke$`) },
  { method: 'POST', pattern: new RegExp(`^/api/console/memberships/${ID_SEGMENT}/revoke$`) },
  // Phase 8: menu, tables & QR.
  { method: 'GET', pattern: /^\/api\/console\/categories$/ },
  { method: 'POST', pattern: /^\/api\/console\/categories$/ },
  { method: 'PATCH', pattern: new RegExp(`^/api/console/categories/${ID_SEGMENT}$`) },
  { method: 'DELETE', pattern: new RegExp(`^/api/console/categories/${ID_SEGMENT}$`) },
  { method: 'GET', pattern: /^\/api\/console\/products$/ },
  { method: 'POST', pattern: /^\/api\/console\/products$/ },
  { method: 'PATCH', pattern: new RegExp(`^/api/console/products/${ID_SEGMENT}$`) },
  { method: 'DELETE', pattern: new RegExp(`^/api/console/products/${ID_SEGMENT}$`) },
  { method: 'POST', pattern: new RegExp(`^/api/console/products/${ID_SEGMENT}/availability$`) },
  { method: 'PUT', pattern: new RegExp(`^/api/console/products/${ID_SEGMENT}/image$`) },
  { method: 'DELETE', pattern: new RegExp(`^/api/console/products/${ID_SEGMENT}/image$`) },
  { method: 'GET', pattern: /^\/api\/console\/tables$/ },
  { method: 'POST', pattern: /^\/api\/console\/tables$/ },
  { method: 'PATCH', pattern: new RegExp(`^/api/console/tables/${ID_SEGMENT}$`) },
  { method: 'POST', pattern: new RegExp(`^/api/console/tables/${ID_SEGMENT}/qr$`) },
  // Phase 7: order commands, kitchen inbox, refunds, provider events, revenue.
  { method: 'GET', pattern: /^\/api\/console\/orders$/ },
  { method: 'POST', pattern: new RegExp(`^/api/console/orders/${ID_SEGMENT}/(?:prepare|fulfill)$`) },
  { method: 'POST', pattern: new RegExp(`^/api/console/orders/${ID_SEGMENT}/refund-requests$`) },
  { method: 'GET', pattern: /^\/api\/console\/refund-requests$/ },
  { method: 'POST', pattern: new RegExp(`^/api/console/refund-requests/${ID_SEGMENT}/decide$`) },
  { method: 'GET', pattern: /^\/api\/console\/provider-events$/ },
  { method: 'GET', pattern: /^\/api\/console\/revenue$/ },
];

export function isKnownConsoleRequest(request: Request): boolean {
  const { pathname } = new URL(request.url);
  return ROUTES.some((route) => route.method === request.method && route.pattern.test(pathname));
}
