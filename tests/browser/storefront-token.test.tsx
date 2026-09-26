import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { App } from '../../apps/storefront/src/app.tsx';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const MENU_BODY = { table: { tableNumber: 7 }, categories: [] };

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  window.history.pushState(null, '', '/');
});

describe('storefront route token handling', () => {
  it('T1: strips the table token from the URL and sends it as a request header', async () => {
    const token = 'a'.repeat(43);
    window.history.pushState(null, '', `/t#${token}`);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(MENU_BODY));

    await render(<App />);

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());

    expect(window.location.hash).toBe('');
    expect(window.location.search).not.toContain(token);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get('x-table-token')).toBe(token);
  });

  it('T2: shows the rescan message and calls no API when the fragment is missing', async () => {
    window.history.pushState(null, '', '/t');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const screen = await render(<App />);

    await expect.element(screen.getByText('Vui lòng quét lại mã QR')).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
