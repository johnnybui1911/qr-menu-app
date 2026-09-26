import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { KitchenBoard } from '../../apps/console/src/kitchen-board.tsx';
import type { ConsoleSession } from '../../apps/console/src/api-client.ts';

const OWNER_SESSION: ConsoleSession = {
  user: { id: 'u1', email: 'owner@example.com', name: 'Owner' },
  store: { id: 's1' },
  role: 'owner',
  allowedActions: ['order:read', 'order:prepare', 'order:fulfill', 'refund:request', 'report:read'],
};

const STAFF_SESSION: ConsoleSession = {
  user: { id: 'u2', email: 'staff@example.com', name: 'Staff' },
  store: { id: 's1' },
  role: 'staff',
  allowedActions: ['order:read', 'order:prepare', 'order:fulfill', 'refund:request'],
};

type OrderFixture = {
  id: string;
  orderCode: string;
  tableNumber: string;
  status: 'paid' | 'preparing' | 'fulfilled' | 'cancelled' | 'refunded' | 'pending_payment';
  totalAmountMinor: number;
  needsAttention: boolean;
  createdAt: string;
  updatedAt: string;
  items: { productName: string; quantity: number; notes: string | null }[];
};

function order(overrides: Partial<OrderFixture> & { id: string; orderCode: string }): OrderFixture {
  return {
    tableNumber: '5',
    status: 'paid',
    totalAmountMinor: 45000,
    needsAttention: false,
    createdAt: '2026-09-26T10:00:00.000Z',
    updatedAt: '2026-09-26T10:00:00.000Z',
    items: [{ productName: 'Trà đào', quantity: 2, notes: null }],
    ...overrides,
  };
}

function jsonResponse(body: unknown, etag?: string): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...(etag ? { etag } : {}) } });
}

function notModified(): Response {
  return new Response(null, { status: 304 });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('KitchenBoard', () => {
  it('T11: polls every 3s with the last cursor and If-None-Match', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(jsonResponse({ orders: [order({ id: 'o1', orderCode: 'QM1' })], since: '2026-09-26T10:00:00.000Z,o1' }, '"etag-1"'));
    const screen = await render(<KitchenBoard session={OWNER_SESSION} />);
    await expect.element(screen.getByText('QM1')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(notModified());
    await vi.advanceTimersByTimeAsync(3000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [secondPath, secondInit] = fetchMock.mock.calls[1] as [string, RequestInit & { headers: Record<string, string> }];
    expect(secondPath).toBe(`/api/console/orders?since=${encodeURIComponent('2026-09-26T10:00:00.000Z,o1')}`);
    expect(secondInit.headers['if-none-match']).toBe('"etag-1"');
  });

  it('T12: a 304 response never re-renders the ticket list', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(jsonResponse({ orders: [order({ id: 'o1', orderCode: 'QM1' })], since: 'c1' }, '"etag-1"'));
    const screen = await render(<KitchenBoard session={OWNER_SESSION} />);
    await expect.element(screen.getByText('QM1')).toBeInTheDocument();
    const ticketNode = screen.getByTestId('ticket-o1').element();

    fetchMock.mockResolvedValueOnce(notModified());
    await vi.advanceTimersByTimeAsync(3000);

    expect(screen.getByTestId('ticket-o1').element()).toBe(ticketNode);
  });

  it('T13: a new order surfaces within one 3s poll, grouped by its table', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(jsonResponse({ orders: [order({ id: 'o1', orderCode: 'QM1', tableNumber: '5' })], since: 'c1' }, '"etag-1"'));
    const screen = await render(<KitchenBoard session={OWNER_SESSION} />);
    await expect.element(screen.getByText('QM1')).toBeInTheDocument();

    fetchMock.mockResolvedValueOnce(jsonResponse({ orders: [order({ id: 'o2', orderCode: 'QM2', tableNumber: '9' })], since: 'c2' }, '"etag-2"'));
    await vi.advanceTimersByTimeAsync(3000);

    await expect.element(screen.getByText('QM2')).toBeInTheDocument();
    await expect.element(screen.getByText('Bàn 9')).toBeInTheDocument();
    await expect.element(screen.getByText('Bàn 5')).toBeInTheDocument();
  });

  it('T14: needsAttention shows a badge; only a session with report:read sees the provider-events link', async () => {
    const ownerFetch = vi.spyOn(globalThis, 'fetch');
    ownerFetch.mockResolvedValueOnce(jsonResponse({ orders: [order({ id: 'o1', orderCode: 'QM1', needsAttention: true })], since: 'c1' }, '"etag-1"'));
    const ownerScreen = await render(<KitchenBoard session={OWNER_SESSION} />);
    await expect.element(ownerScreen.getByText('QM1')).toBeInTheDocument();
    await expect.element(ownerScreen.getByText('Cần chú ý')).toBeInTheDocument();
    await expect.element(ownerScreen.getByRole('button', { name: 'Xem giao dịch' })).toBeInTheDocument();
    await ownerScreen.unmount();
    ownerFetch.mockRestore();

    const staffFetch = vi.spyOn(globalThis, 'fetch');
    staffFetch.mockResolvedValueOnce(jsonResponse({ orders: [order({ id: 'o1', orderCode: 'QM1', needsAttention: true })], since: 'c1' }, '"etag-1"'));
    const staffScreen = await render(<KitchenBoard session={STAFF_SESSION} />);
    await expect.element(staffScreen.getByText('QM1')).toBeInTheDocument();
    expect(staffScreen.getByRole('button', { name: 'Xem giao dịch' }).query()).toBeNull();
  });

  it('T15: action buttons only render for allowedActions the session actually has', async () => {
    const limitedSession: ConsoleSession = { ...STAFF_SESSION, allowedActions: ['order:read'] };
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(jsonResponse({ orders: [order({ id: 'o1', orderCode: 'QM1', status: 'paid' })], since: 'c1' }, '"etag-1"'));
    const screen = await render(<KitchenBoard session={limitedSession} />);
    await expect.element(screen.getByText('QM1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Nhận đơn & Chế biến' }).query()).toBeNull();
    expect(screen.getByRole('button', { name: 'Yêu cầu hoàn tiền' }).query()).toBeNull();
  });

  it('A3: the 3s poll timer is cleared on unmount', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(jsonResponse({ orders: [order({ id: 'o1', orderCode: 'QM1' })], since: 'c1' }, '"etag-1"'));
    const screen = await render(<KitchenBoard session={OWNER_SESSION} />);
    await expect.element(screen.getByText('QM1')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await screen.unmount();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
