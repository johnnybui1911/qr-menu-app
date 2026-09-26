import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readJsonc } from '../support/jsonc.ts';

const AUTH_SECRET_NAMES = ['BETTER_AUTH_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'INITIAL_OWNER_EMAIL', 'INVITATION_HMAC_SECRET'];

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

describe('no Console auth secret value in the repo (D16)', () => {
  it('wrangler.jsonc "vars" never lists an auth secret name (secrets only go through `wrangler secret put`)', () => {
    const config = readJsonc<{ vars?: Record<string, unknown> }>('wrangler.jsonc');
    for (const name of AUTH_SECRET_NAMES) expect(Object.keys(config.vars ?? {})).not.toContain(name);
  });

  it('.dev.vars.example only names variables — every line is KEY= with nothing but whitespace after the equals sign', () => {
    const lines = readFileSync('.dev.vars.example', 'utf8').split('\n');
    const offenders = lines.filter((line) => {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) return false;
      const [, value] = trimmed.split(/=(.*)/s);
      return (value ?? '').trim().length > 0;
    });
    expect(offenders).toEqual([]);
    for (const name of AUTH_SECRET_NAMES) expect(readFileSync('.dev.vars.example', 'utf8')).toMatch(new RegExp(`^${name}=$`, 'm'));
  });

  it('scripts/setup-secrets.sh contains no secret value — only prompts, trimming, and `wrangler secret put`', () => {
    const script = readFileSync('scripts/setup-secrets.sh', 'utf8');
    for (const name of AUTH_SECRET_NAMES) expect(script).toContain(name);
    expect(script).toMatch(/wrangler secret put/);
    // No inline assignment of a literal value to any of the five names (`NAME=<something not $var/quote/space>`).
    for (const name of AUTH_SECRET_NAMES) expect(script).not.toMatch(new RegExp(`${name}\\s*=\\s*['"][^'"$]`));
  });

  it('no application source hard-codes a Google OAuth client id/secret shaped literal', () => {
    const roots = ['apps/worker/src', 'apps/console/src', 'packages/identity/src'];
    const offenders: string[] = [];
    // Real Google client secrets look like GOCSPX-<random>; client ids end in .apps.googleusercontent.com.
    const SUSPICIOUS = /GOCSPX-[A-Za-z0-9_-]+|\d+-[a-z0-9]+\.apps\.googleusercontent\.com/;
    for (const root of roots) {
      for (const file of walk(root)) {
        if (!/\.(ts|tsx)$/.test(file)) continue;
        if (SUSPICIOUS.test(readFileSync(file, 'utf8'))) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
