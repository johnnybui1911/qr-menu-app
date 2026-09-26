// Guards the CI workflow itself (D14): no test here can prove the money-flow e2e gate blocks merge unless the
// workflow file actually wires it in with the right order and no escape hatch. Parses `.github/workflows/ci.yml`
// with a tiny hand-rolled scanner (project convention: see `tests/support/jsonc.ts`) instead of adding a YAML
// dependency for one file.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const CI_PATH = '.github/workflows/ci.yml';

/** Every `- run: <command>` line under the given top-level job, in file order. */
function runStepsForJob(yaml: string, jobName: string): string[] {
  const jobHeader = new RegExp(`^  ${jobName}:\\s*$`, 'm');
  const jobStart = jobHeader.exec(yaml);
  if (!jobStart) throw new Error(`job "${jobName}" not found in ${CI_PATH}`);
  const rest = yaml.slice(jobStart.index + jobStart[0].length);
  // Stop at the next top-level (2-space-indented) key, i.e. the next job.
  const nextJob = /^  [a-zA-Z0-9_-]+:\s*$/m.exec(rest);
  const body = nextJob ? rest.slice(0, nextJob.index) : rest;
  return [...body.matchAll(/^\s*-\s*run:\s*(.+)$/gm)].map((match) => match[1].trim());
}

describe('CI workflow (.github/workflows/ci.yml) — D14 five gates', () => {
  const yaml = readFileSync(CI_PATH, 'utf8');

  it('T3: job "verify" runs typecheck → npm test → build:console → build:storefront → test:e2e, in that order', () => {
    const steps = runStepsForJob(yaml, 'verify');
    const gate = (command: string) => steps.findIndex((step) => step === command);
    const typecheckIdx = gate('npm run typecheck');
    const testIdx = gate('npm test');
    const buildConsoleIdx = gate('npm run build:console');
    const buildStorefrontIdx = gate('npm run build:storefront');
    const e2eIdx = gate('npm run test:e2e');
    expect([typecheckIdx, testIdx, buildConsoleIdx, buildStorefrontIdx, e2eIdx]).not.toContain(-1);
    expect(typecheckIdx).toBeLessThan(testIdx);
    expect(testIdx).toBeLessThan(buildConsoleIdx);
    expect(buildConsoleIdx).toBeLessThan(buildStorefrontIdx);
    expect(buildStorefrontIdx).toBeLessThan(e2eIdx);
  });

  it('T3: no step in "verify" has continue-on-error', () => {
    const jobHeader = /^  verify:\s*$/m.exec(yaml)!;
    const rest = yaml.slice(jobHeader.index);
    const nextJob = /^  deploy:\s*$/m.exec(rest)!;
    const verifyBlock = rest.slice(0, nextJob.index);
    expect(verifyBlock).not.toMatch(/continue-on-error/);
  });

  it('T3: "verify" installs chromium before running test:e2e (npx playwright install --with-deps chromium)', () => {
    const steps = runStepsForJob(yaml, 'verify');
    const installIdx = steps.findIndex((step) => step.includes('playwright install') && step.includes('chromium'));
    const e2eIdx = steps.findIndex((step) => step === 'npm run test:e2e');
    expect(installIdx).toBeGreaterThanOrEqual(0);
    expect(installIdx).toBeLessThan(e2eIdx);
  });

  it('T4: package.json "test:e2e" calls playwright, not the phase-1 placeholder', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['test:e2e']).toMatch(/^playwright test\b/);
    expect(pkg.scripts['test:e2e']).not.toMatch(/exit 0|placeholder/);
  });

  it('T5: job "deploy" needs "verify"', () => {
    const deploySection = yaml.slice(yaml.indexOf('\n  deploy:'));
    expect(deploySection).toMatch(/^\s*needs:\s*verify\s*$/m);
  });

  it('T5: db:migrate:remote runs before both deploy:storefront and deploy:console, and deploy:storefront before deploy:console', () => {
    const steps = runStepsForJob(yaml, 'deploy');
    const gate = (command: string) => steps.findIndex((step) => step === command);
    const migrateIdx = gate('npm run db:migrate:remote');
    const storefrontIdx = gate('npm run deploy:storefront');
    const consoleIdx = gate('npm run deploy:console');
    expect([migrateIdx, storefrontIdx, consoleIdx]).not.toContain(-1);
    expect(migrateIdx).toBeLessThan(storefrontIdx);
    expect(migrateIdx).toBeLessThan(consoleIdx);
    expect(storefrontIdx).toBeLessThan(consoleIdx);
  });

  it('no step in "deploy" has continue-on-error either', () => {
    const deploySection = yaml.slice(yaml.indexOf('\n  deploy:'));
    expect(deploySection).not.toMatch(/continue-on-error/);
  });
});
