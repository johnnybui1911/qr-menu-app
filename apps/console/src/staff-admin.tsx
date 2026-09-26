import { useEffect, useState } from 'react';
import { apiGet, apiSend, isErrorBody, type ConsoleSession } from './api-client.ts';

type Invitation = { id: string; targetEmail: string; role: 'owner' | 'staff'; status: 'pending' | 'revoked' | 'consumed'; expiresAt: string; createdAt: string };

const INVITE_ERROR_MESSAGE: Record<string, string> = {
  invalid_email: 'Email không hợp lệ.',
  invalid_role: 'Vai trò không hợp lệ.',
  invalid_json: 'Dữ liệu gửi lên không hợp lệ.',
  invalid_invitation: 'Không tạo được lời mời.',
  auth_not_configured: 'Đăng nhập chưa được cấu hình.',
};

function inviteErrorMessage(code: string): string {
  return INVITE_ERROR_MESSAGE[code] ?? 'Không gửi được lời mời.';
}

async function loadInvitations(): Promise<Invitation[]> {
  const result = await apiGet<{ invitations: Invitation[] }>('/api/console/invitations');
  return result.status === 200 && result.data && 'invitations' in result.data ? result.data.invitations : [];
}

export function StaffAdmin({ session }: { session: ConsoleSession }) {
  const [invitations, setInvitations] = useState<Invitation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'owner' | 'staff'>('staff');
  const [newInvitationUrl, setNewInvitationUrl] = useState<string | null>(null);

  const isOwner = session.role === 'owner';

  async function reload() {
    setInvitations(await loadInvitations());
  }

  useEffect(() => {
    if (isOwner) reload();
    // Staff never triggers a fetch to this owner-only surface at all (D20 access control mirrored in the UI).
  }, [isOwner]);

  if (!isOwner) {
    return <p role="alert">Bạn không có quyền truy cập trang này.</p>;
  }

  if (invitations === null) return <p>Đang tải…</p>;

  async function sendInvitation() {
    const targetEmail = email.trim().toLowerCase();
    if (targetEmail.length === 0) return;
    const result = await apiSend<{ invitationUrl: string }>('/api/console/invitations', 'POST', { targetEmail, role });
    if (result.status !== 201 || !result.data || !('invitationUrl' in result.data)) {
      setError(inviteErrorMessage(isErrorBody(result.data) ? result.data.error : 'invalid_email'));
      return;
    }
    setError(null);
    setEmail('');
    setNewInvitationUrl(result.data.invitationUrl);
    await reload();
  }

  async function revokeInvitation(invitationId: string) {
    const result = await apiSend(`/api/console/invitations/${invitationId}/revoke`, 'POST');
    if (result.status !== 200) {
      setError('Không thu hồi được lời mời.');
      return;
    }
    await reload();
  }

  return (
    <section className="console-screen staff-admin" aria-label="Quản lý nhân viên">
      <h1 className="page-title">Nhân viên</h1>
      {error && (
        <p className="console-error" role="alert">
          {error}
        </p>
      )}
      {newInvitationUrl && <div className="dialog-backdrop" aria-hidden="true" />}
      {newInvitationUrl && (
        <div role="dialog" aria-label="Lời mời đã tạo" className="invitation-dialog">
          <p className="text-sm font-medium">Gửi đường dẫn này cho nhân viên (chỉ hiện một lần):</p>
          <p className="invitation-url">{newInvitationUrl}</p>
          <button type="button" className="w-full" onClick={() => setNewInvitationUrl(null)}>
            Đóng
          </button>
        </div>
      )}
      <div className="staff-invite-form card mb-6 grid gap-x-3 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
        <div>
          <label htmlFor="invite-email">Email nhân viên</label>
          <input id="invite-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
        </div>
        <div>
          <label htmlFor="invite-role">Vai trò</label>
          <select id="invite-role" value={role} onChange={(event) => setRole(event.target.value === 'owner' ? 'owner' : 'staff')}>
            <option value="staff">Nhân viên</option>
            <option value="owner">Chủ quán</option>
          </select>
        </div>
        <button type="button" className="btn-primary mt-3 sm:mt-0" onClick={sendInvitation}>
          Gửi lời mời
        </button>
      </div>
      <h2 className="section-title">Lời mời đang chờ</h2>
      <ul className="invitation-list card divide-y divide-slate-100 p-0 empty:hidden">
        {invitations.map((invitation) => (
          <li key={invitation.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm [overflow-wrap:anywhere]">
            {invitation.targetEmail} — {invitation.role === 'owner' ? 'Chủ quán' : 'Nhân viên'} — {invitation.status}
            {invitation.status === 'pending' && (
              <button type="button" className="btn-danger" onClick={() => revokeInvitation(invitation.id)}>
                Thu hồi
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
