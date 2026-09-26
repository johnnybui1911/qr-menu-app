import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { admitGoogleOwnerSafely, validateGoogleUserInfo } from '../../apps/worker/src/auth.ts';
import { seedConsoleUser } from '../support/console-session.ts';
import { resetDb } from '../support/test-env.ts';

const ACCESS_DENIED = { error: 'access_denied', errorDescription: 'This Google account cannot access the Console.' };

function oauthSource(sub: string) {
  return { action: 'sign-in' as const, method: 'oauth' as const, oauth: { providerId: 'google', profile: { sub } } };
}

beforeEach(resetDb);

describe('gate 2 — validateGoogleUserInfo (D15, D20)', () => {
  it('T10: a random Google user (no membership, no invitation, no bootstrap match) is denied', async () => {
    const result = await validateGoogleUserInfo(env, { email: 'stranger@example.com', emailVerified: true }, oauthSource('random-subject'));
    expect(result).toEqual(ACCESS_DENIED);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM "session"').first<{ n: number }>())!.n).toBe(0);
  });

  it('T11: gate 2 still blocks even when gate 1 (admitGoogleOwner) throws', async () => {
    await expect(
      admitGoogleOwnerSafely(env, { email: 'attacker@example.com', name: 'Attacker', googleSubject: 'attacker-subject', emailVerified: true }, null, async () => {
        throw new Error('boom: admission exploded');
      }),
    ).resolves.toBeUndefined();

    const result = await validateGoogleUserInfo(env, { email: 'attacker@example.com', emailVerified: true }, oauthSource('attacker-subject'));
    expect(result).toEqual(ACCESS_DENIED);
  });

  it('T12: a revoked membership is denied with the exact same payload as an unknown user', async () => {
    const seeded = await seedConsoleUser({ status: 'revoked', googleSubject: 'revoked-subject', email: 'revoked@example.com' });
    const result = await validateGoogleUserInfo(env, { email: seeded.email, emailVerified: true }, oauthSource('revoked-subject'));
    expect(result).toEqual(ACCESS_DENIED);
  });

  it('T13: a subject bound to a different email than the incoming profile is denied with the same payload', async () => {
    await seedConsoleUser({ googleSubject: 'mismatch-subject', email: 'bound@example.com' });
    const result = await validateGoogleUserInfo(env, { email: 'someone-else@example.com', emailVerified: true }, oauthSource('mismatch-subject'));
    expect(result).toEqual(ACCESS_DENIED);
  });

  it('gate 2 rejects emailVerified=false even against an otherwise valid, matching binding', async () => {
    const seeded = await seedConsoleUser({ status: 'active', googleSubject: 'unverified-subject', email: 'unverified@example.com' });
    const result = await validateGoogleUserInfo(env, { email: seeded.email, emailVerified: false }, oauthSource('unverified-subject'));
    expect(result).toEqual(ACCESS_DENIED);
  });
});
