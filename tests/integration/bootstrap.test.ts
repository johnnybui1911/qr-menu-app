import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { admitGoogleOwner, type RawGoogleProfile } from '@qr/identity/admission';
import { STORE_ID } from '@qr/identity/store';
import { resetDb } from '../support/test-env.ts';

const INITIAL_OWNER_EMAIL = 'owner@example.com';

function profile(overrides: Partial<RawGoogleProfile> = {}): RawGoogleProfile {
  return { email: INITIAL_OWNER_EMAIL, name: 'Owner', googleSubject: crypto.randomUUID(), emailVerified: true, ...overrides };
}

const bootstrap = (input: Partial<RawGoogleProfile> = {}, initialOwnerEmail: string | undefined = INITIAL_OWNER_EMAIL) =>
  admitGoogleOwner({ database: env.DB, storeId: STORE_ID, profile: profile(input), initialOwnerEmail, invitationContext: null });

const claimCount = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM store_bootstrap_claims').first<{ n: number }>())!.n;
const membershipCount = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM store_memberships WHERE role = 'owner'").first<{ n: number }>())!.n;

beforeEach(resetDb);

describe('bootstrap (D20)', () => {
  it('T7: a second bootstrap attempt is denied; the claim stays a single row', async () => {
    await expect(bootstrap()).resolves.toEqual({ kind: 'admitted' });
    expect(await claimCount()).toBe(1);

    await expect(bootstrap()).resolves.toEqual({ kind: 'denied' });
    expect(await claimCount()).toBe(1);
  });

  it('T8: two concurrent callbacks racing the same store yield exactly one admitted, one denied, one claim, one membership', async () => {
    const results = await Promise.all([bootstrap(), bootstrap()]);
    expect(results.filter((r) => r.kind === 'admitted')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'denied')).toHaveLength(1);
    expect(await claimCount()).toBe(1);
    expect(await membershipCount()).toBe(1);
  });

  it('T9: an email that does not match INITIAL_OWNER_EMAIL is denied', async () => {
    await expect(bootstrap({ email: 'someone-else@example.com' })).resolves.toEqual({ kind: 'denied' });
    expect(await claimCount()).toBe(0);
  });

  it('T9b: an unverified email is denied even when it matches INITIAL_OWNER_EMAIL — the real owner can still bootstrap afterwards', async () => {
    await expect(bootstrap({ emailVerified: false })).resolves.toEqual({ kind: 'denied' });
    expect(await claimCount()).toBe(0);
    expect(await membershipCount()).toBe(0);

    await expect(bootstrap({ emailVerified: true })).resolves.toEqual({ kind: 'admitted' });
    expect(await claimCount()).toBe(1);
  });

  it('T9c: INITIAL_OWNER_EMAIL with surrounding whitespace/newline and different case still bootstraps a lowercase profile email', async () => {
    await expect(bootstrap({ email: 'owner@example.com' }, '  Owner@Example.com\n')).resolves.toEqual({ kind: 'admitted' });
    expect(await claimCount()).toBe(1);
  });
});
