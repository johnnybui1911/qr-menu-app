import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (entry.endsWith('.ts')) yield path;
  }
}

describe('one secret per concept (C11, R5)', () => {
  it('uses RESEND_API_KEY only as the Resend bearer credential', () => {
    const users = [...sources('apps/worker/src'), ...sources('packages')].filter(
      (file) => !file.endsWith('.d.ts') && readFileSync(file, 'utf8').includes('RESEND_API_KEY'),
    );
    expect(users).toEqual([join('apps/worker/src/order-email-service.ts')]);
  });
});
