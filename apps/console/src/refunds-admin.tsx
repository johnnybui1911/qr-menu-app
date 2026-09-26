import { useEffect, useState } from 'react';
import { apiGet, apiSend, type ConsoleSession } from './api-client.ts';
import { formatVnd } from './format-money.ts';

type RefundRequest = {
  id: string;
  orderId: string;
  orderCode: string;
  tableNumber: string;
  amountMinor: number;
  orderStatus: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  requestedByStaffId: string;
  createdAt: string;
  decidedAt: string | null;
};

async function loadPendingRefunds(): Promise<RefundRequest[]> {
  const result = await apiGet<{ refundRequests: RefundRequest[] }>('/api/console/refund-requests?status=pending');
  return result.status === 200 && result.data && 'refundRequests' in result.data ? result.data.refundRequests : [];
}

export function RefundsAdmin({ session }: { session: ConsoleSession }) {
  const [requests, setRequests] = useState<RefundRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingRejectId, setConfirmingRejectId] = useState<string | null>(null);
  const [rejectConfirmed, setRejectConfirmed] = useState(false);

  async function reload() {
    setRequests(await loadPendingRefunds());
  }

  useEffect(() => {
    if (session.allowedActions.includes('refund:decide')) reload();
  }, [session]);

  if (!session.allowedActions.includes('refund:decide')) {
    return <p role="alert">Bạn không có quyền truy cập trang này.</p>;
  }

  if (requests === null) return <p>Đang tải…</p>;

  async function decide(refundRequestId: string, decision: 'approve' | 'reject') {
    const result = await apiSend(`/api/console/refund-requests/${refundRequestId}/decide`, 'POST', { decision });
    if (result.status !== 200) {
      setError('Không xử lý được yêu cầu hoàn tiền.');
      return;
    }
    setError(null);
    setConfirmingRejectId(null);
    setRejectConfirmed(false);
    await reload();
  }

  return (
    <section className="console-screen refunds-admin" aria-label="Duyệt hoàn tiền">
      <h1 className="page-title">Yêu cầu hoàn tiền</h1>
      {error && (
        <p className="console-error" role="alert">
          {error}
        </p>
      )}
      {requests.length === 0 && <p className="card text-center text-sm text-slate-500">Không có yêu cầu nào đang chờ.</p>}
      <ul className="refund-list space-y-3">
        {requests.map((request) => (
          <li key={request.id} className="refund-row card flex flex-wrap items-start gap-2">
            <p className="w-full">
              <strong className="font-mono">{request.orderCode}</strong> — Bàn {request.tableNumber} — {formatVnd(request.amountMinor)}
            </p>
            <p className="w-full text-sm text-slate-600">Lý do nhân viên: {request.reason}</p>
            <button type="button" className="btn-primary" onClick={() => decide(request.id, 'approve')}>
              Duyệt
            </button>
            {confirmingRejectId === request.id ? (
              <div className="refund-reject-confirm flex w-full flex-wrap items-center gap-2 rounded-lg bg-red-50 p-3">
                <input
                  id={`reject-confirm-${request.id}`}
                  type="checkbox"
                  checked={rejectConfirmed}
                  onChange={(event) => setRejectConfirmed(event.target.checked)}
                />
                <label htmlFor={`reject-confirm-${request.id}`} className="m-0 flex-1 text-red-800">
                  Tôi xác nhận từ chối yêu cầu này
                </label>
                <button type="button" className="btn-danger" disabled={!rejectConfirmed} onClick={() => decide(request.id, 'reject')}>
                  Xác nhận từ chối
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setConfirmingRejectId(null);
                    setRejectConfirmed(false);
                  }}
                >
                  Huỷ
                </button>
              </div>
            ) : (
              <button type="button" className="btn-danger" onClick={() => setConfirmingRejectId(request.id)}>
                Từ chối
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
