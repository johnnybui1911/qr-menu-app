// Owns all SQL for order_email_jobs (C3). Phase 5 appends claim/complete/retire to this module.

export type EmailJobKind = 'daily_revenue_report' | 'refund_confirmed' | 'invitation';

export type EmailJobInput = {
  storeId: string;
  kind: EmailJobKind;
  orderId: string | null;
  dedupeKey: string;
  payload: unknown;
};

/**
 * Returns the INSERT for a new email job so callers can place it in the same db.batch() as the state change it
 * announces (D23). A duplicate dedupe key aborts that batch through UNIQUE (store_id, dedupe_key).
 */
export function enqueueEmailJobStatement(db: D1Database, job: EmailJobInput): D1PreparedStatement {
  return db
    .prepare('INSERT INTO order_email_jobs (id, store_id, order_id, kind, dedupe_key, payload_json) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), job.storeId, job.orderId, job.kind, job.dedupeKey, JSON.stringify(job.payload));
}

// --- Delivery lifecycle (phase 5): claim → send → complete | fail → retire after MAX_ATTEMPTS. ---

export const MAX_EMAIL_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;

export type EmailJob = { id: string; storeId: string; kind: EmailJobKind; orderId: string | null; payload: unknown; attempts: number };

type EmailJobRow = { id: string; store_id: string; kind: EmailJobKind; order_id: string | null; payload_json: string | null; attempts: number };

/** When a job claimed for its `attempts`-th try may be tried again: 5 min doubling, capped at one hour. */
export function nextAvailableAt(attempts: number, now: Date): string {
  const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1));
  return new Date(now.getTime() + delay).toISOString();
}

/**
 * Claims due jobs one conditional UPDATE each: the claim bumps attempts and pushes available_at to the retry time
 * before anything is sent, so overlapping cron runs can never both win a job and a crash mid-send still backs off.
 */
export async function claimDueJobs(db: D1Database, now: Date, limit: number): Promise<EmailJob[]> {
  const nowIso = now.toISOString();
  const { results } = await db
    .prepare(
      `SELECT id, attempts FROM order_email_jobs
       WHERE status = 'pending' AND attempts < ? AND available_at <= ?
       ORDER BY available_at, id LIMIT ?`,
    )
    .bind(MAX_EMAIL_ATTEMPTS, nowIso, limit)
    .all<{ id: string; attempts: number }>();
  const claimed: EmailJob[] = [];
  for (const candidate of results) {
    const row = await db
      .prepare(
        `UPDATE order_email_jobs SET attempts = attempts + 1, available_at = ?
         WHERE id = ? AND status = 'pending' AND attempts = ? AND available_at <= ?
         RETURNING id, store_id, kind, order_id, payload_json, attempts`,
      )
      .bind(nextAvailableAt(candidate.attempts + 1, now), candidate.id, candidate.attempts, nowIso)
      .first<EmailJobRow>();
    if (row) {
      claimed.push({
        id: row.id,
        storeId: row.store_id,
        kind: row.kind,
        orderId: row.order_id,
        payload: row.payload_json === null ? null : JSON.parse(row.payload_json),
        attempts: row.attempts,
      });
    }
  }
  return claimed;
}

/** Marks a job delivered and drops its payload (an invitation payload carries a raw token). */
export async function completeJob(db: D1Database, jobId: string, now: Date): Promise<void> {
  await db
    .prepare("UPDATE order_email_jobs SET status = 'sent', delivered_at = ?, payload_json = NULL, last_error = NULL WHERE id = ? AND status = 'pending'")
    .bind(now.toISOString(), jobId)
    .run();
}

/** Records a failed attempt; the claim already scheduled the retry. The last allowed attempt retires the job. */
export async function failJob(db: D1Database, job: EmailJob, error: string): Promise<void> {
  await db
    .prepare(
      `UPDATE order_email_jobs SET last_error = ?,
         status = CASE WHEN attempts >= ? THEN 'retired' ELSE status END,
         payload_json = CASE WHEN attempts >= ? THEN NULL ELSE payload_json END
       WHERE id = ? AND status = 'pending'`,
    )
    .bind(error.slice(0, 500), MAX_EMAIL_ATTEMPTS, MAX_EMAIL_ATTEMPTS, job.id)
    .run();
}

/** Retires jobs that exhausted their attempts without a recorded failure (e.g. the worker died mid-send). */
export async function retireExhaustedJobs(db: D1Database): Promise<void> {
  await db
    .prepare("UPDATE order_email_jobs SET status = 'retired', payload_json = NULL WHERE status = 'pending' AND attempts >= ?")
    .bind(MAX_EMAIL_ATTEMPTS)
    .run();
}
