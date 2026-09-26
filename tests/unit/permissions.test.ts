import { describe, expect, it } from 'vitest';
import { evaluatePermission } from '@qr/identity/permissions';
import type { ConsoleIdentityContext } from '@qr/identity/identity-types';

const STORE_A = 'store-a';
const STORE_B = 'store-b';

function consoleContext(overrides: Partial<ConsoleIdentityContext> = {}): ConsoleIdentityContext {
  return { kind: 'console', storeId: STORE_A, userId: 'user-1', membershipId: 'membership-1', role: 'staff', membershipStatus: 'active', ...overrides };
}

describe('evaluatePermission (D15)', () => {
  it('T1: staff cannot write menu', () => {
    expect(evaluatePermission(consoleContext({ role: 'staff' }), 'menu:write', { storeId: STORE_A })).toBe(false);
  });

  it('T2: staff cannot decide a refund; owner can', () => {
    expect(evaluatePermission(consoleContext({ role: 'staff' }), 'refund:decide', { storeId: STORE_A })).toBe(false);
    expect(evaluatePermission(consoleContext({ role: 'owner' }), 'refund:decide', { storeId: STORE_A })).toBe(true);
  });

  it('T3: staff cannot read the revenue report', () => {
    expect(evaluatePermission(consoleContext({ role: 'staff' }), 'report:read', { storeId: STORE_A })).toBe(false);
  });

  it('T4: cross-store is always false, regardless of role or action', () => {
    const owner = consoleContext({ role: 'owner', storeId: STORE_A });
    expect(evaluatePermission(owner, 'menu:read', { storeId: STORE_B })).toBe(false);
    expect(evaluatePermission(owner, 'refund:decide', { storeId: STORE_B })).toBe(false);
  });

  it('T5: an unknown action is false, never throws', () => {
    expect(() => evaluatePermission(consoleContext({ role: 'owner' }), 'menu:nuke', { storeId: STORE_A })).not.toThrow();
    expect(evaluatePermission(consoleContext({ role: 'owner' }), 'menu:nuke', { storeId: STORE_A })).toBe(false);
  });

  it('T6: staff can work any order of the store — no per-order assignment in this MVP', () => {
    const staff = consoleContext({ role: 'staff' });
    for (const action of ['order:prepare', 'order:fulfill', 'refund:request'] as const) {
      expect(evaluatePermission(staff, action, { storeId: STORE_A })).toBe(true);
    }
    // order:assign / order:accept do not exist in this action set at all (phase-06 decision #3).
    expect(evaluatePermission(staff, 'order:assign', { storeId: STORE_A })).toBe(false);
    expect(evaluatePermission(staff, 'order:accept', { storeId: STORE_A })).toBe(false);
  });
});
