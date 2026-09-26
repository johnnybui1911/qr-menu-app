import { constantTimeEqual, generateOpaqueToken, sha256Hex } from './token-digest.ts';
import { OWNER_INVITATION_TTL_MS } from './identity-types.ts';
import type { StoreRole } from './identity-types.ts';

// Domain separation string for the key-derivation step of invitationContextHmac — never changes, not a secret.
const INVITATION_CONTEXT_KEY_INFO = 'qr-menu:invitation-context:v1';
const INVITATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const MIN_INVITATION_HMAC_SECRET_LENGTH = 32;

async function hmacSha256(keyMaterial: BufferSource, message: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', keyMaterial, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
}

/**
 * The invitation token has two independent derivations (decision #6): `token_digest` (plain SHA-256, via
 * `sha256Hex`) is the DB lookup key; `context_hmac` is the only value that ever rides in OAuth server-side state,
 * keyed on `INVITATION_HMAC_SECRET` — a variable separate from `BETTER_AUTH_SECRET` so rotating the session secret
 * can never silently kill every pending invitation. The DB's `CHECK (context_hmac != token_digest)` enforces that
 * nobody accidentally uses one value for both jobs.
 */
export async function invitationContextHmac(secret: string, token: string): Promise<string> {
  const derivedKey = await hmacSha256(new TextEncoder().encode(secret), INVITATION_CONTEXT_KEY_INFO);
  const signature = await hmacSha256(derivedKey, token);
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Resolves the raw invitation token a client submits at sign-in initiation into the `context_hmac` to embed in
 * OAuth state — this is the only point a raw token is ever read back out of client input. Checks, in order: secret
 * length floor, token shape, a pending (not revoked, not consumed, not expired) row for this store, and a
 * constant-time re-derivation match against the row's stored `context_hmac` (defence in depth: the lookup already
 * happened by `token_digest`, so this also catches a corrupted or mismatched row rather than trusting the join alone).
 * Returns null on any failure — the plugin then simply proceeds without an invitation context, and gate 2 denies
 * the resulting session same as any other unrecognised Google account.
 */
export async function resolveInvitationOAuthContext(
  db: D1Database,
  secret: string,
  token: string,
  storeId: string,
  now: Date = new Date(),
): Promise<string | null> {
  if (secret.length < MIN_INVITATION_HMAC_SECRET_LENGTH) return null;
  if (!INVITATION_TOKEN_PATTERN.test(token)) return null;
  const tokenDigest = await sha256Hex(token);
  const row = await db
    .prepare(
      `SELECT context_hmac FROM owner_invitations
        WHERE store_id = ? AND token_digest = ? AND revoked_at IS NULL AND consumed_at IS NULL AND expires_at > ?`,
    )
    .bind(storeId, tokenDigest, now.toISOString())
    .first<{ context_hmac: string }>();
  if (!row) return null;
  const expected = await invitationContextHmac(secret, token);
  if (!constantTimeEqual(row.context_hmac, expected)) return null;
  return row.context_hmac;
}

export type CreateInvitationInput = {
  storeId: string;
  /** Must already be trim().toLowerCase()'d by the caller (route-level, before this ever touches SQL). */
  targetEmail: string;
  role: StoreRole;
  issuerMembershipId: string;
  issuerUserId: string;
  now?: Date;
};

export type PreparedInvitation = {
  invitationId: string;
  /** The raw token — callers place it in the response fragment and the invitation email; never store it. */
  token: string;
  expiresAt: string;
  statement: D1PreparedStatement;
};

/**
 * Builds (but does not run) the guarded INSERT for a new invitation. The guard — issuer must be an active Owner,
 * and no `"user"` row may already own the target email — is re-checked at write time via `CASE WHEN ... THEN ? ELSE
 * NULL END` on the PRIMARY KEY, the same guarded-batch technique as `ownerBindingStatements`; a stale prior read at
 * the route layer cannot smuggle through a since-invalidated issuer. The caller places this statement in the same
 * `db.batch()` as the invitation email's `enqueueEmailJobStatement` (decision #7) so a rejected invitation can
 * never leave an orphaned email job.
 */
export async function createInvitation(db: D1Database, secret: string, input: CreateInvitationInput): Promise<PreparedInvitation> {
  const token = generateOpaqueToken();
  const tokenDigest = await sha256Hex(token);
  const contextHmac = await invitationContextHmac(secret, token);
  const invitationId = crypto.randomUUID();
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + OWNER_INVITATION_TTL_MS).toISOString();
  const statement = db
    .prepare(
      `INSERT INTO owner_invitations (
         id, store_id, token_digest, context_hmac, target_email, role,
         issuer_membership_id, issuer_user_id, expires_at
       ) VALUES (
         CASE WHEN EXISTS (
           SELECT 1 FROM store_memberships
            WHERE id = ? AND user_id = ? AND store_id = ? AND role = 'owner' AND status = 'active'
         ) AND NOT EXISTS (
           SELECT 1 FROM "user" WHERE email = ?
         ) THEN ? ELSE NULL END,
         ?, ?, ?, ?, ?, ?, ?, ?
       )`,
    )
    .bind(
      input.issuerMembershipId,
      input.issuerUserId,
      input.storeId,
      input.targetEmail,
      invitationId,
      input.storeId,
      tokenDigest,
      contextHmac,
      input.targetEmail,
      input.role,
      input.issuerMembershipId,
      input.issuerUserId,
      expiresAt,
    );
  return { invitationId, token, expiresAt, statement };
}
