import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { apiGet, apiSend, isErrorBody, type ConsoleSession } from './api-client.ts';

type ConsoleTable = { id: string; tableNumber: string; isActive: boolean; liveTokens: number };

const WRITE_ERROR_MESSAGE: Record<string, string> = {
  table_number_taken: 'Số bàn đã được dùng.',
  not_found: 'Không tìm thấy bàn.',
  rotation_conflict: 'Có yêu cầu xuất QR khác đang chạy, vui lòng thử lại.',
  invalid_field: 'Thiếu số bàn.',
};

function writeErrorMessage(code: string): string {
  return WRITE_ERROR_MESSAGE[code] ?? 'Không thực hiện được thao tác.';
}

async function loadTables(): Promise<ConsoleTable[]> {
  const result = await apiGet<{ tables: ConsoleTable[] }>('/api/console/tables');
  return result.status === 200 && result.data && 'tables' in result.data ? result.data.tables : [];
}

export function TablesAdmin({ session }: { session: ConsoleSession }) {
  const [tables, setTables] = useState<ConsoleTable[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newTableNumber, setNewTableNumber] = useState('');
  const [qrDialog, setQrDialog] = useState<{ tableId: string; tableNumber: string; tokenUrl: string; qrDataUrl: string } | null>(null);

  const canWrite = session.allowedActions.includes('table:write');
  const canExportQr = session.allowedActions.includes('table:qr:export');

  async function reload() {
    setTables(await loadTables());
  }

  useEffect(() => {
    if (session.allowedActions.includes('table:read')) reload();
  }, [session]);

  if (!session.allowedActions.includes('table:read')) {
    return <p role="alert">Bạn không có quyền truy cập trang này.</p>;
  }

  if (tables === null) return <p>Đang tải…</p>;

  async function createTable() {
    const tableNumber = newTableNumber.trim();
    if (tableNumber.length === 0) return;
    const result = await apiSend('/api/console/tables', 'POST', { tableNumber });
    if (result.status !== 201) {
      setError(writeErrorMessage(isErrorBody(result.data) ? result.data.error : 'invalid_field'));
      return;
    }
    setNewTableNumber('');
    setError(null);
    await reload();
  }

  async function toggleActive(table: ConsoleTable) {
    const result = await apiSend(`/api/console/tables/${table.id}`, 'PATCH', { isActive: !table.isActive });
    if (result.status !== 200) {
      setError('Không đổi được trạng thái bàn.');
      return;
    }
    await reload();
  }

  async function exportQr(table: ConsoleTable) {
    const result = await apiSend<{ tokenUrl: string; qrPayload: string }>(`/api/console/tables/${table.id}/qr`, 'POST');
    if (result.status !== 200 || !result.data || !('tokenUrl' in result.data)) {
      setError(writeErrorMessage(isErrorBody(result.data) ? result.data.error : 'not_found'));
      return;
    }
    const qrDataUrl = await QRCode.toDataURL(result.data.qrPayload);
    setError(null);
    setQrDialog({ tableId: table.id, tableNumber: table.tableNumber, tokenUrl: result.data.tokenUrl, qrDataUrl });
    await reload();
  }

  return (
    <section className="console-screen tables-admin" aria-label="Quản lý bàn">
      <h1 className="page-title">Bàn</h1>
      {error && (
        <p className="console-error" role="alert">
          {error}
        </p>
      )}
      <ul className="table-list card-grid mb-5">
        {tables.map((table) => (
          <li key={table.id} className="table-row card flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-lg font-semibold">Bàn {table.tableNumber}</span>
              <span className={table.isActive ? 'badge badge-success' : 'badge'}>{table.isActive ? 'Đang dùng' : 'Đã tắt'}</span>
            </div>
            <span className="text-sm text-slate-500">{table.liveTokens} mã QR còn hiệu lực</span>
            <div className="mt-1 flex flex-wrap gap-2 [&>button]:flex-1">
              {canWrite && (
                <button type="button" className={table.isActive ? 'btn-danger' : undefined} onClick={() => toggleActive(table)}>
                  {table.isActive ? 'Tắt bàn' : 'Bật bàn'}
                </button>
              )}
              {canExportQr && (
                <button type="button" className="btn-primary" aria-label={`Xuất QR — Bàn ${table.tableNumber}`} onClick={() => exportQr(table)}>
                  Xuất QR
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {canWrite && (
        <div className="table-new card flex flex-col sm:flex-row sm:items-end sm:gap-3">
          <div className="sm:flex-1">
            <label htmlFor="new-table-number">Số bàn mới</label>
            <input id="new-table-number" value={newTableNumber} onChange={(event) => setNewTableNumber(event.target.value)} />
          </div>
          <button type="button" className="btn-primary mt-3 sm:mt-0" onClick={createTable}>
            Thêm bàn
          </button>
        </div>
      )}
      {qrDialog && <div className="dialog-backdrop" aria-hidden="true" />}
      {qrDialog && (
        <div role="dialog" aria-label={`QR bàn ${qrDialog.tableNumber}`} className="qr-dialog">
          <img className="mx-auto size-56" src={qrDialog.qrDataUrl} alt={`Mã QR bàn ${qrDialog.tableNumber}`} />
          <p className="qr-url">{qrDialog.tokenUrl}</p>
          <p role="alert" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
            Đường dẫn này chỉ hiện một lần — hãy lưu lại hoặc in ngay, đóng hộp thoại này sẽ không xem lại được.
          </p>
          <button type="button" className="mt-4 w-full" onClick={() => setQrDialog(null)}>
            Đóng
          </button>
        </div>
      )}
    </section>
  );
}
