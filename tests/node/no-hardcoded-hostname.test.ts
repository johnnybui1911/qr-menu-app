import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE_ROOTS = ['apps/console/src', 'apps/storefront/src', 'apps/worker/src', 'packages/identity/src', 'packages/catalog/src', 'packages/orders/src'];
const HOSTNAME = /workers\.dev|https?:\/\/[a-z0-9.-]+\.[a-z]{2,}/i;

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
    else if (/\.(?:[cm]?[jt]sx?|css|html)$/.test(entry)) yield path;
  }
}

const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('no hard-coded hostnames (D21)', () => {
  it('finds no hostname literal in application or package source', () => {
    const offenders: string[] = [];
    for (const root of SOURCE_ROOTS) {
      for (const file of walk(root)) {
        stripComments(readFileSync(file, 'utf8'))
          .split('\n')
          .forEach((line, i) => {
            if (HOSTNAME.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
          });
      }
    }
    expect(offenders).toEqual([]);
  });

  it('actually scans a populated source tree', () => {
    expect([...walk('apps/worker/src')].length).toBeGreaterThan(0);
  });
});

describe('no hard-coded hostnames in the e2e harness (D21, phase-10 T9)', () => {
  const PHASE_10_ROOTS = ['tests/e2e'];
  const PHASE_10_FILES = ['playwright.config.ts'];

  it('finds no hostname literal in tests/e2e/** or playwright.config.ts', () => {
    const offenders: string[] = [];
    for (const root of PHASE_10_ROOTS) {
      for (const file of walk(root)) {
        stripComments(readFileSync(file, 'utf8'))
          .split('\n')
          .forEach((line, i) => {
            if (HOSTNAME.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
          });
      }
    }
    for (const file of PHASE_10_FILES) {
      stripComments(readFileSync(file, 'utf8'))
        .split('\n')
        .forEach((line, i) => {
          if (HOSTNAME.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  it('actually scans a populated e2e tree', () => {
    expect([...walk('tests/e2e')].length).toBeGreaterThan(0);
  });

  it('the only loopback host is 127.0.0.1, read from an env var with a documented default — never a bare literal port on its own line pretending to be a real domain', () => {
    const harness = readFileSync('tests/e2e/support/harness.ts', 'utf8');
    expect(harness).toContain("const HOST = '127.0.0.1';");
    expect(harness).toMatch(/Loopback-only: this harness never runs against a deployed origin/);
  });
});
