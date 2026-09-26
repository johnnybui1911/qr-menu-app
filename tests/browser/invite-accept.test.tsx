import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { InviteAccept } from '../../apps/console/src/invite-accept.tsx';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/console/invite');
});

describe('InviteAccept', () => {
  it('T19: the invitation token leaves the URL and is carried into Google sign-in', async () => {
    window.history.replaceState(null, '', '/console/invite#invite=abc123');
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const redirect = vi.fn();

    const screen = await render(<InviteAccept redirect={redirect} />);

    expect(window.location.hash).toBe('');
    expect(window.location.href).not.toContain('abc123');

    fetchMock.mockResolvedValueOnce(jsonResponse({ url: 'https://accounts.google.com/o/oauth2/auth?fake=1', redirect: true }));
    await screen.getByRole('button', { name: 'Đăng nhập bằng Google' }).click();

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit & { body: string; credentials: string }];
    expect(path).toBe('/api/auth/sign-in/social');
    expect(init.credentials).toBe('same-origin');
    const body = JSON.parse(init.body) as { provider: string; additionalData?: { invitationToken?: string } };
    expect(body.provider).toBe('google');
    expect(body.additionalData?.invitationToken).toBe('abc123');

    expect(redirect).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/auth?fake=1');
  });
});
