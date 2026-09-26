// Whole-repo secret scan (T7) and the `.dev.vars*` git-ignore contract (T8). Distinct from
// `tests/node/secret-hygiene.test.ts` (phase 6): that file checks the five Console-auth secret *names* never carry
// a value in `wrangler.jsonc`/`.dev.vars.example`/`scripts/setup-secrets.sh`, and that no Google client id/secret
// *shaped* literal sits in three app source directories. This file is the broader phase-10 gate (D16): every
// high-confidence provider-secret *shape* (Resend, generic webhook secret, JWT, Google OAuth client secret),
// scanned across the **entire** tracked tree, plus the PayFS fixture's own anonymisation once it exists (O7/T6 —
// still open, see phase-10's construction notes).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const PAYFS_FIXTURE_PATH = 'tests/fixtures/payfs/transactions-sample.json';

// Files allowed to contain something that *looks* like a secret because they are the anonymised sample itself, or
// because they document the pattern in prose (this file, and the phase-10 plan doc, both name `re_`/`whsec_` etc.
// as examples of what to reject — matching that prose is not a leak).
const ALLOWLIST: Record<string, true> = {
  [PAYFS_FIXTURE_PATH]: true,
  'tests/node/secret-scan.test.ts': true,
  'plans/260919-1418-qr-menu-mvp/phase-10-ship-gates-live-email-and-e2e.md': true,
};

const SECRET_SHAPES: { name: string; pattern: RegExp }[] = [
  { name: 'Resend API key (re_...)', pattern: /\bre_[A-Za-z0-9]{10,}\b/ },
  { name: 'generic webhook secret (whsec_...)', pattern: /\bwhsec_[A-Za-z0-9]{10,}\b/ },
  { name: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: 'Google OAuth client secret (GOCSPX-...)', pattern: /\bGOCSPX-[A-Za-z0-9_-]+\b/ },
];

/** Every file that would end up in the repo, respecting `.gitignore` — works whether or not anything is committed
 * yet (`--cached` covers a normal checkout, `--others --exclude-standard` covers this sandbox's uncommitted tree).
 * Excludes agent-harness scaffolding (`.agentkit/`, `.claude/`, `.vitest-attachments/`) that ships alongside the
 * checkout but is not part of the qr-menu-app project this gate protects. */
function repoTree(): string[] {
  const NON_PROJECT_PREFIXES = ['.agentkit/', '.claude/', '.vitest-attachments/'];
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter((path) => !NON_PROJECT_PREFIXES.some((prefix) => path.startsWith(prefix)));
}

function isBinary(path: string): boolean {
  return /\.(png|jpe?g|webp|gif|ico|woff2?|ttf|zip|sqlite3?|db)$/i.test(path);
}

describe('no secret value in the repo (T7)', () => {
  it('finds no Resend/webhook/JWT/Google-client-secret shaped literal outside the allowlist', () => {
    const offenders: string[] = [];
    for (const path of repoTree()) {
      if (ALLOWLIST[path] || isBinary(path) || path.startsWith('node_modules/')) continue;
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue; // Deleted between listing and reading (e.g. a stale index entry) — nothing to scan.
      }
      if (!stat.isFile()) continue;
      const content = readFileSync(path, 'utf8');
      for (const shape of SECRET_SHAPES) {
        if (shape.pattern.test(content)) offenders.push(`${path}: matches ${shape.name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('actually scans a non-trivial tree', () => {
    expect(repoTree().length).toBeGreaterThan(100);
  });
});

describe('PayFS fixture anonymisation (T7, blocked on O7)', () => {
  const skip = !existsSync(PAYFS_FIXTURE_PATH);

  it.skipIf(skip)('has no run of 8+ consecutive digits (a real account/card number shape)', () => {
    const content = readFileSync(PAYFS_FIXTURE_PATH, 'utf8');
    expect(content).not.toMatch(/\d{8,}/);
  });

  it.skipIf(skip)('every "content" field is a test-generated QM… reference, never real bank-transfer text', () => {
    const parsed = JSON.parse(readFileSync(PAYFS_FIXTURE_PATH, 'utf8')) as { transactions?: { content?: string }[] };
    for (const transaction of parsed.transactions ?? []) {
      expect(transaction.content).toMatch(/QM[0-9A-Z]{8}/);
    }
  });

  if (skip) {
    it('not written yet — O7 (PayFS account) has not landed, see phase-10 construction notes', () => {
      expect(existsSync(PAYFS_FIXTURE_PATH)).toBe(false);
    });
  }
});

describe('.dev.vars* is never committed (T8, D16)', () => {
  it('.gitignore blocks .dev.vars* with the .dev.vars.example exception', () => {
    const gitignore = readFileSync('.gitignore', 'utf8');
    expect(gitignore).toMatch(/^\.dev\.vars\*$/m);
    expect(gitignore).toMatch(/^!\.dev\.vars\.example$/m);
  });

  it('the only .dev.vars* file in the repo tree is .dev.vars.example', () => {
    const devVarsFiles = repoTree().filter((path) => /(^|\/)\.dev\.vars/.test(path));
    expect(devVarsFiles).toEqual(['.dev.vars.example']);
  });

  it('.dev.vars.example has no line with a value after the "="', () => {
    const lines = readFileSync('.dev.vars.example', 'utf8').split('\n');
    const offenders = lines.filter((line) => {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) return false;
      const [, value] = trimmed.split(/=(.*)/s);
      return (value ?? '').trim().length > 0;
    });
    expect(offenders).toEqual([]);
  });
});
