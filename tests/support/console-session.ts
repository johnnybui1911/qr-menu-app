import { env, exports } from 'cloudflare:workers';
import { betterAuth } from 'better-auth';
import { testUtils } from 'better-auth/plugins';
import { STORE_ID } from '@qr/identity/store';
import type { MembershipStatus, StoreRole } from '@qr/identity/identity-types';

export type SeedConsoleUserInput = {
  role?: StoreRole;
  status?: MembershipStatus;
  email?: string;
  name?: string;
  googleSubject?: string;
};

export type SeededConsoleUser = { userId: string; membershipId: string; email: string };

/**
 * Inserts `"user"` + Google `account` + `store_memberships` rows directly, bypassing OAuth entirely — the same
 * three tables `ownerBindingStatements` writes in production, so a seeded identity is indistinguishable from a
 * real one to `resolveActiveMembership` and gate 2 (`validateGoogleUserInfo`).
 */
export async function seedConsoleUser(input: SeedConsoleUserInput = {}): Promise<SeededConsoleUser> {
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const now = new Date().toISOString();
  const email = input.email ?? `console-${userId}@example.com`;
  const role = input.role ?? 'owner';
  const status = input.status ?? 'active';
  await env.DB.batch([
    env.DB
      .prepare('INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)')
      .bind(userId, input.name ?? 'Console Test User', email, now, now),
    env.DB
      .prepare("INSERT INTO account (id, accountId, providerId, userId, createdAt, updatedAt) VALUES (?, ?, 'google', ?, ?, ?)")
      .bind(crypto.randomUUID(), input.googleSubject ?? `google-${userId}`, userId, now, now),
    env.DB
      .prepare('INSERT INTO store_memberships (id, store_id, user_id, role, status, revoked_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(membershipId, STORE_ID, userId, role, status, status === 'revoked' ? now : null),
  ]);
  return { userId, membershipId, email };
}

export type ConsoleSession = { cookie: string; userId: string; membershipId: string };

/**
 * Seeds a console identity and mints a real, better-auth-signed session cookie for it via the official
 * `test-utils` plugin (decision #8: "one place that knows the better-auth cookie format"). The instance built here
 * uses the same `database` binding and `secret` as production `createAuth`, so the cookie is byte-for-byte what a
 * real OAuth sign-in would have produced — if better-auth ever changes its cookie format, only `A4`
 * (console-session.test.ts) goes red, not every phase-7/8/10 test that needs a signed-in session.
 */
export async function createConsoleSession(input: SeedConsoleUserInput = {}): Promise<ConsoleSession> {
  const seeded = await seedConsoleUser(input);
  const auth = betterAuth({ database: env.DB, secret: env.BETTER_AUTH_SECRET, plugins: [testUtils()] });
  const ctx = await auth.$context;
  const { headers } = await ctx.test.login({ userId: seeded.userId });
  const cookie = headers.get('cookie');
  if (cookie === null) throw new Error('better-auth test-utils did not produce a session cookie');
  return { cookie, userId: seeded.userId, membershipId: seeded.membershipId };
}

/**
 * Calls the worker with `Origin: CONSOLE_ORIGIN` set (so same-origin POST/PATCH/DELETE pass `consoleOriginAllowed`)
 * and, when `cookie` is given, attaches it as the request's `Cookie` header. The one helper every Console-route
 * integration test uses so nobody hand-builds request init or forgets the origin header (phases 6-10).
 */
export function consoleRequest(path: string, init: RequestInit & { cookie?: string } = {}): Promise<Response> {
  const { cookie, headers, ...rest } = init;
  const requestHeaders = new Headers(headers);
  requestHeaders.set('origin', env.CONSOLE_ORIGIN);
  if (cookie !== undefined) requestHeaders.set('cookie', cookie);
  return exports.default.fetch(new Request(`http://console.test${path}`, { ...rest, headers: requestHeaders }));
}
