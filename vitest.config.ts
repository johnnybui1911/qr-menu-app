import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('migrations');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            MIGRATIONS: migrations,
            // Test-only receiving account (not secret: it is printed in every VietQR code).
            PAYFS_MERCHANT_BANK_BIN: '970422',
            PAYFS_MERCHANT_ACCOUNT: '0123456789',
            // Test-only webhook credentials; tests/support/payfs.ts signs with the same values.
            PAYFS_WEBHOOK_API_KEY: 'test-webhook-api-key',
            PAYFS_WEBHOOK_SECRET: 'test-webhook-secret',
            // Phase 5 test values: reconciliation API token and Resend delivery (sent to a stubbed fetch).
            PAYFS_API_TOKEN: 'test-payfs-api-token',
            RESEND_API_KEY: 'test-resend-api-key',
            RESEND_FROM_ADDRESS: 'QR Menu <onboarding@resend.dev>',
            OWNER_REPORT_EMAIL: 'owner@example.com',
            // Phase 6 test values: Console auth. BETTER_AUTH_SECRET must be >=32 chars (environment.ts).
            BETTER_AUTH_SECRET: 'test-better-auth-secret-0123456789',
            GOOGLE_CLIENT_ID: 'test-google-client-id',
            GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
            INITIAL_OWNER_EMAIL: 'initial-owner@example.com',
            INVITATION_HMAC_SECRET: 'test-invitation-hmac-secret-0123456789',
          },
        },
      }),
    ],
    test: {
      include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
      testTimeout: 30_000,
    },
  };
});
