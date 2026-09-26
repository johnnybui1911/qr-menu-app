import type { RawGoogleProfile } from '@qr/identity/admission';
import { admitGoogleOwner } from '@qr/identity/admission';
import { normalizeEmail } from '@qr/identity/identity-types';
import { resolveInvitationOAuthContext } from '@qr/identity/invitations';
import { STORE_ID } from '@qr/identity/store';
import { addOAuthServerContext, createAuthMiddleware, getOAuthState } from 'better-auth/api';
import { google } from 'better-auth/social-providers';
import { betterAuth, type BetterAuthPlugin, type ValidateUserInfoSource } from 'better-auth';
import type { ConsoleAuthConfig } from './environment.ts';

/** Client-supplied field name inside `additionalData` on `POST /api/auth/sign-in/social` (untrusted input). */
export const OWNER_INVITATION_TOKEN_FIELD = 'invitationToken';
/** Server-trusted OAuth state field the plugin writes and the callback reads back (never client-supplied). */
const OWNER_INVITATION_CONTEXT_FIELD = 'invitationContext';

/**
 * Every rejection at gate 2 answers with this exact payload, never a more specific one (Requirements: "Mọi lý do
 * từ chối trả cùng một payload"). Distinguishing an unknown Google account from a revoked membership from an
 * expired invitation would let an attacker enumerate which addresses have a pending invite.
 */
const ACCESS_DENIED = { error: 'access_denied', errorDescription: 'This Google account cannot access the Console.' } as const;

type AdmitGoogleOwnerFn = typeof admitGoogleOwner;

/**
 * Gate 1 (Architecture diagram, scout-04 §7.9): admission failures here must never be treated as a rejection by
 * the caller — the reference SOURCE's own `getUserInfo` wrapper swallows them with `catch { return result; }`, and
 * this project keeps that behaviour on purpose, because gate 2 (`validateGoogleUserInfo`) is the only fail-closed
 * check (T11). `admit` is a test seam (same pattern as `order-write.ts`'s `generatePaymentReference`) so a suite
 * can force this path to throw without needing gate 2 to already be broken.
 */
export async function admitGoogleOwnerSafely(env: Env, profile: RawGoogleProfile, invitationContext: string | null, admit: AdmitGoogleOwnerFn = admitGoogleOwner): Promise<void> {
  try {
    await admit({ database: env.DB, storeId: STORE_ID, profile, initialOwnerEmail: env.INITIAL_OWNER_EMAIL, invitationContext });
  } catch {
    // Swallowed by design; see the doc comment above. Gate 2 is what actually protects the Console.
  }
}

/**
 * Returns a `GoogleOptions` config (not a pre-built provider) — this version of better-auth's `socialProviders`
 * field only accepts provider config, and calls `google(options)` itself internally. `getUserInfo` is the one
 * config field that lets a caller override the provider's own implementation; that closure keeps a reference to
 * the *native* Google provider (built once, purely to reuse its real `getUserInfo`), calls through to it
 * unchanged, and only adds the gate 1 admission side effect around it.
 */
function wrappedGoogleConfig(env: Env, clientId: string, clientSecret: string) {
  const nativeGoogle = google({ clientId, clientSecret, prompt: 'select_account', disableSignUp: true, disableIdTokenSignIn: true });
  return {
    clientId,
    clientSecret,
    prompt: 'select_account' as const,
    disableSignUp: true,
    disableIdTokenSignIn: true,
    getUserInfo: async (token: Parameters<typeof nativeGoogle.getUserInfo>[0]) => {
      const result = await nativeGoogle.getUserInfo(token);
      if (result) {
        const state = await getOAuthState<Record<string, unknown>>();
        const contextField = state?.serverContext?.[OWNER_INVITATION_CONTEXT_FIELD];
        const invitationContext = typeof contextField === 'string' ? contextField : null;
        await admitGoogleOwnerSafely(
          env,
          { email: result.user.email ?? '', name: result.user.name ?? '', googleSubject: result.data.sub, emailVerified: result.user.emailVerified },
          invitationContext,
        );
      }
      return result;
    },
  };
}

/**
 * Reads a raw invitation token out of the sign-in request body and, if it resolves to a pending invitation,
 * attaches its `context_hmac` to server-trusted OAuth state so the callback (gate 1) can read it back after the
 * Google redirect. The client body's `additionalData` is untrusted input (better-call's `OAuthState` doc comment);
 * a malformed or unresolvable token is silently ignored — this hook only ever narrows what gate 1 can admit.
 */
function ownerInvitationOAuthPlugin(env: Env, config: ConsoleAuthConfig): BetterAuthPlugin {
  return {
    id: 'owner-invitation-oauth',
    hooks: {
      before: [
        {
          matcher: (context) => context.path === '/sign-in/social',
          handler: createAuthMiddleware(async (ctx) => {
            const body = ctx.body as { additionalData?: Record<string, unknown> } | undefined;
            const rawToken = body?.additionalData?.[OWNER_INVITATION_TOKEN_FIELD];
            if (typeof rawToken !== 'string' || rawToken.length === 0) return;
            const contextHmac = await resolveInvitationOAuthContext(env.DB, config.invitationHmacSecret, rawToken, STORE_ID);
            if (contextHmac === null) return;
            await addOAuthServerContext({ [OWNER_INVITATION_CONTEXT_FIELD]: contextHmac });
          }),
        },
      ],
    },
  };
}

/**
 * Gate 2 (Architecture diagram) — the real fail-closed check. Runs on every OAuth sign-in, whether or not gate 1
 * admitted anything this time: `providerId==='google'`, `emailVerified===true`, a `sub` claim is present, and that
 * `sub` binds (via `account`) to a `"user"` with an active `store_memberships` row whose email matches the
 * incoming Google profile's email after normalization. Every failure returns the exact same `ACCESS_DENIED` payload
 * (Requirements) so no rejection reason ever leaks whether an invitation or membership exists for that address.
 */
export async function validateGoogleUserInfo(
  env: Env,
  user: { email?: string | null; emailVerified?: boolean } & Record<string, unknown>,
  source: ValidateUserInfoSource,
): Promise<typeof ACCESS_DENIED | undefined> {
  if (source.method !== 'oauth') return undefined;
  const subject = source.oauth?.profile?.['sub'];
  if (source.oauth?.providerId !== 'google' || user.emailVerified !== true || typeof user.email !== 'string' || typeof subject !== 'string' || subject.length === 0) {
    return ACCESS_DENIED;
  }
  const binding = await env.DB
    .prepare(
      `SELECT "user".email AS email
         FROM account
         JOIN "user" ON "user".id = account.userId
         JOIN store_memberships ON store_memberships.user_id = "user".id
        WHERE account.providerId = 'google' AND account.accountId = ? AND store_memberships.store_id = ? AND store_memberships.status = 'active'`,
    )
    .bind(subject, STORE_ID)
    .first<{ email: string }>();
  if (!binding || normalizeEmail(binding.email) !== normalizeEmail(user.email)) return ACCESS_DENIED;
  return undefined;
}

/**
 * `createAuth` must only ever be called after `readConsoleAuthConfig` has confirmed every secret it needs is
 * present (environment.ts) — it does not re-check them, so a caller that skips the config gate could hand
 * `betterAuth()` an empty Google client id/secret and a signing secret with no length floor.
 */
export function createAuth(env: Env, config: ConsoleAuthConfig) {
  return betterAuth({
    database: env.DB,
    baseURL: env.CONSOLE_ORIGIN,
    secret: config.betterAuthSecret,
    plugins: [ownerInvitationOAuthPlugin(env, config)],
    socialProviders: { google: wrappedGoogleConfig(env, config.googleClientId, config.googleClientSecret) },
    user: {
      validateUserInfo: ({ user, source }) => validateGoogleUserInfo(env, user, source),
    },
    account: {
      encryptOAuthTokens: true,
      accountLinking: { enabled: false },
    },
    trustedOrigins: [env.CONSOLE_ORIGIN],
    rateLimit: { enabled: true, storage: 'database' },
    advanced: {
      database: { validateSchema: true },
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
    },
  });
}
