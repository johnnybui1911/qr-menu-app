import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { RefundsAdmin } from '../../apps/console/src/refunds-admin.tsx';
import type { ConsoleSession } from '../../apps/console/src/api-client.ts';

const OWNER_SESSION: ConsoleSession = {
  user: { id: 'u1', email: 'owner@example.com', name: 'Owner' },
  store: { id: 's1' },
  role: 'owner',
  allowedActions: ['refund:decide'],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const PENDING = {
  refundRequests: [
    {
      id: 'r1',
      orderId: 'o1',
      orderCode: 'QM1',
      tableNumber: '5',
      amountMinor: 45000,
      orderStatus: 'paid',
      reason: 'Khách đổi ý',
      status: 'pending',
      requestedByStaffId: 'staff-1',
      createdAt: '2026-09-26T10:00:00.000Z',
      decidedAt: null,
    },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RefundsAdmin', () => {
  it('T18a: rejecting a refund request requires an explicit confirm step before it fires', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(jsonResponse(PENDING));
    const screen = await render(<RefundsAdmin session={OWNER_SESSION} />);
    await expect.element(screen.getByText('QM1')).toBeInTheDocument();
    await expect.element(screen.getByText('Khách đổi ý')).toBeInTheDocument();

    await screen.getByRole('button', { name: 'Từ chối' }).click();
    const confirmButton = screen.getByRole('button', { name: 'Xác nhận từ chối' });
    expect((confirmButton.element() as HTMLButtonElement).disabled).toBe(true);

    await screen.getByRole('checkbox', { name: 'Tôi xác nhận từ chối yêu cầu này' }).click();
    expect((confirmButton.element() as HTMLButtonElement).disabled).toBe(false);

    fetchMock.mockResolvedValueOnce(jsonResponse({ refundRequestId: 'r1', orderId: 'o1', status: 'rejected' }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ refundRequests: [] }));
    await confirmButton.click();

    const rejectCall = fetchMock.mock.calls.find(([path]) => path === '/api/console/refund-requests/r1/decide');
    expect(rejectCall).toBeDefined();
    const [, rejectInit] = rejectCall as [string, RequestInit & { body: string }];
    expect(JSON.parse(rejectInit.body)).toEqual({ decision: 'reject' });

    // The reload after the decision confirms the whole round-trip actually completed, not just the click event.
    await expect.element(screen.getByText('Không có yêu cầu nào đang chờ.')).toBeInTheDocument();
  });

  it('T18b: approving sends the decision with a stable Idempotency-Key, no confirm step required', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(jsonResponse(PENDING));
    const screen = await render(<RefundsAdmin session={OWNER_SESSION} />);
    await expect.element(screen.getByText('QM1')).toBeInTheDocument();

    fetchMock.mockResolvedValueOnce(jsonResponse({ refundRequestId: 'r1', orderId: 'o1', status: 'approved' }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ refundRequests: [] }));
    await screen.getByRole('button', { name: 'Duyệt' }).click();

    const approveCall = fetchMock.mock.calls.find(([path]) => path === '/api/console/refund-requests/r1/decide');
    expect(approveCall).toBeDefined();
    const [, approveInit] = approveCall as [string, RequestInit & { headers: Record<string, string>; body: string }];
    expect(JSON.parse(approveInit.body)).toEqual({ decision: 'approve' });
    expect(approveInit.headers['idempotency-key']).toBeTruthy();

    await expect.element(screen.getByText('Không có yêu cầu nào đang chờ.')).toBeInTheDocument();
  });
});
