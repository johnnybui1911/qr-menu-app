import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

/**
 * Drops every table (including d1_migrations) in one batch, then applies migrations[0, through).
 * Tables are discovered from sqlite_master so new migrations never require editing this helper;
 * FK checks are deferred because sqlite_master order is arbitrary.
 */
export async function resetDbThrough(through: number): Promise<void> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
  ).all<{ name: string }>();
  if (results.length > 0) {
    await env.DB.batch([
      env.DB.prepare('PRAGMA defer_foreign_keys = true'),
      ...results.map(({ name }) => env.DB.prepare(`DROP TABLE IF EXISTS "${name.replaceAll('"', '""')}"`)),
    ]);
  }
  await applyD1Migrations(env.DB, env.MIGRATIONS.slice(0, through));
}

/** Resets to the latest schema. Takes no arguments so `beforeEach(resetDb)` cannot pass Vitest's context as `through`. */
export function resetDb(): Promise<void> {
  return resetDbThrough(env.MIGRATIONS.length);
}
