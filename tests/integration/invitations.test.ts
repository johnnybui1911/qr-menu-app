import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { admitGoogleOwner } from '@qr/identity/admission';
import { createInvitation, invitationContextHmac } from '@qr/identity/invitations';
import { STORE_ID } from '@qr/identity/store';
import { enqueueEmailJobStatement } from '@qr/orders/email-outbox';
import { runEmailOutbox } from '../../apps/worker/src/order-email-service.ts';
import { consoleRequest, createConsoleSession, seedConsoleUser } from '../support/console-session.ts';
import { resetDb } from '../support/test-env.ts';

const INVITATION_HMAC_SECRET = env.INVITATION_HMAC_SECRET!;

async function seedInvitation(overrides: { role?: 'owner' | 'staff'; targetEmail?: string; now?: Date } = {}) {
  const issuer = await seedConsoleUser({ role: 'owner', status: 'active' });
  const prepared = await createInvitation(env.DB, INVITATION_HMAC_SECRET, {
    storeId: STORE_ID,
    targetEmail: overrides.targetEmail ?? 'invitee@example.com',
    role: overrides.role ?? 'staff',
    issuerMembershipId: issuer.membershipId,
    issuerUserId: issuer.userId,
    now: overrides.now,
  });
  await env.DB.batch([prepared.statement]);
  return prepared;
}

const membershipCountForEmail = async (email: string) =>
  (
    await env.DB
      .prepare('SELECT COUNT(*) AS n FROM store_memberships m JOIN "user" u ON u.id = m.user_id WHERE u.email = ?')
      .bind(email)
      .first<{ n: number }>()
  )!.n;

beforeEach(resetDb);

describe('invitations (D20, decision #6/#7/#9)', () => {
  it('T14: an expired token and a reused (already-consumed) token both deny with the identical payload, and create no membership', async () => {
    const expired = await seedInvitation({ targetEmail: 'expired@example.com', now: new Date(Date.now() - 8 * 24 * 3600 * 1000) });
    const expiredContextHmac = await invitationContextHmac(INVITATION_HMAC_SECRET, expired.token);
    const expiredResult = await admitGoogleOwner({
      database: env.DB,
      storeId: STORE_ID,
      profile: { email: 'expired@example.com', name: 'Expired Invitee', googleSubject: crypto.randomUUID(), emailVerified: true },
      initialOwnerEmail: undefined,
      invitationContext: expiredContextHmac,
    });

    const reused = await seedInvitation({ targetEmail: 'reused@example.com' });
    const reusedContextHmac = await invitationContextHmac(INVITATION_HMAC_SECRET, reused.token);
    const firstRedeem = { email: 'reused@example.com', name: 'Reused Invitee', googleSubject: crypto.randomUUID(), emailVerified: true };
    await admitGoogleOwner({ database: env.DB, storeId: STORE_ID, profile: firstRedeem, initialOwnerEmail: undefined, invitationContext: reusedContextHmac });
    const reusedResult = await admitGoogleOwner({
      database: env.DB,
      storeId: STORE_ID,
      profile: { ...firstRedeem, googleSubject: crypto.randomUUID() },
      initialOwnerEmail: undefined,
      invitationContext: reusedContextHmac,
    });

    expect(expiredResult).toEqual({ kind: 'denied' });
    expect(reusedResult).toEqual({ kind: 'denied' });
    expect(expiredResult).toEqual(reusedResult);
    expect(await membershipCountForEmail('expired@example.com')).toBe(0);
  });

  it('T15: redeeming an invitation is one-time — the second redemption with the same token is denied and creates no second membership', async () => {
    const invitation = await seedInvitation({ targetEmail: 'onetime@example.com' });
    const contextHmac = await invitationContextHmac(INVITATION_HMAC_SECRET, invitation.token);
    const profile = { email: 'onetime@example.com', name: 'Onetime', googleSubject: crypto.randomUUID(), emailVerified: true };

    const first = await admitGoogleOwner({ database: env.DB, storeId: STORE_ID, profile, initialOwnerEmail: undefined, invitationContext: contextHmac });
    expect(first).toEqual({ kind: 'admitted' });
    expect(await membershipCountForEmail('onetime@example.com')).toBe(1);

    const second = await admitGoogleOwner({
      database: env.DB,
      storeId: STORE_ID,
      profile: { ...profile, googleSubject: crypto.randomUUID() },
      initialOwnerEmail: undefined,
      invitationContext: contextHmac,
    });
    expect(second).toEqual({ kind: 'denied' });
    expect(await membershipCountForEmail('onetime@example.com')).toBe(1);

    const consumedAt = await env.DB.prepare('SELECT consumed_at FROM owner_invitations WHERE id = ?').bind(invitation.invitationId).first<{ consumed_at: string | null }>();
    expect(consumedAt!.consumed_at).not.toBeNull();
  });

  it('T16: an invitation with role=staff redeems into a staff membership, not owner', async () => {
    const invitation = await seedInvitation({ targetEmail: 'staffer@example.com', role: 'staff' });
    const contextHmac = await invitationContextHmac(INVITATION_HMAC_SECRET, invitation.token);
    await admitGoogleOwner({
      database: env.DB,
      storeId: STORE_ID,
      profile: { email: 'staffer@example.com', name: 'Staffer', googleSubject: crypto.randomUUID(), emailVerified: true },
      initialOwnerEmail: undefined,
      invitationContext: contextHmac,
    });
    const row = await env.DB
      .prepare('SELECT role FROM store_memberships m JOIN "user" u ON u.id = m.user_id WHERE u.email = ?')
      .bind('staffer@example.com')
      .first<{ role: string }>();
    expect(row!.role).toBe('staff');
  });

  it('T17: cannot invite an email that already belongs to a user — the guarded INSERT fails, no row is created', async () => {
    const existing = await seedConsoleUser({ email: 'already-a-user@example.com' });
    const owner = await seedConsoleUser({ role: 'owner', status: 'active' });
    const prepared = await createInvitation(env.DB, INVITATION_HMAC_SECRET, {
      storeId: STORE_ID,
      targetEmail: existing.email,
      role: 'staff',
      issuerMembershipId: owner.membershipId,
      issuerUserId: owner.userId,
    });
    await expect(env.DB.batch([prepared.statement])).rejects.toThrow(/NOT NULL constraint failed: owner_invitations\.id/);
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM owner_invitations').first<{ n: number }>();
    expect(count!.n).toBe(0);
  });

  it('T18: all three invitation routes require an active Owner issuer, with the same rejection payload', async () => {
    const owner = await createConsoleSession({ role: 'owner', status: 'active' });
    const revokedOwner = await createConsoleSession({ role: 'owner', status: 'revoked' });
    const staff = await createConsoleSession({ role: 'staff', status: 'active' });
    const ISSUER_NOT_OWNER = { error: 'issuer_not_owner' };

    for (const session of [staff, revokedOwner]) {
      const post = await consoleRequest('/api/console/invitations', {
        method: 'POST',
        cookie: session.cookie,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetEmail: `denied-${session.userId}@example.com`, role: 'staff' }),
      });
      expect(post.status).toBe(403);
      await expect(post.json()).resolves.toEqual(ISSUER_NOT_OWNER);

      const list = await consoleRequest('/api/console/invitations', { cookie: session.cookie });
      expect(list.status).toBe(403);
      await expect(list.json()).resolves.toEqual(ISSUER_NOT_OWNER);

      const revoke = await consoleRequest('/api/console/invitations/nonexistent/revoke', { method: 'POST', cookie: session.cookie });
      expect(revoke.status).toBe(403);
      await expect(revoke.json()).resolves.toEqual(ISSUER_NOT_OWNER);
    }

    const created = await consoleRequest('/api/console/invitations', {
      method: 'POST',
      cookie: owner.cookie,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetEmail: 'ok@example.com', role: 'staff' }),
    });
    expect(created.status).toBe(201);
    const list = await consoleRequest('/api/console/invitations', { cookie: owner.cookie });
    expect(list.status).toBe(200);
    const { id } = (await created.json()) as { id: string };
    const revoke = await consoleRequest(`/api/console/invitations/${id}/revoke`, { method: 'POST', cookie: owner.cookie });
    expect(revoke.status).toBe(200);
  });

  it('T18b: target email is normalized (trim + lowercase); a malformed email is rejected before it reaches SQL', async () => {
    const owner = await createConsoleSession({ role: 'owner', status: 'active' });
    const created = await consoleRequest('/api/console/invitations', {
      method: 'POST',
      cookie: owner.cookie,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetEmail: ' Chi@Gmail.com ', role: 'staff' }),
    });
    expect(created.status).toBe(201);
    const row = await env.DB.prepare('SELECT target_email FROM owner_invitations WHERE target_email = ?').bind('chi@gmail.com').first();
    expect(row).not.toBeNull();

    const invalid = await consoleRequest('/api/console/invitations', {
      method: 'POST',
      cookie: owner.cookie,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetEmail: 'không-phải-email', role: 'staff' }),
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({ error: 'invalid_email' });
  });

  it('T19: context_hmac equal to token_digest aborts the INSERT (CHECK constraint)', async () => {
    const owner = await seedConsoleUser({ role: 'owner', status: 'active' });
    const digest = 'a'.repeat(64);
    await expect(
      env.DB
        .prepare(
          `INSERT INTO owner_invitations (id, store_id, token_digest, context_hmac, target_email, role, issuer_membership_id, issuer_user_id, expires_at)
           VALUES (?, ?, ?, ?, 'same@example.com', 'staff', ?, ?, ?)`,
        )
        .bind(crypto.randomUUID(), STORE_ID, digest, digest, owner.membershipId, owner.userId, new Date(Date.now() + 60_000).toISOString())
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it('T20: the invitation-creation response carries Referrer-Policy: no-referrer and the token only in the URL fragment', async () => {
    const owner = await createConsoleSession({ role: 'owner', status: 'active' });
    const response = await consoleRequest('/api/console/invitations', {
      method: 'POST',
      cookie: owner.cookie,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetEmail: 'fragment@example.com', role: 'staff' }),
    });
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    const { invitationUrl } = (await response.json()) as { invitationUrl: string };
    const url = new URL(invitationUrl);
    expect(url.search).toBe('');
    expect(url.hash).toMatch(/^#invite=/);
  });

  it('T20b: the raw token in the outbox payload is gone once its email job finishes (sent or retired) — owner_invitations never stores it raw', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    const owner = await createConsoleSession({ role: 'owner', status: 'active' });
    const created = await consoleRequest('/api/console/invitations', {
      method: 'POST',
      cookie: owner.cookie,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetEmail: 'sent@example.com', role: 'staff' }),
    });
    const { id: invitationId } = (await created.json()) as { id: string };
    const jobBefore = await env.DB.prepare("SELECT payload_json FROM order_email_jobs WHERE dedupe_key = ?").bind(`invite:${invitationId}`).first<{ payload_json: string | null }>();
    expect(jobBefore!.payload_json).toContain('sent@example.com');

    await runEmailOutbox(env, new Date(Date.now() + 1000));
    const jobAfter = await env.DB.prepare('SELECT payload_json, status FROM order_email_jobs WHERE dedupe_key = ?').bind(`invite:${invitationId}`).first<{ payload_json: string | null; status: string }>();
    expect(jobAfter!.status).toBe('sent');
    expect(jobAfter!.payload_json).toBeNull();

    const invitationRow = await env.DB.prepare('SELECT token_digest, context_hmac FROM owner_invitations WHERE id = ?').bind(invitationId).first<{ token_digest: string; context_hmac: string }>();
    // owner_invitations only ever stores digests (64 lowercase hex chars), never the raw base64url token.
    expect(invitationRow!.token_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(invitationRow!.context_hmac).toMatch(/^[0-9a-f]{64}$/);
    vi.restoreAllMocks();
  });

  it('A2: the invitation email job is enqueued in the same batch as the invitation — a rejected invitation leaves no orphaned job', async () => {
    const owner = await seedConsoleUser({ role: 'owner', status: 'active' });
    const alreadyUser = await seedConsoleUser({ email: 'taken@example.com' });
    const rejected = await createInvitation(env.DB, INVITATION_HMAC_SECRET, {
      storeId: STORE_ID,
      targetEmail: alreadyUser.email,
      role: 'staff',
      issuerMembershipId: owner.membershipId,
      issuerUserId: owner.userId,
    });
    const rejectedJob = enqueueEmailJobStatement(env.DB, {
      storeId: STORE_ID,
      kind: 'invitation',
      orderId: null,
      dedupeKey: `invite:${rejected.invitationId}`,
      payload: { targetEmail: alreadyUser.email, role: 'staff', token: rejected.token },
    });
    await expect(env.DB.batch([rejected.statement, rejectedJob])).rejects.toThrow();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM order_email_jobs WHERE kind = 'invitation'").first<{ n: number }>())!.n).toBe(0);

    const accepted = await createInvitation(env.DB, INVITATION_HMAC_SECRET, {
      storeId: STORE_ID,
      targetEmail: 'fresh@example.com',
      role: 'staff',
      issuerMembershipId: owner.membershipId,
      issuerUserId: owner.userId,
    });
    const acceptedJob = enqueueEmailJobStatement(env.DB, {
      storeId: STORE_ID,
      kind: 'invitation',
      orderId: null,
      dedupeKey: `invite:${accepted.invitationId}`,
      payload: { targetEmail: 'fresh@example.com', role: 'staff', token: accepted.token },
    });
    await env.DB.batch([accepted.statement, acceptedJob]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM order_email_jobs WHERE kind = 'invitation'").first<{ n: number }>())!.n).toBe(1);
  });
});
