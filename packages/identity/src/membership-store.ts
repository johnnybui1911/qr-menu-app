import type { MembershipStatus, StoreRole } from './identity-types.ts';

export type MembershipRow = { id: string; storeId: string; userId: string; role: StoreRole; status: MembershipStatus };

export type MembershipResolution =
  | { kind: 'absent' }
  | { kind: 'ambiguous' }
  | { kind: 'resolved'; membership: MembershipRow };

type ActiveMembershipRow = { id: string; store_id: string; user_id: string; role: StoreRole; status: MembershipStatus };

/**
 * The single place `role`/`membershipStatus` is derived for a Console request (D15): re-read from the database on
 * every call, never cached in the session. `LIMIT 2` surfaces a data-integrity bug as `ambiguous` instead of
 * silently picking one of two active memberships; `store_memberships_one_active_user` should make that unreachable
 * in the MVP, but the guard stays defensive rather than trusting the index alone.
 */
export async function resolveActiveMembership(db: D1Database, userId: string, storeId: string): Promise<MembershipResolution> {
  const { results } = await db
    .prepare(
      `SELECT id, store_id, user_id, role, status FROM store_memberships
        WHERE user_id = ? AND store_id = ? AND status = 'active'
        ORDER BY id LIMIT 2`,
    )
    .bind(userId, storeId)
    .all<ActiveMembershipRow>();
  if (results.length === 0) return { kind: 'absent' };
  if (results.length !== 1) return { kind: 'ambiguous' };
  const row = results[0]!;
  return { kind: 'resolved', membership: { id: row.id, storeId: row.store_id, userId: row.user_id, role: row.role, status: row.status } };
}
