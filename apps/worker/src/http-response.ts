// Shared response shaping for the Console auth surface (scout-04 §3.4, §7.7).

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return Response.json(body, init);
}

export function jsonError(status: number, error: string, errorDescription?: string): Response {
  return Response.json(errorDescription === undefined ? { error } : { error, errorDescription }, { status });
}

/**
 * Appends every `Set-Cookie` better-auth's `getSession` produced onto the response — on EVERY branch, including
 * error branches (403, 503). Skipping this drops cookie rolling on error responses (scout-04 §7.7): 403
 * (membership revoked) must keep the current session cookie unchanged; only 401 (session expired) sees
 * better-auth set `Max-Age=0` on its own.
 */
export function withConsoleAuthHeaders(response: Response, authHeaders: Headers): Response {
  const headers = new Headers(response.headers);
  for (const cookie of authHeaders.getSetCookie()) headers.append('set-cookie', cookie);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** Strips `Content-Length` (body may be re-wrapped) and marks the response as never cacheable / never referred
 * from (Requirements: `/api/auth/*` responses; also used on the invitation-creation response so a raw token in the
 * URL fragment never leaks through a Referer header). */
export function withNoStoreNoReferrer(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.set('cache-control', 'no-store');
  headers.set('referrer-policy', 'no-referrer');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
