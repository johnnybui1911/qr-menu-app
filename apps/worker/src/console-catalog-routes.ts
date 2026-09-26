import { createCategory, deleteCategory, hideProduct, setProductAvailability, updateCategory, updateProduct, createProduct } from '@qr/catalog/catalog-write';
import type { CategoryPatch, ProductPatch } from '@qr/catalog/catalog-write';
import { readConsoleMenu } from '@qr/catalog/catalog-read';
import { removeProductImage, uploadProductImage, MAX_PRODUCT_IMAGE_BYTES } from '@qr/catalog/files/product-image';
import { decimalToMinor, MoneyError } from '@qr/catalog/money';
import { evaluatePermission } from '@qr/identity/permissions';
import type { ResolvedConsoleContext } from './console-request-context.ts';
import { withConsoleContext } from './console-request-context.ts';
import { jsonError, jsonResponse } from './http-response.ts';

const MAX_JSON_BODY_BYTES = 8 * 1024;

async function readJsonBody(request: Request): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false }> {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_JSON_BODY_BYTES) return { ok: false };
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? { ok: true, value: parsed as Record<string, unknown> } : { ok: false };
  } catch {
    return { ok: false };
  }
}

function forbidden(context: ResolvedConsoleContext, action: 'menu:read' | 'menu:write' | 'menu:stock:toggle' | 'menu:image:write'): Response | null {
  return evaluatePermission(context.identity, action, { storeId: context.storeId }) ? null : jsonError(403, 'forbidden');
}

/** Parses the client's decimal `price` string into minor units (C4/C5): never a float, excess precision refused. */
function parsePriceMinor(value: unknown): { ok: true; priceMinor: number } | { ok: false } {
  if (typeof value !== 'string') return { ok: false };
  try {
    return { ok: true, priceMinor: decimalToMinor(value, 'VND') };
  } catch (error) {
    if (error instanceof MoneyError) return { ok: false };
    throw error;
  }
}

const WRITE_RESULT_STATUS: Record<string, number> = {
  slug_taken: 409,
  category_not_found: 404,
  category_not_empty: 409,
  revision_conflict: 409,
  not_found: 404,
  product_image_size_exceeded: 413,
  product_image_type_unsupported: 415,
  product_image_empty: 400,
  product_image_store_failed: 500,
};

function writeResultResponse(result: ({ ok: true } & Record<string, unknown>) | { ok: false; code: string }): Response {
  if (!result.ok) return jsonError(WRITE_RESULT_STATUS[result.code] ?? 400, result.code);
  const { ok: _ok, ...body } = result;
  return jsonResponse(body, { status: 201 });
}

async function getCategories(env: Env, context: ResolvedConsoleContext): Promise<Response> {
  const forbid = forbidden(context, 'menu:read');
  if (forbid) return forbid;
  return jsonResponse({ categories: await readConsoleMenu(env.DB, context.storeId) });
}

async function postCategory(request: Request, env: Env, context: ResolvedConsoleContext): Promise<Response> {
  const forbid = forbidden(context, 'menu:write');
  if (forbid) return forbid;
  const body = await readJsonBody(request);
  if (!body.ok) return jsonError(400, 'invalid_json');
  const { name, slug, displayOrder } = body.value;
  if (typeof name !== 'string' || typeof slug !== 'string') return jsonError(400, 'invalid_field');
  const result = await createCategory(env.DB, context.storeId, { name, slug, displayOrder: typeof displayOrder === 'number' ? displayOrder : 0 });
  return writeResultResponse(result);
}

async function patchCategory(request: Request, env: Env, context: ResolvedConsoleContext, id: string): Promise<Response> {
  const forbid = forbidden(context, 'menu:write');
  if (forbid) return forbid;
  const body = await readJsonBody(request);
  if (!body.ok) return jsonError(400, 'invalid_json');
  const patch: CategoryPatch = {};
  if (typeof body.value.name === 'string') patch.name = body.value.name;
  if (typeof body.value.slug === 'string') patch.slug = body.value.slug;
  if (typeof body.value.displayOrder === 'number') patch.displayOrder = body.value.displayOrder;
  if (typeof body.value.isActive === 'boolean') patch.isActive = body.value.isActive;
  const result = await updateCategory(env.DB, context.storeId, id, patch);
  return result.ok ? jsonResponse({ ok: true }) : jsonError(WRITE_RESULT_STATUS[result.code] ?? 400, result.code);
}

async function deleteCategoryRoute(env: Env, context: ResolvedConsoleContext, id: string): Promise<Response> {
  const forbid = forbidden(context, 'menu:write');
  if (forbid) return forbid;
  const result = await deleteCategory(env.DB, context.storeId, id);
  return result.ok ? jsonResponse({ ok: true }) : jsonError(WRITE_RESULT_STATUS[result.code] ?? 400, result.code);
}

async function getProducts(env: Env, context: ResolvedConsoleContext): Promise<Response> {
  const forbid = forbidden(context, 'menu:read');
  if (forbid) return forbid;
  const categories = await readConsoleMenu(env.DB, context.storeId);
  return jsonResponse({ products: categories.flatMap((category) => category.products) });
}

async function postProduct(request: Request, env: Env, context: ResolvedConsoleContext): Promise<Response> {
  const forbid = forbidden(context, 'menu:write');
  if (forbid) return forbid;
  const body = await readJsonBody(request);
  if (!body.ok) return jsonError(400, 'invalid_json');
  const { categoryId, name, description, price, displayOrder } = body.value;
  if (typeof categoryId !== 'string' || typeof name !== 'string') return jsonError(400, 'invalid_field');
  const priced = parsePriceMinor(price);
  if (!priced.ok) return jsonError(400, 'invalid_price');
  const result = await createProduct(env.DB, context.storeId, {
    categoryId,
    name,
    description: typeof description === 'string' ? description : '',
    priceMinor: priced.priceMinor,
    displayOrder: typeof displayOrder === 'number' ? displayOrder : 0,
  });
  return writeResultResponse(result);
}

async function patchProduct(request: Request, env: Env, context: ResolvedConsoleContext, id: string): Promise<Response> {
  const forbid = forbidden(context, 'menu:write');
  if (forbid) return forbid;
  const body = await readJsonBody(request);
  if (!body.ok) return jsonError(400, 'invalid_json');
  const expectedRevision = body.value.expectedRevision;
  if (typeof expectedRevision !== 'number') return jsonError(400, 'invalid_field');
  const patch: ProductPatch = {};
  if (typeof body.value.categoryId === 'string') patch.categoryId = body.value.categoryId;
  if (typeof body.value.name === 'string') patch.name = body.value.name;
  if (typeof body.value.description === 'string') patch.description = body.value.description;
  if (typeof body.value.displayOrder === 'number') patch.displayOrder = body.value.displayOrder;
  if (body.value.price !== undefined) {
    const priced = parsePriceMinor(body.value.price);
    if (!priced.ok) return jsonError(400, 'invalid_price');
    patch.priceMinor = priced.priceMinor;
  }
  const result = await updateProduct(env.DB, context.storeId, id, expectedRevision, patch);
  return result.ok ? jsonResponse({ revision: result.revision }) : jsonError(WRITE_RESULT_STATUS[result.code] ?? 400, result.code);
}

async function postAvailability(request: Request, env: Env, context: ResolvedConsoleContext, id: string): Promise<Response> {
  const forbid = forbidden(context, 'menu:stock:toggle');
  if (forbid) return forbid;
  const body = await readJsonBody(request);
  if (!body.ok || typeof body.value.available !== 'boolean') return jsonError(400, 'invalid_field');
  const result = await setProductAvailability(env.DB, context.storeId, id, body.value.available);
  return result.ok ? jsonResponse({ ok: true }) : jsonError(WRITE_RESULT_STATUS[result.code] ?? 400, result.code);
}

async function deleteProduct(env: Env, context: ResolvedConsoleContext, id: string): Promise<Response> {
  const forbid = forbidden(context, 'menu:write');
  if (forbid) return forbid;
  const result = await hideProduct(env.DB, context.storeId, id);
  return result.ok ? jsonResponse({ ok: true }) : jsonError(WRITE_RESULT_STATUS[result.code] ?? 400, result.code);
}

async function putProductImage(request: Request, env: Env, context: ResolvedConsoleContext, id: string): Promise<Response> {
  const forbid = forbidden(context, 'menu:image:write');
  if (forbid) return forbid;
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_PRODUCT_IMAGE_BYTES) return jsonError(413, 'product_image_size_exceeded');
  if (!request.body) return jsonError(400, 'product_image_empty');
  const expectedRevisionHeader = request.headers.get('x-expected-revision');
  const expectedRevision = Number(expectedRevisionHeader);
  if (!expectedRevisionHeader || !Number.isInteger(expectedRevision)) return jsonError(400, 'invalid_field');
  const result = await uploadProductImage(env.DB, env.FILES, {
    storeId: context.storeId,
    productId: id,
    expectedRevision,
    filename: request.headers.get('x-filename') ?? 'upload',
    body: request.body,
  });
  return result.ok ? jsonResponse({ revision: result.revision }) : jsonError(WRITE_RESULT_STATUS[result.code] ?? 400, result.code);
}

async function deleteProductImage(env: Env, context: ResolvedConsoleContext, id: string): Promise<Response> {
  const forbid = forbidden(context, 'menu:image:write');
  if (forbid) return forbid;
  const result = await removeProductImage(env.DB, env.FILES, { storeId: context.storeId, productId: id });
  return result.ok ? jsonResponse({ ok: true }) : jsonError(WRITE_RESULT_STATUS[result.code] ?? 400, result.code);
}

const CATEGORY_ID_PATTERN = /^\/api\/console\/categories\/([^/]+)$/;
const PRODUCT_ID_PATTERN = /^\/api\/console\/products\/([^/]+)$/;
const PRODUCT_AVAILABILITY_PATTERN = /^\/api\/console\/products\/([^/]+)\/availability$/;
const PRODUCT_IMAGE_PATTERN = /^\/api\/console\/products\/([^/]+)\/image$/;

/** `/api/console/categories*` and `/api/console/products*`, delegated to from the top-level dispatcher. */
export function handleConsoleCatalogRequest(request: Request, env: Env, pathname: string): Promise<Response> | null {
  if (pathname === '/api/console/categories') {
    if (request.method === 'GET') return withConsoleContext(request, env, (context) => getCategories(env, context));
    if (request.method === 'POST') return withConsoleContext(request, env, (context) => postCategory(request, env, context));
  }
  const categoryMatch = CATEGORY_ID_PATTERN.exec(pathname);
  if (categoryMatch) {
    const id = categoryMatch[1]!;
    if (request.method === 'PATCH') return withConsoleContext(request, env, (context) => patchCategory(request, env, context, id));
    if (request.method === 'DELETE') return withConsoleContext(request, env, (context) => deleteCategoryRoute(env, context, id));
  }
  if (pathname === '/api/console/products') {
    if (request.method === 'GET') return withConsoleContext(request, env, (context) => getProducts(env, context));
    if (request.method === 'POST') return withConsoleContext(request, env, (context) => postProduct(request, env, context));
  }
  const imageMatch = PRODUCT_IMAGE_PATTERN.exec(pathname);
  if (imageMatch) {
    const id = imageMatch[1]!;
    if (request.method === 'PUT') return withConsoleContext(request, env, (context) => putProductImage(request, env, context, id));
    if (request.method === 'DELETE') return withConsoleContext(request, env, (context) => deleteProductImage(env, context, id));
  }
  const availabilityMatch = PRODUCT_AVAILABILITY_PATTERN.exec(pathname);
  if (availabilityMatch && request.method === 'POST') {
    const id = availabilityMatch[1]!;
    return withConsoleContext(request, env, (context) => postAvailability(request, env, context, id));
  }
  const productMatch = PRODUCT_ID_PATTERN.exec(pathname);
  if (productMatch) {
    const id = productMatch[1]!;
    if (request.method === 'PATCH') return withConsoleContext(request, env, (context) => patchProduct(request, env, context, id));
    if (request.method === 'DELETE') return withConsoleContext(request, env, (context) => deleteProduct(env, context, id));
  }
  return null;
}
