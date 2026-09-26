import { constantTimeEqual } from '@qr/identity/token-digest';
import { payfsSigningInput } from './canonicalize.ts';

export const MAX_WEBHOOK_BYTES = 16 * 1024;
const MAX_CLOCK_SKEW_SECONDS = 300;
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/i;

export type PayfsTransfer = {
  transactionId: string;
  amountMinor: number;
  content: string;
  transferType: string;
  rawPayload: string;
};

export type PayfsVerification =
  | { ok: true; transfer: PayfsTransfer }
  | { ok: false; status: 400 | 401 | 413 | 503; error: string; unverifiedBody?: string };

type WebhookSecrets = { PAYFS_WEBHOOK_API_KEY?: string; PAYFS_WEBHOOK_SECRET?: string };

async function readCapped(request: Request): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get('content-length'));
  if (declared > MAX_WEBHOOK_BYTES) return null;
  if (!request.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_WEBHOOK_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function parseTransfer(payload: unknown, rawPayload: string): PayfsTransfer | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { transaction_id, amount, content, transfer_type } = payload as Record<string, unknown>;
  const transactionId = typeof transaction_id === 'number' && Number.isSafeInteger(transaction_id) ? String(transaction_id) : transaction_id;
  if (typeof transactionId !== 'string' || transactionId.length === 0 || transactionId.length > 200) return null;
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) return null;
  if (typeof content !== 'string' || typeof transfer_type !== 'string') return null;
  return { transactionId, amountMinor: amount, content, transferType: transfer_type, rawPayload };
}

/**
 * The narrow PayFS gate (C9): the six D5 steps in order. Nothing outside apps/worker/src/payfs knows how PayFS signs.
 * A signature mismatch carries the raw body back so the caller can record it (it is most likely our own bug).
 */
export async function verifyPayfsWebhook(request: Request, env: WebhookSecrets, nowMs: number = Date.now()): Promise<PayfsVerification> {
  const body = await readCapped(request);
  if (!body) return { ok: false, status: 413, error: 'payload_too_large' };

  const apiKey = env.PAYFS_WEBHOOK_API_KEY ?? '';
  const secret = env.PAYFS_WEBHOOK_SECRET ?? '';
  if (!apiKey || !secret) return { ok: false, status: 503, error: 'payfs_not_configured' };
  if (!constantTimeEqual(request.headers.get('x-client-api-key') ?? '', apiKey)) return { ok: false, status: 401, error: 'unauthorized' };

  const timestamp = request.headers.get('x-payfs-timestamp') ?? '';
  if (!/^\d{1,12}$/.test(timestamp) || Math.abs(nowMs / 1000 - Number(timestamp)) > MAX_CLOCK_SKEW_SECONDS) {
    return { ok: false, status: 401, error: 'unauthorized' };
  }

  let rawPayload: string;
  let payload: unknown;
  try {
    rawPayload = new TextDecoder('utf-8', { fatal: true }).decode(body);
    payload = JSON.parse(rawPayload);
  } catch {
    return { ok: false, status: 400, error: 'invalid_json' };
  }

  const signature = request.headers.get('x-payfs-signature') ?? '';
  if (!SIGNATURE_PATTERN.test(signature)) return { ok: false, status: 401, error: 'unauthorized' };
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify('HMAC', key, hexToBytes(signature), new TextEncoder().encode(payfsSigningInput(timestamp, payload)));
  if (!valid) return { ok: false, status: 401, error: 'unauthorized', unverifiedBody: rawPayload };

  const transfer = parseTransfer(payload, rawPayload);
  if (!transfer) return { ok: false, status: 400, error: 'invalid_payload' };
  return { ok: true, transfer };
}
