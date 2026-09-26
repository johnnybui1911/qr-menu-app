import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function* files(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* files(path);
    else yield path;
  }
}

describe('narrow PayFS gate (C9, D22)', () => {
  it('keeps every provider detail out of packages/orders', () => {
    const offenders = [...files('packages/orders/src')].filter((file) =>
      /payfs|x-client-api-key|subtle\.verify|importKey/i.test(readFileSync(file, 'utf8') + file),
    );
    expect(offenders).toEqual([]);
  });
});
