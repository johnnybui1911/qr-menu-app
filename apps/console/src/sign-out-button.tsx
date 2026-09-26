import { useState } from 'react';
import { apiSend } from './api-client.ts';

/** Defaults to a real, full-page navigation — overridable so tests never navigate the actual test page away. */
function defaultRedirect(url: string): void {
  window.location.assign(url);
}

/**
 * Ends the better-auth session on the server (the row is deleted, so the old cookie stops working everywhere) and
 * only then reloads to the sign-in screen. Staff share devices at the counter, so leaving the browser signed in
 * after a failed request would be worse than saying it failed.
 */
export function SignOutButton({ redirect = defaultRedirect }: { redirect?: (url: string) => void }) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function signOut() {
    setPending(true);
    setFailed(false);
    let confirmed = false;
    try {
      confirmed = (await apiSend('/api/auth/sign-out', 'POST', {})).status === 200;
    } catch {
      // fetch rejects when offline / on a dropped connection — same outcome as a refused sign-out: say so, stay here.
    }
    if (!confirmed) {
      setPending(false);
      setFailed(true);
      return;
    }
    redirect('/console');
  }

  return (
    <div className="sign-out">
      {failed && (
        <p className="console-error" role="alert">
          Đăng xuất chưa thành công, vui lòng thử lại.
        </p>
      )}
      <button type="button" onClick={signOut} disabled={pending}>
        {pending ? 'Đang đăng xuất…' : 'Đăng xuất'}
      </button>
    </div>
  );
}
