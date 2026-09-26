import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../../apps/worker/src/index.ts';
import { consoleRequest, createConsoleSession } from '../support/console-session.ts';
import { resetDb } from '../support/test-env.ts';

/** Only one session exists per test at this point, so expiring every row is sufficient and avoids needing to
 * recover the raw token from a signed cookie value. */
async function expireAllSessions(): Promise<void> {
  await env.DB.prepare('UPDATE "session" SET expiresAt = ?').bind(new Date(Date.now() - 60_000).toISOString()).run();
}

beforeEach(resetDb);

describe('console session & CSRF (D15, scout-04 §7.2/§7.7)', () => {
  it('T21: a revoked membership answers 403 without clearing the cookie; an expired session answers 401 and clears it', async () => {
    const revokedOwner = await createConsoleSession({ role: 'owner', status: 'revoked' });
    const revokedResponse = await consoleRequest('/api/console/session', { cookie: revokedOwner.cookie });
    expect(revokedResponse.status).toBe(403);
    // The session itself is still perfectly valid, so better-auth has nothing to roll — no Set-Cookie at all is
    // just as much "cookie kept" as an unchanged one would be; either way it must not carry Max-Age=0.
    expect(revokedResponse.headers.get('set-cookie') ?? '').not.toMatch(/Max-Age=0/i);

    const active = await createConsoleSession({ role: 'owner', status: 'active' });
    await expireAllSessions();
    const expiredResponse = await consoleRequest('/api/console/session', { cookie: active.cookie });
    expect(expiredResponse.status).toBe(401);
    expect(expiredResponse.headers.get('set-cookie')).toMatch(/Max-Age=0/i);
  });

  it('T22: the Max-Age=0 clearing cookie getSession produces for an expired session is forwarded on every route\'s error branch, not only /api/console/session', async () => {
    const active = await createConsoleSession({ role: 'owner', status: 'active' });
    await expireAllSessions();

    const sessionResponse = await consoleRequest('/api/console/session', { cookie: active.cookie });
    expect(sessionResponse.status).toBe(401);
    expect(sessionResponse.headers.get('set-cookie')).toMatch(/Max-Age=0/i);

    // A completely different route dispatcher (withConsoleSession, not withConsoleContext) must forward the same
    // getSession-produced cookie on its own error branch (scout-04 §7.7: this is not special-cased per route).
    const invitationResponse = await consoleRequest('/api/console/invitations', { cookie: active.cookie });
    expect(invitationResponse.status).toBe(401);
    expect(invitationResponse.headers.get('set-cookie')).toMatch(/Max-Age=0/i);
  });

  it('T23: a POST with no Origin, Origin: null, a foreign Origin, or Sec-Fetch-Site: cross-site is rejected', async () => {
    const path = '/api/console/invitations';
    const withoutOrigin = await exports.default.fetch(new Request(`http://console.test${path}`, { method: 'POST' }));
    expect(withoutOrigin.status).toBe(403);

    const nullOrigin = await exports.default.fetch(new Request(`http://console.test${path}`, { method: 'POST', headers: { origin: 'null' } }));
    expect(nullOrigin.status).toBe(403);

    const foreignOrigin = await exports.default.fetch(new Request(`http://console.test${path}`, { method: 'POST', headers: { origin: 'https://evil.example' } }));
    expect(foreignOrigin.status).toBe(403);

    const crossSite = await exports.default.fetch(
      new Request(`http://console.test${path}`, { method: 'POST', headers: { origin: env.CONSOLE_ORIGIN, 'sec-fetch-site': 'cross-site' } }),
    );
    expect(crossSite.status).toBe(403);
  });

  it('T24: an unknown console route answers 404 before any session is ever read', async () => {
    const response = await consoleRequest('/api/console/nope');
    expect(response.status).toBe(404);
    // No Set-Cookie at all is the observable proxy for "getSession was never invoked": the 404 branch returns
    // before resolveConsoleSession/resolveConsoleRequestContext ever runs.
    expect(response.headers.has('set-cookie')).toBe(false);
  });

  it('T25: /api/auth/* responses carry Cache-Control: no-store, Referrer-Policy: no-referrer, and no Content-Length', async () => {
    const response = await consoleRequest('/api/auth/sign-in/social', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'google', callbackURL: '/console' }),
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.has('content-length')).toBe(false);
  });

  it('T26: missing Google config answers 503 auth_not_configured, never 500, and never admits a sign-in', async () => {
    const ctx = createExecutionContext();
    const request = new Request('http://console.test/api/auth/sign-in/social', {
      method: 'POST',
      headers: { origin: env.CONSOLE_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'google', callbackURL: '/console' }),
    });
    const response = await worker.fetch!(request as Request<unknown, IncomingRequestCfProperties>, { ...env, GOOGLE_CLIENT_ID: '' }, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'auth_not_configured' });
  });

  it('A1: /api/console/session returns allowedActions matching the role — Owner gets refund:decide and report:read, Staff gets neither', async () => {
    const owner = await createConsoleSession({ role: 'owner', status: 'active' });
    const ownerResponse = await consoleRequest('/api/console/session', { cookie: owner.cookie });
    expect(ownerResponse.status).toBe(200);
    const ownerBody = (await ownerResponse.json()) as { role: string; allowedActions: string[] };
    expect(ownerBody.role).toBe('owner');
    expect(ownerBody.allowedActions).toEqual(expect.arrayContaining(['refund:decide', 'report:read']));

    const staff = await createConsoleSession({ role: 'staff', status: 'active' });
    const staffResponse = await consoleRequest('/api/console/session', { cookie: staff.cookie });
    const staffBody = (await staffResponse.json()) as { role: string; allowedActions: string[] };
    expect(staffBody.role).toBe('staff');
    expect(staffBody.allowedActions).not.toContain('refund:decide');
    expect(staffBody.allowedActions).not.toContain('report:read');
  });

  it('A4: a cookie minted by createConsoleSession is accepted by GET /api/console/session with the right role', async () => {
    const session = await createConsoleSession({ role: 'owner', status: 'active' });
    const response = await consoleRequest('/api/console/session', { cookie: session.cookie });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { role: string };
    expect(body.role).toBe('owner');
  });

  it('sign-out revokes the session server-side: the same cookie is rejected afterwards, not merely cleared in the browser', async () => {
    const session = await createConsoleSession({ role: 'owner', status: 'active' });
    const signOut = await consoleRequest('/api/auth/sign-out', { method: 'POST', cookie: session.cookie, headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(signOut.status).toBe(200);
    expect(signOut.headers.get('set-cookie')).toMatch(/Max-Age=0/i);

    const reused = await consoleRequest('/api/console/session', { cookie: session.cookie });
    expect(reused.status).toBe(401);
  });
});
