// Signs a webhook payload exactly like PayFS (D22) so the money path runs without a PayFS account or network.
//
//   tsx scripts/dev/sign-payfs-payload.ts --payload payload.json --secret <PAYFS_WEBHOOK_SECRET> --api-key <PAYFS_WEBHOOK_API_KEY>
//       [--timestamp <unix seconds>] [--post http://127.0.0.1:8787/api/payfs/webhook]
//
// Without --post it prints {"headers", "body"} as JSON. `--payload -` reads stdin.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { payfsSigningInput } from '../../apps/worker/src/payfs/canonicalize.ts';

const { values } = parseArgs({
  options: {
    payload: { type: 'string' },
    secret: { type: 'string' },
    'api-key': { type: 'string' },
    timestamp: { type: 'string' },
    post: { type: 'string' },
  },
});
if (!values.payload || !values.secret || !values['api-key']) {
  console.error('Usage: tsx scripts/dev/sign-payfs-payload.ts --payload <file|-> --secret <secret> --api-key <key> [--timestamp <s>] [--post <url>]');
  process.exit(2);
}

const body = readFileSync(values.payload === '-' ? 0 : values.payload, 'utf8').trim();
const timestamp = values.timestamp ?? String(Math.floor(Date.now() / 1000));
const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(values.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payfsSigningInput(timestamp, JSON.parse(body)))));
const headers = {
  'content-type': 'application/json',
  'x-client-api-key': values['api-key'],
  'x-payfs-timestamp': timestamp,
  'x-payfs-signature': Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join(''),
};

if (values.post) {
  const response = await fetch(values.post, { method: 'POST', headers, body });
  console.log(response.status, await response.text());
  process.exit(response.ok ? 0 : 1);
}
console.log(JSON.stringify({ headers, body }));
