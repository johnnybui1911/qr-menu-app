export type DailyRevenue = {
  date: string;
  paidOrderCount: number;
  revenueMinor: number;
  refundedOrderCount: number;
  refundedMinor: number;
};

const ICT_OFFSET_MS = 7 * 60 * 60_000;
const COLLECTED_STATUSES_SQL = "('paid', 'preparing', 'fulfilled')";

/** Bounds of an ICT (UTC+7) calendar day, as UTC ISO timestamps comparable with created_at. */
export function ictDayBounds(date: string): { start: string; end: string } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new RangeError(`Invalid report date: ${date}`);
  const startMs = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) - ICT_OFFSET_MS;
  return { start: new Date(startMs).toISOString(), end: new Date(startMs + 24 * 60 * 60_000).toISOString() };
}

export function ictDate(at: Date): string {
  return new Date(at.getTime() + ICT_OFFSET_MS).toISOString().slice(0, 10);
}

/** Revenue of orders placed on an ICT day: collected orders count; refunded orders are reported separately. */
export async function summarizeDailyRevenue(db: D1Database, storeId: string, date: string): Promise<DailyRevenue> {
  const { start, end } = ictDayBounds(date);
  const row = await db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN status IN ${COLLECTED_STATUSES_SQL} THEN 1 ELSE 0 END), 0) AS paid_count,
         COALESCE(SUM(CASE WHEN status IN ${COLLECTED_STATUSES_SQL} THEN total_amount_minor ELSE 0 END), 0) AS revenue,
         COALESCE(SUM(CASE WHEN status = 'refunded' THEN 1 ELSE 0 END), 0) AS refunded_count,
         COALESCE(SUM(CASE WHEN status = 'refunded' THEN total_amount_minor ELSE 0 END), 0) AS refunded
       FROM orders WHERE store_id = ? AND created_at >= ? AND created_at < ?`,
    )
    .bind(storeId, start, end)
    .first<{ paid_count: number; revenue: number; refunded_count: number; refunded: number }>();
  return {
    date,
    paidOrderCount: row?.paid_count ?? 0,
    revenueMinor: row?.revenue ?? 0,
    refundedOrderCount: row?.refunded_count ?? 0,
    refundedMinor: row?.refunded ?? 0,
  };
}
