import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { STORE_ID } from '@qr/identity/store';
import { consoleRequest, createConsoleSession, seedConsoleUser } from '../support/console-session.ts';
import { resetDb } from '../support/test-env.ts';

beforeEach(resetDb);

describe('memberships (D15, D20)', () => {
  it('T27: a second active membership for the same user violates the partial unique index', async () => {
    const seeded = await seedConsoleUser({ role: 'owner', status: 'active' });
    await expect(
      env.DB
        .prepare("INSERT INTO store_memberships (id, store_id, user_id, role, status, revoked_at) VALUES (?, ?, ?, 'staff', 'active', NULL)")
        .bind(crypto.randomUUID(), STORE_ID, seeded.userId)
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed: store_memberships\.user_id/);
  });

  it('T27b: an Owner can revoke a staff member, cannot revoke themself, and a Staff caller is refused', async () => {
    const owner = await createConsoleSession({ role: 'owner', status: 'active' });
    const staff = await createConsoleSession({ role: 'staff', status: 'active' });

    const revoke = await consoleRequest(`/api/console/memberships/${staff.membershipId}/revoke`, { method: 'POST', cookie: owner.cookie });
    expect(revoke.status).toBe(200);
    const row = await env.DB
      .prepare('SELECT status, revoked_at FROM store_memberships WHERE id = ?')
      .bind(staff.membershipId)
      .first<{ status: string; revoked_at: string | null }>();
    expect(row!.status).toBe('revoked');
    expect(row!.revoked_at).not.toBeNull();

    // The revoked identity is immediately refused on its very next request — resolveActiveMembership re-reads
    // store_memberships every time, it never trusts anything cached in the cookie (D15).
    const afterRevoke = await consoleRequest('/api/console/session', { cookie: staff.cookie });
    expect(afterRevoke.status).toBe(403);

    const selfRevoke = await consoleRequest(`/api/console/memberships/${owner.membershipId}/revoke`, { method: 'POST', cookie: owner.cookie });
    expect(selfRevoke.status).toBe(400);
    await expect(selfRevoke.json()).resolves.toEqual({ error: 'cannot_revoke_self' });

    const anotherStaff = await createConsoleSession({ role: 'staff', status: 'active' });
    const deniedRevoke = await consoleRequest(`/api/console/memberships/${owner.membershipId}/revoke`, { method: 'POST', cookie: anotherStaff.cookie });
    expect(deniedRevoke.status).toBe(403);
    await expect(deniedRevoke.json()).resolves.toEqual({ error: 'issuer_not_owner' });
  });
});
