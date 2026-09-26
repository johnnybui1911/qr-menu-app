import { STORE_ID } from '@qr/identity/store';
import { claimDueJobs, completeJob, enqueueEmailJobStatement, failJob, retireExhaustedJobs, type EmailJob } from '@qr/orders/email-outbox';
import { ictDate, summarizeDailyRevenue } from '@qr/orders/revenue-report';
import { logEvent } from './log.ts';

/** Closing hour of the daily revenue report, Asia/Ho_Chi_Minh. O8 may move it; it is a constant, not a variable (C11). */
export const DAILY_REPORT_HOUR_ICT = 23;
const JOBS_PER_RUN = 20;
const DUPLICATE_DEDUPE_KEY = /UNIQUE constraint failed: order_email_jobs\.store_id, order_email_jobs\.dedupe_key/;

type EmailConfig = { apiKey: string; from: string; ownerEmail: string };
type Message = { to: string; subject: string; text: string };

const vnd = (minor: number) => `${new Intl.NumberFormat('vi-VN').format(minor)} ₫`;

function readEmailConfig(env: Env): EmailConfig | null {
  const apiKey = env.RESEND_API_KEY ?? '';
  const from = env.RESEND_FROM_ADDRESS ?? '';
  const ownerEmail = env.OWNER_REPORT_EMAIL ?? '';
  return apiKey && from && ownerEmail ? { apiKey, from, ownerEmail } : null;
}

async function composeMessage(env: Env, config: EmailConfig, job: EmailJob): Promise<Message | null> {
  const payload = (job.payload ?? {}) as Record<string, unknown>;
  switch (job.kind) {
    case 'daily_revenue_report': {
      if (typeof payload.date !== 'string') return null;
      const report = await summarizeDailyRevenue(env.DB, job.storeId, payload.date);
      return {
        to: config.ownerEmail,
        subject: `Báo cáo doanh thu ${report.date}`,
        text: [
          `Doanh thu ngày ${report.date}: ${vnd(report.revenueMinor)} (${report.paidOrderCount} đơn đã thanh toán).`,
          `Hoàn tiền: ${report.refundedOrderCount} đơn, ${vnd(report.refundedMinor)}.`,
          `Chi tiết: ${env.CONSOLE_ORIGIN}/console/revenue?date=${report.date}`,
        ].join('\n'),
      };
    }
    case 'refund_confirmed': {
      if (typeof payload.orderCode !== 'string' || typeof payload.amountMinor !== 'number') return null;
      return {
        to: config.ownerEmail,
        subject: `Đã duyệt hoàn tiền đơn ${payload.orderCode}`,
        text: `Yêu cầu hoàn tiền đơn ${payload.orderCode} (${vnd(payload.amountMinor)}) đã được duyệt. Hãy chuyển khoản hoàn cho khách.`,
      };
    }
    case 'invitation': {
      if (typeof payload.targetEmail !== 'string' || typeof payload.token !== 'string') return null;
      const role = payload.role === 'owner' ? 'chủ quán' : 'nhân viên';
      return {
        to: payload.targetEmail,
        subject: 'Lời mời tham gia QR Menu Console',
        // The token travels in the URL fragment so it never reaches a server log or Referer header (D8).
        text: `Bạn được mời vào QR Menu Console với vai trò ${role}.\nNhận lời mời: ${env.CONSOLE_ORIGIN}/console/invite#invite=${payload.token}`,
      };
    }
  }
}

async function deliver(env: Env, config: EmailConfig, job: EmailJob, message: Message): Promise<string | null> {
  try {
    const response = await fetch(`${env.RESEND_API_BASE}/emails`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json',
        // Stable across retries so Resend never delivers the same job twice.
        'idempotency-key': job.id,
      },
      body: JSON.stringify({ from: config.from, to: [message.to], subject: message.subject, text: message.text }),
    });
    return response.ok ? null : `resend_http_${response.status}`;
  } catch (error) {
    return `resend_unreachable: ${String(error)}`;
  }
}

async function enqueueDailyReport(env: Env, now: Date): Promise<void> {
  const ictHour = (now.getUTCHours() + 7) % 24;
  if (ictHour !== DAILY_REPORT_HOUR_ICT) return;
  const date = ictDate(now);
  try {
    await enqueueEmailJobStatement(env.DB, { storeId: STORE_ID, kind: 'daily_revenue_report', orderId: null, dedupeKey: `daily:${date}`, payload: { date } }).run();
  } catch (error) {
    // Already enqueued by an earlier run this hour: the UNIQUE key is the dedupe, no read-before-write.
    if (!DUPLICATE_DEDUPE_KEY.test(String(error))) throw error;
  }
}

/** The every-5-minutes cron: enqueue the daily report at closing hour, then claim → send → complete | fail for due jobs. */
export async function runEmailOutbox(env: Env, now: Date = new Date()): Promise<void> {
  await enqueueDailyReport(env, now);
  const config = readEmailConfig(env);
  if (!config) {
    logEvent({ event: 'email_not_configured' });
    return;
  }
  await retireExhaustedJobs(env.DB);
  for (const job of await claimDueJobs(env.DB, now, JOBS_PER_RUN)) {
    const message = await composeMessage(env, config, job);
    const error = message ? await deliver(env, config, job, message) : 'invalid_payload';
    if (error) {
      await failJob(env.DB, job, error);
      logEvent({ event: 'email_send_failed', jobId: job.id, kind: job.kind, attempts: job.attempts, error });
    } else {
      await completeJob(env.DB, job.id, now);
    }
  }
}
