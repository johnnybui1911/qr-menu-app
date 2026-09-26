import { useEffect, useState } from 'react';
import { apiGet, type ConsoleSession } from './api-client.ts';
import { formatVnd } from './format-money.ts';

type RevenueSummary = { date: string; paidOrderCount: number; revenueMinor: number; refundedOrderCount: number; refundedMinor: number };

/** ICT (Bangkok/Jakarta/Ho Chi Minh) has no DST and is always UTC+7 (D23's "giờ chốt ngày"). */
function todayInIct(): string {
  return new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function RevenuePanel({ session, initialDate }: { session: ConsoleSession; initialDate?: string }) {
  const [date, setDate] = useState(initialDate ?? todayInIct());
  const [summary, setSummary] = useState<RevenueSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canRead = session.allowedActions.includes('report:read');

  useEffect(() => {
    if (!canRead) return;
    let cancelled = false;
    apiGet<RevenueSummary>(`/api/console/revenue?date=${date}`).then((result) => {
      if (cancelled) return;
      if (result.status === 200 && result.data && 'revenueMinor' in result.data) {
        setSummary(result.data);
        setError(null);
      } else {
        setError('Không tải được doanh thu.');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [canRead, date]);

  if (!canRead) {
    return <p role="alert">Bạn không có quyền truy cập trang này.</p>;
  }

  return (
    <section className="console-screen revenue-panel" aria-label="Doanh thu">
      <h1>Doanh thu</h1>
      <label htmlFor="revenue-date">Ngày</label>
      <input id="revenue-date" type="date" value={date} onChange={(event) => setDate(event.target.value)} />
      {error && (
        <p className="console-error" role="alert">
          {error}
        </p>
      )}
      {summary && (
        <dl className="revenue-summary">
          <dt>Số đơn đã thanh toán</dt>
          <dd>{summary.paidOrderCount}</dd>
          <dt>Doanh thu</dt>
          <dd>{formatVnd(summary.revenueMinor)}</dd>
          <dt>Số đơn hoàn tiền</dt>
          <dd>{summary.refundedOrderCount}</dd>
          <dt>Tổng hoàn tiền</dt>
          <dd>{formatVnd(summary.refundedMinor)}</dd>
        </dl>
      )}
    </section>
  );
}
