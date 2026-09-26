// Storefront runs on its own origin and sends tokens in custom headers, so every call is preflighted (D17).
// Exactly one allowed origin, no credentials (F10), and a cached preflight.

const ALLOWED_HEADERS = 'content-type, x-table-token, x-order-token, idempotency-key';
const PREFLIGHT_MAX_AGE_SECONDS = '600';

function corsHeaders(request: Request, env: Env): Headers {
  const headers = new Headers({ vary: 'Origin' });
  const origin = request.headers.get('origin');
  if (origin && origin === env.STOREFRONT_ORIGIN) headers.set('access-control-allow-origin', origin);
  return headers;
}

export function storefrontPreflight(request: Request, env: Env): Response {
  const headers = corsHeaders(request, env);
  if (headers.has('access-control-allow-origin')) {
    headers.set('access-control-allow-methods', 'GET, POST');
    headers.set('access-control-allow-headers', ALLOWED_HEADERS);
    headers.set('access-control-max-age', PREFLIGHT_MAX_AGE_SECONDS);
  }
  return new Response(null, { status: 204, headers });
}

export function withStorefrontCors(request: Request, env: Env, response: Response): Response {
  const cors = corsHeaders(request, env);
  const headers = new Headers(response.headers);
  cors.forEach((value, key) => headers.set(key, value));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
