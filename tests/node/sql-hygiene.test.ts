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

const ROOTS = ['packages/identity/src', 'packages/catalog/src', 'packages/orders/src', 'apps/worker/src'];
const files = ROOTS.flatMap((root) => [...sourceFiles(root)]);
const SQL_KEYWORD = /\b(?:SELECT|INSERT|UPDATE|DELETE|WHERE|VALUES)\b/;
// Interpolation into SQL is allowed only for module-level SQL fragments (SCREAMING_CASE) and generated `?` lists.
const ALLOWED_INTERPOLATION = /^(?:[A-Z][A-Z0-9_]*|placeholders)$/;

describe('SQL hygiene (C2)', () => {
  it('never interpolates values into SQL template literals', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const [literal] of readFileSync(file, 'utf8').matchAll(/`[^`]*`/g)) {
        if (!SQL_KEYWORD.test(literal)) continue;
        for (const [, expression] of literal.matchAll(/\$\{([^}]*)\}/g)) {
          if (!ALLOWED_INTERPOLATION.test(expression.trim())) offenders.push(`${file}: \${${expression}}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('multiplies price by quantity only inside catalog pricing (C6)', () => {
    const offenders = files.filter(
      (file) => file !== join('packages/catalog/src/pricing.ts') && /\bquantity\s*\*|\*\s*quantity\b/i.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
    expect(readFileSync('packages/catalog/src/pricing.ts', 'utf8')).toMatch(/\*\s*quantity|quantity\s*\*/);
  });
});
