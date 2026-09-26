// Console is same-origin with the API Worker (F10): every call is a relative path with the session cookie
// (`credentials: 'same-origin'`), never an absolute URL — there is no VITE_* variable for Console at all.

export type ApiErrorBody = { error: string; field?: string; items?: unknown[] };

export type ApiResult<T> = { status: number; headers: Headers; data: T | ApiErrorBody | null };

export type ConsoleSession = {
  user: { id: string; email: string; name: string };
  store: { id: string };
  role: 'owner' | 'staff';
  allowedActions: string[];
};

async function parseBody(response: Response): Promise<unknown> {
  if (response.status === 304 || response.status === 204) return null;
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Reads (GET) with optional headers — the kitchen poll uses this for `If-None-Match`. */
export async function apiGet<T>(path: string, init: { headers?: Record<string, string> } = {}): Promise<ApiResult<T>> {
  const response = await fetch(path, { credentials: 'same-origin', headers: init.headers });
  return { status: response.status, headers: response.headers, data: (await parseBody(response)) as T | ApiErrorBody | null };
}

/**
 * POST/PATCH/DELETE with a JSON body. Every mutating `/api/console/*` call carries a stable Idempotency-Key —
 * caller-supplied when a command must survive a retry with the same key (kitchen/refund commands), otherwise a
 * fresh one is minted here. `/api/auth/*` calls (Google sign-in) never get one: it is not a command replay surface.
 */
export async function apiSend<T>(
  path: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  body?: unknown,
  init: { idempotencyKey?: string; headers?: Record<string, string> } = {},
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { ...init.headers };
  let payload: BodyInit | undefined;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  if (path.startsWith('/api/console/') && !headers['idempotency-key']) {
    headers['idempotency-key'] = init.idempotencyKey ?? crypto.randomUUID();
  }
  const response = await fetch(path, { method, credentials: 'same-origin', headers, body: payload });
  return { status: response.status, headers: response.headers, data: (await parseBody(response)) as T | ApiErrorBody | null };
}

/**
 * PUT for the one binary route (product image upload): `expectedRevision`/`filename` travel in headers, not a
 * JSON body, because the body itself is the raw image bytes (phase 8 construction-notes deviation).
 */
export async function apiUploadImage<T>(productId: string, body: BodyInit, init: { expectedRevision: number; filename: string }): Promise<ApiResult<T>> {
  const response = await fetch(`/api/console/products/${productId}/image`, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'x-expected-revision': String(init.expectedRevision), 'x-filename': init.filename },
    body,
  });
  return { status: response.status, headers: response.headers, data: (await parseBody(response)) as T | ApiErrorBody | null };
}

export function isErrorBody(data: unknown): data is ApiErrorBody {
  return typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string';
}
