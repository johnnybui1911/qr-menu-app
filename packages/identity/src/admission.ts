import { ownerBindingStatements, type GoogleOwnerProfile } from './google-identity.ts';
import { normalizeEmail } from './identity-types.ts';
import type { StoreRole } from './identity-types.ts';

/** The raw profile Google hands back through the OAuth callback, before gate 1's admission checks run. */
export type RawGoogleProfile = {
  email: string;
  name: string;
  googleSubject: string;
  emailVerified: boolean;
};

export type OwnerAdmissionResult = { kind: 'admitted' } | { kind: 'denied' };

export type AdmitGoogleOwnerInput = {
  database: D1Database;
  storeId: string;
  profile: RawGoogleProfile;
  /** Worker secret; undefined when unset (fail closed — bootstrap is simply unreachable, not a 500). */
  initialOwnerEmail: string | undefined;
  /** The `context_hmac` resolved from OAuth state by the sign-in plugin, or null when this login carries no invite. */
  invitationContext: string | null;
  now?: Date;
};

/**
 * Verified + normalized, or null when the profile cannot admit anything. Gate 1 must reject an unverified email
 * here, before touching any one-shot resource (Requirements): an attacker who wins a race with an unverified
 * address matching `INITIAL_OWNER_EMAIL`, or targeting a pending invitation, would otherwise permanently burn the
 * bootstrap claim or the invitation before the real recipient arrives — even though gate 2 (`validateUserInfo`)
 * would still deny *their* resulting session, the one-shot resource is already spent (T9b).
 */
function admissibleProfile(profile: RawGoogleProfile): GoogleOwnerProfile | null {
  if (profile.emailVerified !== true) return null;
  return { email: normalizeEmail(profile.email), name: profile.name, googleSubject: profile.googleSubject };
}

const BOOTSTRAP_ELIGIBILITY_SQL = 'EXISTS (SELECT 1 FROM stores WHERE id = ?) AND NOT EXISTS (SELECT 1 FROM store_bootstrap_claims WHERE store_id = ?)';

/**
 * One-shot Owner bootstrap (D20). Two independent race guards: the `NOT EXISTS` clause embedded in the guarded
 * INSERT, and `store_bootstrap_claims.store_id` being a PRIMARY KEY — a second concurrent claim violates the key
 * and aborts the whole batch (F4: D1 has no interactive transaction, so this is the only way two callbacks racing
 * the same store can never both win).
 */
async function claimBootstrap(db: D1Database, storeId: string, profile: GoogleOwnerProfile): Promise<OwnerAdmissionResult> {
  const binding = ownerBindingStatements(db, storeId, profile, 'owner', BOOTSTRAP_ELIGIBILITY_SQL, [storeId, storeId]);
  try {
    await db.batch([
      ...binding.statements,
      db
        .prepare(
          `INSERT INTO store_bootstrap_claims (store_id, membership_id, user_id)
           VALUES (
             CASE WHEN EXISTS (
               SELECT 1 FROM store_memberships WHERE id = ? AND user_id = ? AND store_id = ? AND role = 'owner' AND status = 'active'
             ) THEN ? ELSE NULL END,
             ?, ?
           )`,
        )
        .bind(binding.membershipId, binding.userId, storeId, storeId, binding.membershipId, binding.userId),
    ]);
  } catch {
    return { kind: 'denied' };
  }
  return { kind: 'admitted' };
}

/**
 * Single-use invitation redemption. `role` is read up front by a plain SELECT purely to choose which literal to
 * bind into the guarded batch — it is not itself the guard. The guard is the eligibility condition re-evaluated
 * inside the same batch (pending, unexpired, email match) plus the paired UPDATE whose `consumed_at` collapses to
 * NULL on any mismatch, which violates `owner_invitations_state` and aborts everything (C2, D20). A concurrent
 * redeemer that changed the row between the SELECT and this batch is caught by that re-evaluation, not by the SELECT.
 */
async function redeemInvitation(db: D1Database, storeId: string, profile: GoogleOwnerProfile, contextHmac: string, now: Date): Promise<OwnerAdmissionResult> {
  const invitation = await db
    .prepare('SELECT role FROM owner_invitations WHERE context_hmac = ? AND store_id = ?')
    .bind(contextHmac, storeId)
    .first<{ role: StoreRole }>();
  if (!invitation) return { kind: 'denied' };

  const nowIso = now.toISOString();
  const binding = ownerBindingStatements(
    db,
    storeId,
    profile,
    invitation.role,
    `EXISTS (SELECT 1 FROM stores WHERE id = ?)
     AND EXISTS (
       SELECT 1 FROM owner_invitations
        WHERE context_hmac = ? AND store_id = ? AND target_email = ?
          AND revoked_at IS NULL AND consumed_at IS NULL AND expires_at > ?
     )`,
    [storeId, contextHmac, storeId, profile.email, nowIso],
  );
  try {
    await db.batch([
      ...binding.statements,
      db
        .prepare(
          `UPDATE owner_invitations
              SET consumed_at = CASE
                    WHEN revoked_at IS NULL AND consumed_at IS NULL
                     AND target_email = ? AND expires_at > ? AND role = ?
                     AND EXISTS (
                       SELECT 1 FROM store_memberships
                        WHERE id = ? AND user_id = ? AND store_id = ? AND role = ? AND status = 'active'
                     )
                    THEN ? ELSE NULL END,
                  consumed_membership_id = ?,
                  consumed_user_id = ?
            WHERE context_hmac = ? AND store_id = ?`,
        )
        .bind(
          profile.email,
          nowIso,
          invitation.role,
          binding.membershipId,
          binding.userId,
          storeId,
          invitation.role,
          nowIso,
          binding.membershipId,
          binding.userId,
          contextHmac,
          storeId,
        ),
    ]);
  } catch {
    return { kind: 'denied' };
  }
  return { kind: 'admitted' };
}

/**
 * Gate 1 (Architecture diagram): creates authority when the callback matches bootstrap or a valid invitation.
 * Errors thrown from here must never be treated as a denial by the caller — the reference SOURCE's own admission
 * hook swallows them (scout-04 §7.9), which is exactly why gate 2 (`validateUserInfo`) is the real fail-closed
 * check (T11). This function itself never throws in normal operation: `claimBootstrap`/`redeemInvitation` already
 * catch every `db.batch()` failure.
 */
export async function admitGoogleOwner(input: AdmitGoogleOwnerInput): Promise<OwnerAdmissionResult> {
  const profile = admissibleProfile(input.profile);
  if (profile === null) return { kind: 'denied' };

  if (input.invitationContext !== null) {
    return redeemInvitation(input.database, input.storeId, profile, input.invitationContext, input.now ?? new Date());
  }

  const initialOwnerEmail = typeof input.initialOwnerEmail === 'string' && input.initialOwnerEmail.length > 0 ? normalizeEmail(input.initialOwnerEmail) : null;
  if (initialOwnerEmail === null || initialOwnerEmail !== profile.email) return { kind: 'denied' };
  return claimBootstrap(input.database, input.storeId, profile);
}
