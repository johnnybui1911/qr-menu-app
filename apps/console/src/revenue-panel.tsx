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
    return (
      <p role="alert" className="console-error">
        Bạn không có quyền truy cập trang này.
      </p>
    );
  }

  return (
    <section className="console-screen revenue-panel" aria-label="Doanh thu">
      <h1 className="page-title">Doanh thu</h1>
      <div className="max-w-60">
        <label htmlFor="revenue-date">Ngày</label>
        <input id="revenue-date" type="date" value={date} onChange={(event) => setDate(event.target.value)} />
      </div>
      {error && (
        <p className="console-error" role="alert">
          {error}
        </p>
      )}
      {summary && (
        <dl className="revenue-summary mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <div className="card">
            <dt className="text-sm text-slate-500">Số đơn đã thanh toán</dt>
            <dd className="mt-1 text-3xl font-bold tabular-nums">{summary.paidOrderCount}</dd>
          </div>
          <div className="card border-l-4 border-l-emerald-500">
            <dt className="text-sm text-slate-500">Doanh thu</dt>
            <dd className="mt-1 text-3xl font-bold tabular-nums">{formatVnd(summary.revenueMinor)}</dd>
          </div>
          <div className="card">
            <dt className="text-sm text-slate-500">Số đơn hoàn tiền</dt>
            <dd className="mt-1 text-3xl font-bold tabular-nums">{summary.refundedOrderCount}</dd>
          </div>
          <div className="card border-l-4 border-l-red-400">
            <dt className="text-sm text-slate-500">Tổng hoàn tiền</dt>
            <dd className="mt-1 text-3xl font-bold tabular-nums">{formatVnd(summary.refundedMinor)}</dd>
          </div>
        </dl>
      )}
    </section>
  );
}
