import type { StoreRole } from './identity-types.ts';

export type GoogleOwnerProfile = {
  /** Already trimmed and lowercased by the caller (admission.ts normalizes before this point). */
  email: string;
  name: string;
  googleSubject: string;
};

export type OwnerBinding = {
  userId: string;
  accountRowId: string;
  membershipId: string;
  statements: D1PreparedStatement[];
};

/**
 * Builds the three INSERTs (user, account, membership) that admit a Google identity, guarded by `eligibilitySql`
 * embedded as `CASE WHEN <eligibilitySql> THEN ? ELSE NULL END` on the user row's PRIMARY KEY. D1 has no real
 * interactive transaction (F4): if the condition is false, the NULL id violates NOT NULL and the whole
 * `db.batch()` this is spliced into aborts atomically — nothing here, and nothing appended after it, is committed.
 *
 * `role` is a parameter (unlike the reference SOURCE, which hard-codes `'owner'`): the same builder serves both
 * bootstrap (always `'owner'`) and invitation redemption (`'owner'` or `'staff'`, from `owner_invitations.role`).
 * `storeId` is likewise always a parameter, never a module-level constant (scout-04 pitfall).
 */
export function ownerBindingStatements(
  db: D1Database,
  storeId: string,
  profile: GoogleOwnerProfile,
  role: StoreRole,
  eligibilitySql: string,
  eligibilityBinds: unknown[],
): OwnerBinding {
  const userId = crypto.randomUUID();
  const accountRowId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const now = new Date().toISOString();
  // Renamed to SCREAMING_CASE at the interpolation site (tests/node/sql-hygiene.test.ts): this is always a
  // trusted, code-authored SQL fragment supplied by admission.ts, never request data.
  const ELIGIBILITY_SQL = eligibilitySql;
  return {
    userId,
    accountRowId,
    membershipId,
    statements: [
      db
        .prepare(
          `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
           VALUES (CASE WHEN ${ELIGIBILITY_SQL} THEN ? ELSE NULL END, ?, ?, 1, ?, ?)`,
        )
        .bind(...eligibilityBinds, userId, profile.name, profile.email, now, now),
      db
        .prepare('INSERT INTO account (id, accountId, providerId, userId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(accountRowId, profile.googleSubject, 'google', userId, now, now),
      db
        .prepare("INSERT INTO store_memberships (id, store_id, user_id, role, status, revoked_at) VALUES (?, ?, ?, ?, 'active', NULL)")
        .bind(membershipId, storeId, userId, role),
    ],
  };
}
