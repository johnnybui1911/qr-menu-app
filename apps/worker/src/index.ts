import { handlePayfsWebhook } from './payfs-webhook-routes.ts';
import { handleConsoleRequest } from './console-session-routes.ts';
import { runScheduled } from './scheduled.ts';
import { handleStorefrontRequest } from './storefront-order-routes.ts';
import { handleProductImageRequest } from './storefront-product-image-routes.ts';

const worker: ExportedHandler<Env> = {
  // Only /api reaches the Worker in production (run_worker_first); anything unmapped is a JSON 404.
  // The PayFS webhook is matched first, ahead of CORS and every other route.
  async fetch(request, env) {
    return (
      (await handlePayfsWebhook(request, env)) ??
      (await handleConsoleRequest(request, env)) ??
      (await handleProductImageRequest(request, env)) ??
      (await handleStorefrontRequest(request, env)) ??
      Response.json({ error: 'not_found' }, { status: 404 })
    );
  },

  async scheduled(controller, env) {
    await runScheduled(controller, env);
  },
};

export default worker;
