import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { TablesAdmin } from '../../apps/console/src/tables-admin.tsx';
import type { ConsoleSession } from '../../apps/console/src/api-client.ts';

const OWNER_SESSION: ConsoleSession = {
  user: { id: 'u1', email: 'owner@example.com', name: 'Owner' },
  store: { id: 's1' },
  role: 'owner',
  allowedActions: ['table:read', 'table:write', 'table:qr:export'],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const TABLES = { tables: [{ id: 't1', tableNumber: '5', isActive: true, liveTokens: 1 }] };
const QR_RESULT = { tokenUrl: 'http://store.test/t#SECRETTOKEN123', qrPayload: 'http://store.test/t#SECRETTOKEN123' };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TablesAdmin', () => {
  it('T17: "Xuất QR" shows the token exactly once; closing discards it for good', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(jsonResponse(TABLES));
    const screen = await render(<TablesAdmin session={OWNER_SESSION} />);
    await expect.element(screen.getByText('Bàn 5')).toBeInTheDocument();

    fetchMock.mockResolvedValueOnce(jsonResponse(QR_RESULT));
    await screen.getByRole('button', { name: 'Xuất QR — Bàn 5' }).click();

    await expect.element(screen.getByText(QR_RESULT.tokenUrl)).toBeInTheDocument();
    await expect.element(screen.getByText('chỉ hiện một lần', { exact: false })).toBeInTheDocument();

    await screen.getByRole('button', { name: 'Đóng' }).click();

    expect(screen.getByText(QR_RESULT.tokenUrl).query()).toBeNull();
    expect(screen.container.textContent).not.toContain('SECRETTOKEN123');
    // No control anywhere re-opens the token that was just discarded.
    expect(screen.getByRole('button', { name: 'Xem lại QR' }).query()).toBeNull();
  });
});
