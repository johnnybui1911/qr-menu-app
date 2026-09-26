import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveTableByToken } from '@qr/catalog/tables-read';
import { STORE_ID } from '@qr/identity/store';
import { consoleRequest, createConsoleSession } from '../support/console-session.ts';
import { resetDb } from '../support/test-env.ts';

const json = (body: unknown) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function ownerTable(cookie: string, tableNumber = '1') {
  const response = await consoleRequest('/api/console/tables', { method: 'POST', cookie, ...json({ tableNumber }) });
  return (await response.json()) as { id: string };
}

beforeEach(resetDb);

describe('console table & QR routes (phase 8, D17)', () => {
  it('T16: rotating QR returns the token exactly once (in the URL fragment); the table list never carries a token', async () => {
    const owner = await createConsoleSession({ role: 'owner', status: 'active' });
    const table = await ownerTable(owner.cookie);

    const qr = await consoleRequest(`/api/console/tables/${table.id}/qr`, { method: 'POST', cookie: owner.cookie });
    expect(qr.status).toBe(200);
    const body = (await qr.json()) as { tokenUrl: string; qrPayload: string };
    expect(body.tokenUrl).toContain('#');
    expect(new URL(body.tokenUrl.replace('#', '?__frag=')).search).not.toContain('token');

    const list = await consoleRequest('/api/console/tables', { cookie: owner.cookie });
    const text = await list.text();
    expect(text).not.toContain(body.tokenUrl.split('#')[1]);
    const digest = await env.DB.prepare('SELECT token_digest FROM table_secrets WHERE store_id = ? AND table_id = ?').bind(STORE_ID, table.id).first<{ token_digest: string }>();
    expect(digest!.token_digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('T17: a rotated-out token still resolves the table for 15 minutes, then stops', async () => {
    const owner = await createConsoleSession({ role: 'owner', status: 'active' });
    const table = await ownerTable(owner.cookie);
    const first = await consoleRequest(`/api/console/tables/${table.id}/qr`, { method: 'POST', cookie: owner.cookie });
    const { tokenUrl: firstUrl } = (await first.json()) as { tokenUrl: string };
    const firstToken = firstUrl.split('#')[1]!;

    await consoleRequest(`/api/console/tables/${table.id}/qr`, { method: 'POST', cookie: owner.cookie });

    const soon = new Date(Date.now() + 60_000).toISOString();
    const stillLive = await resolveTableByToken(env.DB, STORE_ID, firstToken, soon);
    expect(stillLive?.id).toBe(table.id);

    const later = new Date(Date.now() + 16 * 60_000).toISOString();
    const expired = await resolveTableByToken(env.DB, STORE_ID, firstToken, later);
    expect(expired).toBeNull();
  });

  it('T18: two rotations in a row leave three digests whose live-token invariant never breaks', async () => {
    const owner = await createConsoleSession({ role: 'owner', status: 'active' });
    const table = await ownerTable(owner.cookie);
    await consoleRequest(`/api/console/tables/${table.id}/qr`, { method: 'POST', cookie: owner.cookie });
    await consoleRequest(`/api/console/tables/${table.id}/qr`, { method: 'POST', cookie: owner.cookie });
    const third = await consoleRequest(`/api/console/tables/${table.id}/qr`, { method: 'POST', cookie: owner.cookie });
    expect(third.status).toBe(200);

    const { results } = await env.DB.prepare('SELECT revoked_at FROM table_secrets WHERE store_id = ? AND table_id = ?').bind(STORE_ID, table.id).all<{ revoked_at: string | null }>();
    expect(results).toHaveLength(3);
    expect(results.filter((r) => r.revoked_at === null)).toHaveLength(1);
  });

  it('T19: Staff cannot rotate QR (403) but can list tables (200)', async () => {
    const owner = await createConsoleSession({ role: 'owner', status: 'active' });
    const staff = await createConsoleSession({ role: 'staff', status: 'active' });
    const table = await ownerTable(owner.cookie);

    const qr = await consoleRequest(`/api/console/tables/${table.id}/qr`, { method: 'POST', cookie: staff.cookie });
    expect(qr.status).toBe(403);
    const list = await consoleRequest('/api/console/tables', { cookie: staff.cookie });
    expect(list.status).toBe(200);
  });

  it('T20: a duplicate table number is refused with 409', async () => {
    const owner = await createConsoleSession({ role: 'owner', status: 'active' });
    await ownerTable(owner.cookie, '7');
    const dup = await consoleRequest('/api/console/tables', { method: 'POST', cookie: owner.cookie, ...json({ tableNumber: '7' }) });
    expect(dup.status).toBe(409);
    await expect(dup.json()).resolves.toEqual({ error: 'table_number_taken' });
  });

  it('A3: the QR response never puts the token in a query string and marks itself no-store/no-referrer', async () => {
    const owner = await createConsoleSession({ role: 'owner', status: 'active' });
    const table = await ownerTable(owner.cookie);
    const qr = await consoleRequest(`/api/console/tables/${table.id}/qr`, { method: 'POST', cookie: owner.cookie });
    expect(qr.headers.get('cache-control')).toBe('no-store');
    expect(qr.headers.get('referrer-policy')).toBe('no-referrer');
    const { tokenUrl } = (await qr.json()) as { tokenUrl: string };
    expect(new URL(tokenUrl).search).toBe('');
  });
});
