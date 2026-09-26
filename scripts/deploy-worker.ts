// Builds and deploys one Worker with the production origins injected at deploy time (D21):
//
//   CONSOLE_ORIGIN=<https origin> STOREFRONT_ORIGIN=<https origin> tsx scripts/deploy-worker.ts <console|storefront>
//
// - storefront: builds with VITE_STOREFRONT_API_BASE_URL = CONSOLE_ORIGIN (the only build-time variable, C11), then
//   deploys the assets-only Worker.
// - console: builds, then deploys the vite-plugin output with `--var` overriding the loopback CONSOLE_ORIGIN /
//   STOREFRONT_ORIGIN from wrangler.jsonc. Bindings (DB, FILES) and crons come from that generated config unchanged.
// Deploy storefront before console (Console needs STOREFRONT_ORIGIN live) — `npm run deploy:*` + CI keep that order.
import { execFileSync } from 'node:child_process';
import { readDeployOrigins } from './deploy-origins.ts';

const target = process.argv[2];
if (target !== 'console' && target !== 'storefront') {
  console.error('Usage: tsx scripts/deploy-worker.ts <console|storefront>');
  process.exit(2);
}

const { consoleOrigin, storefrontOrigin } = readDeployOrigins(process.env);
// wrangler prints `--var` values as "(hidden)", so this line is the deploy log's only record of what shipped.
console.log(`deploy ${target}: CONSOLE_ORIGIN=${consoleOrigin} STOREFRONT_ORIGIN=${storefrontOrigin}`);
const run = (command: string, args: string[], env: NodeJS.ProcessEnv = process.env) => execFileSync(command, args, { stdio: 'inherit', env });

if (target === 'storefront') {
  run('npm', ['run', 'build:storefront'], { ...process.env, VITE_STOREFRONT_API_BASE_URL: consoleOrigin });
  run('npx', ['wrangler', 'deploy', '--config', 'apps/storefront/wrangler.jsonc', '--name', 'qr-menu-storefront']);
} else {
  run('npm', ['run', 'build:console']);
  run('npx', [
    'wrangler',
    'deploy',
    '--config',
    'apps/console/dist/qr_menu_app/wrangler.json',
    '--var',
    `CONSOLE_ORIGIN:${consoleOrigin}`,
    '--var',
    `STOREFRONT_ORIGIN:${storefrontOrigin}`,
  ]);
}
