import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { resetDb } from '../support/test-env.ts';

const userTables = () =>
  env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name")
    .all<{ name: string }>()
    .then((r) => r.results.map((row) => row.name));

describe('test harness in workerd', () => {
  it('resetDb drops every table, including FK-linked ones, and reapplies migrations', async () => {
    await env.DB.batch([
      env.DB.prepare('CREATE TABLE parent (id INTEGER PRIMARY KEY)'),
      env.DB.prepare('CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id))'),
      env.DB.prepare('INSERT INTO parent (id) VALUES (1)'),
      env.DB.prepare('INSERT INTO child (id, parent_id) VALUES (1, 1)'),
    ]);

    await resetDb();
    await resetDb();

    const tables = await userTables();
    expect(tables).not.toContain('parent');
    expect(tables).not.toContain('child');
    expect(tables).toContain('d1_migrations');
    const applied = await env.DB.prepare('SELECT count(*) AS n FROM d1_migrations').first<number>('n');
    expect(applied).toBe(env.MIGRATIONS.length);
  });

  it('exposes live D1 and R2 bindings', async () => {
    expect(await env.DB.prepare('SELECT 1 AS x').first()).toEqual({ x: 1 });
    await env.FILES.put('probe.bin', new Uint8Array([1, 2, 3]));
    const object = await env.FILES.get('probe.bin');
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });
});
