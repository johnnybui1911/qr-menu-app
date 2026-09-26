// Values set with `wrangler secret put` (C11). `wrangler types` cannot see them, so they are declared here as
// optional: every consumer must fail closed when one is missing. Both the global Env and Cloudflare.Env
// (used by `cloudflare:workers`) are generated separately, so both are augmented.
interface WorkerSecrets {
  PAYFS_MERCHANT_BANK_BIN?: string;
  PAYFS_MERCHANT_ACCOUNT?: string;
  PAYFS_WEBHOOK_API_KEY?: string;
  PAYFS_WEBHOOK_SECRET?: string;
  PAYFS_API_TOKEN?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM_ADDRESS?: string;
  OWNER_REPORT_EMAIL?: string;
  BETTER_AUTH_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  INITIAL_OWNER_EMAIL?: string;
  INVITATION_HMAC_SECRET?: string;
}

interface Env extends WorkerSecrets {}

declare namespace Cloudflare {
  interface Env extends WorkerSecrets {}
}
