export type OrderLineInput = { productId: string; quantity: number; notes: string };

export type ParsedOrderRequest =
  | { ok: true; items: OrderLineInput[] }
  | { ok: false; code: 'unknown_field' | 'invalid_field'; field: string };

const MAX_LINES = 50;
const MAX_NOTES_LENGTH = 500;
const ORDER_KEYS: Record<string, true> = { items: true };
const LINE_KEYS: Record<string, true> = { productId: true, quantity: true, notes: true };

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
/** Customer capabilities (table token, order token): at least 32 bytes base64url. */
export const CAPABILITY_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Accepts only productId, quantity and notes per line (D11.1). Any other key, including price or total, is reported
 * as unknown_field instead of being ignored, so a client can never believe its price was used.
 */
export function parseOrderRequest(body: unknown): ParsedOrderRequest {
  if (!isRecord(body)) return { ok: false, code: 'invalid_field', field: 'body' };
  const unknownOrderKey = Object.keys(body).find((key) => !ORDER_KEYS[key]);
  if (unknownOrderKey) return { ok: false, code: 'unknown_field', field: unknownOrderKey };
  const { items } = body;
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_LINES) return { ok: false, code: 'invalid_field', field: 'items' };

  const parsed: OrderLineInput[] = [];
  for (const [index, line] of items.entries()) {
    const at = `items[${index}]`;
    if (!isRecord(line)) return { ok: false, code: 'invalid_field', field: at };
    const unknownLineKey = Object.keys(line).find((key) => !LINE_KEYS[key]);
    if (unknownLineKey) return { ok: false, code: 'unknown_field', field: `${at}.${unknownLineKey}` };
    const { productId, quantity, notes = '' } = line;
    if (typeof productId !== 'string' || productId.length === 0 || productId.length > 64) {
      return { ok: false, code: 'invalid_field', field: `${at}.productId` };
    }
    if (!Number.isInteger(quantity) || (quantity as number) < 1 || (quantity as number) > 99) {
      return { ok: false, code: 'invalid_field', field: `${at}.quantity` };
    }
    if (typeof notes !== 'string' || notes.length > MAX_NOTES_LENGTH) return { ok: false, code: 'invalid_field', field: `${at}.notes` };
    parsed.push({ productId, quantity: quantity as number, notes });
  }
  return { ok: true, items: parsed };
}
