import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

export type ImportGraphTarget = 'console' | 'storefront';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const FORBIDDEN_ALWAYS =
  /(^|\/)design\/|(^|\/)[^/]*prototype[^/]*\.[cm]?[jt]sx?$|(^|\/)[^/]*scenario[^/]*\.[cm]?[jt]sx?$|(^|\/)fixtures?\//i;
// D3: the storefront is HTTP-only and may not bundle any workspace package; the console may bundle catalog only.
const FORBIDDEN_BY_TARGET: Record<ImportGraphTarget, RegExp> = {
  console: /^packages\/(?!catalog\/)/,
  storefront: /^packages\//,
};
const LIVENESS_ANCHOR: Record<ImportGraphTarget, string> = {
  console: 'apps/console/src/main.tsx',
  storefront: 'apps/storefront/src/main.tsx',
};

export function importGraphMetadataPath(target: ImportGraphTarget): string {
  return resolve(REPO_ROOT, '.qr-build', `production-import-graph.${target}.json`);
}

/** Validates the modules that really reached the client bundle, then always deletes the metadata. */
export function assertProductionImportGraph(target: ImportGraphTarget, metadataPath: string): number {
  try {
    const { modules } = JSON.parse(readFileSync(metadataPath, 'utf8')) as { modules: string[] };
    for (const id of modules) {
      if (isAbsolute(id) || id === '..' || id.startsWith('../') || id.includes('/../') || id.includes('\\')) {
        throw new Error(`Unsafe module path in ${target} import graph: ${id}`);
      }
    }
    const forbidden = modules.filter((id) => FORBIDDEN_ALWAYS.test(id) || FORBIDDEN_BY_TARGET[target].test(id));
    if (forbidden.length > 0) {
      throw new Error(`Forbidden modules in ${target} production bundle:\n  ${forbidden.join('\n  ')}`);
    }
    if (!modules.includes(LIVENESS_ANCHOR[target])) {
      throw new Error(`Missing liveness anchor ${LIVENESS_ANCHOR[target]} in ${target} import graph`);
    }
    return modules.length;
  } finally {
    rmSync(metadataPath, { force: true });
  }
}

/**
 * Build-only Vite plugin for the browser bundle of `target`:
 * - rejects `@qr/*` imports the app's package.json does not declare (npm workspaces hoist every package, so
 *   an undeclared import would otherwise resolve);
 * - records every repo module that entered the client module graph for `assertProductionImportGraph`. Parsed
 *   modules are recorded, not just bundle chunks: the bundler can inline a constant so fully that its module
 *   disappears from `output.modules`, and the gate must still see the import.
 */
export function productionImportGraph(target: ImportGraphTarget): Plugin {
  const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, 'apps', target, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const declared = new Set(Object.keys(manifest.dependencies ?? {}));
  const modules = new Set<string>();

  return {
    name: `qr-production-import-graph:${target}`,
    apply: 'build',
    applyToEnvironment: (environment) => environment.name === 'client',
    resolveId(source, importer) {
      const match = /^(@qr\/[^/]+)/.exec(source);
      if (match && !declared.has(match[1])) {
        this.error(`apps/${target} imports ${source} but does not declare ${match[1]} in apps/${target}/package.json (from ${importer ?? 'entry'})`);
      }
      return null;
    },
    moduleParsed({ id }) {
      const projectPath = relative(REPO_ROOT, id.replace(/^\0/, '').split('?')[0]).split(sep).join('/');
      if (projectPath !== '..' && !projectPath.startsWith('../') && !projectPath.startsWith('node_modules/')) {
        modules.add(projectPath);
      }
    },
    closeBundle() {
      const path = importGraphMetadataPath(target);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify({ modules: [...modules].sort() }, null, 2)}\n`);
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flag = process.argv.indexOf('--target');
  const target = process.argv[flag + 1];
  if (flag === -1 || (target !== 'console' && target !== 'storefront')) {
    console.error('Usage: tsx scripts/assert-production-import-graph.ts --target console|storefront');
    process.exit(2);
  }
  const count = assertProductionImportGraph(target, importGraphMetadataPath(target));
  console.log(`Production import graph (${target}): ${count} modules checked`);
}
