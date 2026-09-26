// Fail-closed secret resolution for Console auth (C11, D20 Requirements). Every route that touches `/api/auth/*`
// or `/api/console/*` must call `readConsoleAuthConfig` before doing anything else and answer 503
// `auth_not_configured` on null — never construct `betterAuth()` with a missing or too-short secret.

export type ConsoleAuthConfig = {
  betterAuthSecret: string;
  googleClientId: string;
  googleClientSecret: string;
  invitationHmacSecret: string;
  /** Empty when unset. Only bootstrap is unavailable in that case (Requirements deliberately excludes this
   * variable from the 503 gate: existing owners and pending staff invitations must keep working). */
  initialOwnerEmail: string;
};

const MIN_BETTER_AUTH_SECRET_LENGTH = 32;

export function readConsoleAuthConfig(env: Env): ConsoleAuthConfig | null {
  const betterAuthSecret = env.BETTER_AUTH_SECRET?.trim() ?? '';
  const googleClientId = env.GOOGLE_CLIENT_ID?.trim() ?? '';
  const googleClientSecret = env.GOOGLE_CLIENT_SECRET?.trim() ?? '';
  const invitationHmacSecret = env.INVITATION_HMAC_SECRET?.trim() ?? '';
  if (betterAuthSecret.length < MIN_BETTER_AUTH_SECRET_LENGTH || googleClientId.length === 0 || googleClientSecret.length === 0 || invitationHmacSecret.length === 0) {
    return null;
  }
  return { betterAuthSecret, googleClientId, googleClientSecret, invitationHmacSecret, initialOwnerEmail: env.INITIAL_OWNER_EMAIL?.trim() ?? '' };
}
