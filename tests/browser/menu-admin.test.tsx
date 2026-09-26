import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { MenuAdmin } from '../../apps/console/src/menu-admin.tsx';
import type { ConsoleSession } from '../../apps/console/src/api-client.ts';

const OWNER_SESSION: ConsoleSession = {
  user: { id: 'u1', email: 'owner@example.com', name: 'Owner' },
  store: { id: 's1' },
  role: 'owner',
  allowedActions: ['menu:read', 'menu:write', 'menu:image:write', 'menu:stock:toggle'],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const CATEGORIES = {
  categories: [
    {
      id: 'cat1',
      name: 'Trà',
      slug: 'tra',
      displayOrder: 0,
      isActive: true,
      products: [
        {
          id: 'p1',
          categoryId: 'cat1',
          name: 'Trà đào',
          description: '',
          priceMinor: 45000,
          currency: 'VND',
          isAvailable: true,
          isActive: true,
          displayOrder: 0,
          revision: 1,
          imageId: null,
        },
      ],
    },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MenuAdmin', () => {
  it('T16: a 409 revision_conflict shows a clear message and never silently overwrites', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(jsonResponse(CATEGORIES));
    const screen = await render(<MenuAdmin session={OWNER_SESSION} />);
    await expect.element(screen.getByText('Trà đào')).toBeInTheDocument();

    await screen.getByRole('button', { name: 'Sửa món Trà đào' }).click();
    const nameField = screen.getByLabelText('Tên món');
    await nameField.fill('Trà đào mới');

    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'revision_conflict' }, 409));
    await screen.getByRole('button', { name: 'Lưu món' }).click();

    await expect.element(screen.getByText('Món đã được sửa ở nơi khác, tải lại.')).toBeInTheDocument();
    await expect.element(screen.getByRole('button', { name: 'Tải lại' })).toBeInTheDocument();
    // Never overwritten silently: the original name is still what is displayed in the list.
    await expect.element(screen.getByText('Trà đào')).toBeInTheDocument();
  });
});
