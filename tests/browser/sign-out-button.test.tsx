import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { SignOutButton } from '../../apps/console/src/sign-out-button.tsx';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SignOutButton', () => {
  it('revokes the session through /api/auth/sign-out and only then returns to the sign-in screen', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{"success":true}', { status: 200 }));
    const redirect = vi.fn();

    const screen = await render(<SignOutButton redirect={redirect} />);
    await screen.getByRole('button', { name: 'Đăng xuất' }).click();

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/auth/sign-out');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    await vi.waitFor(() => expect(redirect).toHaveBeenCalledWith('/console'));
  });

  it('stays on the page and says so when the server does not confirm the sign-out', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{"error":"origin_denied"}', { status: 403 }));
    const redirect = vi.fn();

    const screen = await render(<SignOutButton redirect={redirect} />);
    await screen.getByRole('button', { name: 'Đăng xuất' }).click();

    await expect.element(screen.getByRole('alert')).toHaveTextContent('Đăng xuất chưa thành công');
    expect(redirect).not.toHaveBeenCalled();
  });
});
