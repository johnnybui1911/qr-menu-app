import { PRODUCT_IMAGE_PREFIX } from '@qr/catalog/files/product-image';

const ROUTE_PREFIX = '/api/storefront/product-images/';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const notFound = () => Response.json({ error: 'not_found' }, { status: 404 });

/**
 * GET /api/storefront/product-images/:uuid. The client supplies only a UUID; the server builds the object key, so no
 * request can read anything outside product-images/. Keys never change content, hence immutable caching (D13).
 */
export async function handleProductImageRequest(request: Request, env: Env): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith(ROUTE_PREFIX)) return null;
  const uuid = pathname.slice(ROUTE_PREFIX.length);
  if (request.method !== 'GET' || !UUID.test(uuid)) return notFound();

  // R2 compares bare etags; browsers send them quoted and sometimes weak (W/"…").
  const ifNoneMatch = request.headers.get('if-none-match')?.replace(/^W\//, '').replaceAll('"', '');
  const object = await env.FILES.get(`${PRODUCT_IMAGE_PREFIX}${uuid}`, ifNoneMatch ? { onlyIf: { etagDoesNotMatch: ifNoneMatch } } : {});
  if (!object) return notFound();

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  headers.set('x-content-type-options', 'nosniff');
  if (!('body' in object)) return new Response(null, { status: 304, headers });
  return new Response(object.body, { headers });
}
