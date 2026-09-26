import { useEffect, useRef, useState } from 'react';
import { apiSend, isErrorBody } from './api-client.ts';

const INVITE_HASH = /^#invite=(.+)$/;

/** Defaults to a real, full-page redirect — overridable so tests never navigate the actual test page away. */
function defaultRedirect(url: string): void {
  window.location.href = url;
}

export function InviteAccept({ redirect = defaultRedirect }: { redirect?: (url: string) => void }) {
  const invitationTokenRef = useRef<string | null>(null);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // The invitation token travels in the URL fragment (C7, D8): read it once, strip it immediately with
    // replaceState so it never sits in browser history or gets sent to the server as part of a navigation.
    const match = INVITE_HASH.exec(window.location.hash);
    if (match) {
      invitationTokenRef.current = decodeURIComponent(match[1]);
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
    setReady(true);
  }, []);

  async function handleSignIn() {
    setPending(true);
    setError(null);
    const body: { provider: 'google'; callbackURL: string; additionalData?: { invitationToken: string } } = {
      provider: 'google',
      callbackURL: '/console/kitchen',
    };
    if (invitationTokenRef.current) body.additionalData = { invitationToken: invitationTokenRef.current };
    const result = await apiSend<{ url: string; redirect: boolean }>('/api/auth/sign-in/social', 'POST', body);
    if (result.status !== 200 || !result.data || !('url' in result.data) || typeof result.data.url !== 'string') {
      setPending(false);
      setError(isErrorBody(result.data) ? result.data.error : 'Không thể bắt đầu đăng nhập, vui lòng thử lại.');
      return;
    }
    redirect(result.data.url);
  }

  if (!ready) return null;

  return (
    <main className="console-screen invite-accept standalone-screen">
      <h1 className="text-xl font-bold">Lời mời tham gia Console</h1>
      <p className="mt-2 text-sm text-slate-600">Đăng nhập bằng tài khoản Google được mời để tiếp tục.</p>
      {error && (
        <p className="console-error" role="alert">
          {error}
        </p>
      )}
      <button type="button" className="btn-primary mt-6 w-full" onClick={handleSignIn} disabled={pending}>
        {pending ? 'Đang chuyển hướng…' : 'Đăng nhập bằng Google'}
      </button>
    </main>
  );
}
