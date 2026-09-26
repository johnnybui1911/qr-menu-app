import { logEvent } from './log.ts';
import { runEmailOutbox } from './order-email-service.ts';
import { reconcilePendingOrders } from './payfs/reconcile-pending-orders.ts';

export const CRON_RECONCILE_PAYMENTS = '*/1 * * * *';
export const CRON_DISPATCH_EMAILS = '*/5 * * * *';

/** Each cron pattern runs exactly one job; an unknown pattern fails loudly instead of silently skipping work. */
export async function runScheduled(controller: ScheduledController, env: Env): Promise<void> {
  const now = new Date(controller.scheduledTime);
  let job: () => Promise<void>;
  switch (controller.cron) {
    case CRON_RECONCILE_PAYMENTS:
      job = () => reconcilePendingOrders(env, now);
      break;
    case CRON_DISPATCH_EMAILS:
      job = () => runEmailOutbox(env, now);
      break;
    default:
      throw new Error(`Unknown cron pattern: ${controller.cron}`);
  }
  try {
    await job();
  } catch (error) {
    const incidentId = crypto.randomUUID();
    logEvent({ event: 'cron_failed', cron: controller.cron, incidentId, error: String(error) });
    throw error;
  }
}
