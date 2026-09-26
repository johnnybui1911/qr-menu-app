import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { StaffAdmin } from '../../apps/console/src/staff-admin.tsx';
import type { ConsoleSession } from '../../apps/console/src/api-client.ts';

const OWNER_SESSION: ConsoleSession = {
  user: { id: 'u1', email: 'owner@example.com', name: 'Owner' },
  store: { id: 's1' },
  role: 'owner',
  allowedActions: [],
};

const STAFF_SESSION: ConsoleSession = {
  user: { id: 'u2', email: 'staff@example.com', name: 'Staff' },
  store: { id: 's1' },
  role: 'staff',
  allowedActions: [],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('StaffAdmin', () => {
  it('T21: an Owner invites a staff member; the link shows once; a Staff session never renders this screen', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(jsonResponse({ invitations: [] }));
    const screen = await render(<StaffAdmin session={OWNER_SESSION} />);
    await expect.element(screen.getByLabelText('Email nhân viên')).toBeInTheDocument();

    await screen.getByLabelText('Email nhân viên').fill('  NewStaff@Example.com  ');
    await screen.getByLabelText('Vai trò').selectOptions('staff');

    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { id: 'inv1', invitationUrl: 'http://console.test/console/invite#invite=TOKEN123', expiresAt: '2026-10-01T00:00:00.000Z', targetEmail: 'newstaff@example.com', role: 'staff' },
        201,
      ),
    );
    // sendInvitation() reloads the list right after a successful POST.
    fetchMock.mockResolvedValueOnce(jsonResponse({ invitations: [{ id: 'inv1', targetEmail: 'newstaff@example.com', role: 'staff', status: 'pending', expiresAt: '2026-10-01T00:00:00.000Z', createdAt: '2026-09-26T00:00:00.000Z' }] }));
    await screen.getByRole('button', { name: 'Gửi lời mời' }).click();

    const [invitePath, inviteInit] = fetchMock.mock.calls[1] as [string, RequestInit & { body: string }];
    expect(invitePath).toBe('/api/console/invitations');
    expect(JSON.parse(inviteInit.body)).toEqual({ targetEmail: 'newstaff@example.com', role: 'staff' });

    await expect.element(screen.getByText('http://console.test/console/invite#invite=TOKEN123')).toBeInTheDocument();
    await screen.getByRole('button', { name: 'Đóng' }).click();
    expect(screen.getByText('http://console.test/console/invite#invite=TOKEN123').query()).toBeNull();

    // Unmount first: two simultaneously-mounted trees would otherwise both carry `id="invite-email"`, which is
    // invalid HTML and makes label association undefined — a Staff session must never even reach that state.
    await screen.unmount();

    const callsBeforeStaffRender = fetchMock.mock.calls.length;
    const staffScreen = await render(<StaffAdmin session={STAFF_SESSION} />);
    expect(staffScreen.getByLabelText('Email nhân viên').query()).toBeNull();
    expect(fetchMock.mock.calls.length).toBe(callsBeforeStaffRender);
  });
});
