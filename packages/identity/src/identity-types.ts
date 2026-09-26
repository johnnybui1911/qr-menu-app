// Shared vocabulary for Console auth & RBAC (D15, D20). Pure types only — no SQL, no imports (C1: identity is the
// dependency graph's floor).

export type StoreRole = 'owner' | 'staff';
export type MembershipStatus = 'active' | 'revoked';

/** Every action `evaluatePermission` knows about. Owner holds all of them (isKnownAction reads this set). */
export type PermissionAction =
  | 'menu:read'
  | 'menu:write'
  | 'menu:image:write'
  | 'menu:stock:toggle'
  | 'table:read'
  | 'table:write'
  | 'table:qr:export'
  | 'order:read'
  | 'order:prepare'
  | 'order:fulfill'
  | 'refund:request'
  | 'refund:decide'
  | 'report:read';

/** The resource an action is evaluated against. `customerId` is only meaningful for customer contexts. */
export type PermissionResource = {
  storeId: string;
  customerId?: string | null;
};

export type ConsoleIdentityContext = {
  kind: 'console';
  storeId: string;
  userId: string;
  membershipId: string;
  role: StoreRole;
  membershipStatus: MembershipStatus;
};

export type CustomerIdentityContext = {
  kind: 'customer';
  storeId: string;
  customerId: string;
};

export type PublicIdentityContext = { kind: 'public' };

/** The three surfaces of the app ever present one of these (scout-04 §4.1): Console, Storefront-with-order, or anonymous. */
export type IdentityContext = ConsoleIdentityContext | CustomerIdentityContext | PublicIdentityContext;

/**
 * trim + lowercase: the one normalization rule for every email comparison in Console auth — bootstrap match, gate 2
 * binding match, invitation target. Applying it inconsistently is exactly how T9c-style bypasses and permanent
 * lockouts happen (decision #9 of phase-06).
 */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/** Invitations are single-use and expire after one week (decision #9 / scout-04 §5.3). */
export const OWNER_INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
