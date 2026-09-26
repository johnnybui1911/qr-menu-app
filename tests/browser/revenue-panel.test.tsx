import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { RevenuePanel } from '../../apps/console/src/revenue-panel.tsx';
import type { ConsoleSession } from '../../apps/console/src/api-client.ts';

const OWNER_SESSION: ConsoleSession = {
  user: { id: 'u1', email: 'owner@example.com', name: 'Owner' },
  store: { id: 's1' },
  role: 'owner',
  allowedActions: ['report:read'],
};

const STAFF_SESSION: ConsoleSession = {
  user: { id: 'u2', email: 'staff@example.com', name: 'Staff' },
  store: { id: 's1' },
  role: 'staff',
  allowedActions: [],
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RevenuePanel', () => {
  it('T22: renders totals straight from the API, never re-computed from an order list', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(jsonResponse({ date: '2026-09-26', paidOrderCount: 5, revenueMinor: 2_500_000, refundedOrderCount: 1, refundedMinor: 100_000 }));
    const screen = await render(<RevenuePanel session={OWNER_SESSION} initialDate="2026-09-26" />);

    expect(fetchMock).toHaveBeenCalledWith('/api/console/revenue?date=2026-09-26', expect.anything());
    await expect.element(screen.getByText('5', { exact: true })).toBeInTheDocument();
    await expect.element(screen.getByText('1', { exact: true })).toBeInTheDocument();
    await expect.element(screen.getByText('2.500.000\u00a0₫', { exact: true })).toBeInTheDocument();
    await expect.element(screen.getByText('100.000\u00a0₫', { exact: true })).toBeInTheDocument();
  });

  it('a Staff session (no report:read) never renders and never calls the endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const screen = await render(<RevenuePanel session={STAFF_SESSION} initialDate="2026-09-26" />);
    expect(screen.getByText('2.500.000\u00a0₫').query()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
