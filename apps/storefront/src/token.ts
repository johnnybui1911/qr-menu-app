// The customer's capability token travels in the URL fragment so it never reaches the server in a log line (D8,
// D17). We read it exactly once on mount and immediately strip it from the address bar with replaceState.

export type RouteToken = { kind: 'table'; token: string } | { kind: 'order'; token: string } | { kind: 'missing' };

/**
 * `/t#<tableToken>` starts the menu → cart → payment flow; `/o#<orderToken>` opens the Secret Link straight into
 * payment/tracking. Any other path, or a path with no fragment at all, is treated as `missing`: no token means no
 * API call, ever.
 */
export function consumeRouteToken(location: Location, history: History): RouteToken {
  const hash = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
  const isTableRoute = location.pathname.startsWith('/t');
  const isOrderRoute = location.pathname.startsWith('/o');

  if (hash) history.replaceState(null, '', location.pathname + location.search);

  if (!hash || (!isTableRoute && !isOrderRoute)) return { kind: 'missing' };
  return isOrderRoute ? { kind: 'order', token: hash } : { kind: 'table', token: hash };
}
