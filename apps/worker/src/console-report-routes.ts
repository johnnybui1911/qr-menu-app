import { summarizeDailyRevenue } from '@qr/orders/revenue-report';
import { forbiddenUnless } from './console-command-support.ts';
import { withConsoleContext } from './console-request-context.ts';
import { jsonError, jsonResponse } from './http-response.ts';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** GET /api/console/revenue?date=YYYY-MM-DD (ICT day) — the owner's report (PRD §2.3.4). */
export async function handleConsoleReportRequest(request: Request, env: Env, pathname: string): Promise<Response | null> {
  if (pathname !== '/api/console/revenue' || request.method !== 'GET') return null;
  return withConsoleContext(request, env, async (context) => {
    const denied = forbiddenUnless(context, 'report:read');
    if (denied) return denied;
    const date = new URL(request.url).searchParams.get('date') ?? '';
    if (!DATE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) return jsonError(400, 'invalid_date');
    return jsonResponse(await summarizeDailyRevenue(env.DB, context.storeId, date));
  });
}
