// Node-side equivalent of `tests/support/console-session.ts` (phase 6). That helper imports `cloudflare:workers`
// and only runs inside the workerd vitest pool; Playwright specs run under plain Node, so this file mints the same
// kind of session through `getPlatformProxy` instead of the `env` global — same tables, same `betterAuth` +
// `testUtils` combination, same reasoning: "one place that knows the better-auth cookie format" (phase 6 decision
// #8) now has a second, Node-side member for e2e, not a second implementation.
import { betterAuth } from 'better-auth';
import { testUtils } from 'better-auth/plugins';
import { getPlatformProxy } from 'wrangler';
import { resolveLocalPersistPath } from '../../../scripts/e2e-local-persist.ts';
import { STORE_ID } from '../../../packages/identity/src/store.ts';

export type ConsoleSessionEnv = {
  DB: D1Database;
  BETTER_AUTH_SECRET?: string;
};

export type MintedConsoleSession = { cookieName: string; cookieValue: string; userId: string; membershipId: string };

/**
 * Opens the same local D1 the dev servers use (via `resolveLocalPersistPath`), seeds an Owner identity directly
 * (bypassing OAuth entirely, exactly like the workerd helper), and mints a real better-auth session cookie for it.
 * Never seeds this row set anywhere outside the isolated e2e persist directory (decision #5: no Owner/session in
 * the committed seed).
 */
export async function mintConsoleSession(configPath: string, environment: string, persistBaseDir: string): Promise<MintedConsoleSession> {
  const proxy = await getPlatformProxy<ConsoleSessionEnv>({
    configPath,
    environment,
    persist: { path: resolveLocalPersistPath(persistBaseDir) },
  });
  try {
    const betterAuthSecret = proxy.env.BETTER_AUTH_SECRET;
    if (!betterAuthSecret) throw new Error('BETTER_AUTH_SECRET missing from the e2e dev vars file');

    const userId = crypto.randomUUID();
    const membershipId = crypto.randomUUID();
    const now = new Date().toISOString();
    const email = `e2e-owner-${userId}@example.com`;
    await proxy.env.DB.batch([
      proxy.env.DB.prepare('INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)').bind(
        userId,
        'E2E Owner',
        email,
        now,
        now,
      ),
      proxy.env.DB.prepare("INSERT INTO account (id, accountId, providerId, userId, createdAt, updatedAt) VALUES (?, ?, 'google', ?, ?, ?)").bind(
        crypto.randomUUID(),
        `google-${userId}`,
        userId,
        now,
        now,
      ),
      proxy.env.DB.prepare("INSERT INTO store_memberships (id, store_id, user_id, role, status, revoked_at) VALUES (?, ?, ?, 'owner', 'active', NULL)").bind(
        membershipId,
        STORE_ID,
        userId,
      ),
    ]);

    const auth = betterAuth({ database: proxy.env.DB, secret: betterAuthSecret, plugins: [testUtils()] });
    const ctx = await auth.$context;
    const { headers } = await ctx.test.login({ userId });
    const cookieHeader = headers.get('cookie');
    if (cookieHeader === null) throw new Error('better-auth test-utils did not produce a session cookie');
    const [cookieName, ...rest] = cookieHeader.split('=');
    return { cookieName, cookieValue: rest.join('='), userId, membershipId };
  } finally {
    await proxy.dispose();
  }
}
