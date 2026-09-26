import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { STORE_ID } from '@qr/identity/store';
import { resolveTableByToken } from '@qr/catalog/tables-read';
import { createTable, issueTableToken, listTables, TABLE_TOKEN_GRACE_MS } from '@qr/catalog/tables-write';
import { resetDb } from '../support/test-env.ts';

const later = (from: Date, ms: number) => new Date(from.getTime() + ms);
let tableId: string;

beforeEach(async () => {
  await resetDb();
  const created = await createTable(env.DB, STORE_ID, '5');
  tableId = created.ok ? created.id : '';
});

describe('table QR rotation (D17)', () => {
  it('issues a token once and stores only its digest', async () => {
    const issued = await issueTableToken(env.DB, STORE_ID, tableId);
    expect(issued).toMatchObject({ ok: true, token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    const token = issued.ok ? issued.token : '';
    const dump = JSON.stringify((await env.DB.prepare('SELECT * FROM table_secrets').all()).results);
    expect(dump).not.toContain(token);
    expect(JSON.stringify(await listTables(env.DB, STORE_ID))).not.toContain(token);
    expect(await resolveTableByToken(env.DB, STORE_ID, token, new Date().toISOString())).toEqual({ id: tableId, tableNumber: '5' });
  });

  it('keeps the previous token alive for exactly the grace window', async () => {
    const now = new Date();
    const old = await issueTableToken(env.DB, STORE_ID, tableId, now);
    await issueTableToken(env.DB, STORE_ID, tableId, now);
    const oldToken = old.ok ? old.token : '';
    expect(TABLE_TOKEN_GRACE_MS).toBe(15 * 60 * 1000);
    expect(await resolveTableByToken(env.DB, STORE_ID, oldToken, later(now, 14 * 60_000).toISOString())).toEqual({ id: tableId, tableNumber: '5' });
    expect(await resolveTableByToken(env.DB, STORE_ID, oldToken, later(now, 16 * 60_000).toISOString())).toBeNull();
  });

  it('survives back-to-back rotations with several live digests', async () => {
    const now = new Date();
    const tokens = [];
    for (let i = 0; i < 3; i++) {
      const issued = await issueTableToken(env.DB, STORE_ID, tableId, later(now, i * 1000));
      tokens.push(issued.ok ? issued.token : '');
    }
    const live = await env.DB.prepare('SELECT count(*) AS n FROM table_secrets WHERE revoked_at IS NULL').first('n');
    expect(live).toBe(1);
    for (const token of tokens) expect(await resolveTableByToken(env.DB, STORE_ID, token, later(now, 5000).toISOString())).not.toBeNull();
  });

  it('rejects a duplicate table number and an unknown table', async () => {
    expect(await createTable(env.DB, STORE_ID, '5')).toEqual({ ok: false, code: 'table_number_taken' });
    expect(await issueTableToken(env.DB, STORE_ID, 'ghost')).toEqual({ ok: false, code: 'not_found' });
  });
});
