import type { IdentityContext, PermissionAction, PermissionResource } from './identity-types.ts';

// MVP simplification versus scout-04: no per-order assignment concept. PRD §2.2 lets any active staff member of the
// store pick up any order of that store ("Nhận đơn & Chế biến" == order:prepare); there is no `order:assign` /
// `order:accept` pair, because this project has no notion of an order being assigned to one particular staffer.

/** Owner has every action; this table doubles as the "is this action known at all" check (isKnownAction). */
const OWNER_ACTIONS: Record<PermissionAction, true> = {
  'menu:read': true,
  'menu:write': true,
  'menu:image:write': true,
  'menu:stock:toggle': true,
  'table:read': true,
  'table:write': true,
  'table:qr:export': true,
  'order:read': true,
  'order:prepare': true,
  'order:fulfill': true,
  'refund:request': true,
  'refund:decide': true,
  'report:read': true,
};

/** Staff: reads menu/tables, works any order of the store, may request (not decide) a refund. No report access. */
const STAFF_ACTIONS: Partial<Record<PermissionAction, true>> = {
  'menu:read': true,
  'table:read': true,
  'order:read': true,
  'order:prepare': true,
  'order:fulfill': true,
  'refund:request': true,
};

/** A customer only ever acts on their own order via the Secret Link. */
const CUSTOMER_ACTIONS: Partial<Record<PermissionAction, true>> = { 'order:read': true, 'refund:request': true };

function isKnownAction(action: string): action is PermissionAction {
  return Object.hasOwn(OWNER_ACTIONS, action);
}

/**
 * The single permission decision function (D15). Order of checks: unknown action, public identity, cross-store,
 * customer, membership status, then role — matching the phase-06 plan's fixed evaluation order.
 */
export function evaluatePermission(context: IdentityContext, action: string, resource: PermissionResource): boolean {
  if (!isKnownAction(action)) return false;
  if (context.kind === 'public') return false;
  if (context.storeId !== resource.storeId) return false;
  if (context.kind === 'customer') return resource.customerId === context.customerId && Object.hasOwn(CUSTOMER_ACTIONS, action);
  if (context.membershipStatus !== 'active') return false;
  // isKnownAction already proved `action` is a key of OWNER_ACTIONS, so an owner needs no further lookup.
  if (context.role === 'owner') return true;
  return Object.hasOwn(STAFF_ACTIONS, action);
}
