// One fetch wrapper for the whole app: no credentials (the storefront is a different origin than the API — F10),
// capability tokens go in headers (never query string — C7), and every HTTP error maps to a typed result instead of
// a thrown exception, so callers branch on `code` instead of parsing bodies themselves.

export const API_BASE_URL = import.meta.env.VITE_STOREFRONT_API_BASE_URL as string;

/** A `fetch()` rejection (offline, DNS, CORS preflight failure, …) — distinct from a well-formed HTTP error response. */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super('storefront_network_error', { cause });
    this.name = 'NetworkError';
  }
}

export type ApiErrorItem = { productId: string; code: string };

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; code: string; field?: string; items?: ApiErrorItem[] };

type RequestInput = {
  path: string;
  method?: 'GET' | 'POST';
  tableToken?: string;
  orderToken?: string;
  idempotencyKey?: string;
  body?: unknown;
};

/** Sends one request; throws {@link NetworkError} on transport failure, otherwise always resolves. */
export async function request<T>(input: RequestInput): Promise<ApiResult<T>> {
  const headers = new Headers();
  if (input.tableToken) headers.set('X-Table-Token', input.tableToken);
  if (input.orderToken) headers.set('X-Order-Token', input.orderToken);
  if (input.idempotencyKey) headers.set('Idempotency-Key', input.idempotencyKey);

  let body: string | undefined;
  if (input.body !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(input.body);
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${input.path}`, { method: input.method ?? 'GET', headers, body });
  } catch (cause) {
    throw new NetworkError(cause);
  }

  // A misconfigured base URL (or any proxy/edge that answers with an HTML error page) must never be mistaken for a
  // valid JSON success body — that garbage would otherwise reach a screen component as "ok: true" and crash it.
  if (!response.headers.get('content-type')?.includes('application/json')) {
    return { ok: false, status: response.status, code: 'invalid_response' };
  }
  const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (json === null) return { ok: false, status: response.status, code: 'invalid_response' };
  if (response.ok) return { ok: true, data: json as T };
  return {
    ok: false,
    status: response.status,
    code: typeof json.error === 'string' ? json.error : 'unknown_error',
    field: typeof json.field === 'string' ? json.field : undefined,
    items: Array.isArray(json.items) ? (json.items as ApiErrorItem[]) : undefined,
  };
}

/** The server hands out only a UUID; it builds the R2 key itself (T A1 — no direct R2 URL ever reaches the client). */
export function productImageUrl(imageId: string): string {
  return `${API_BASE_URL}/api/storefront/product-images/${imageId}`;
}
