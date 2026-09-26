import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* sourceFiles(path);
    else if (entry.endsWith('.ts')) yield path;
  }
}

describe('packages/identity is the dependency floor (C1, D3)', () => {
  it('T28: declares no workspace dependencies', () => {
    const manifest = JSON.parse(readFileSync('packages/identity/package.json', 'utf8')) as { dependencies?: Record<string, string> };
    expect(manifest.dependencies ?? {}).toEqual({});
  });

  it('T28: no source file imports another @qr/* package', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles('packages/identity/src')) {
      for (const [, specifier] of readFileSync(file, 'utf8').matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        if (specifier.startsWith('@qr/')) offenders.push(`${file}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
