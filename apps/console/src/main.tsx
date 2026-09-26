import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { apiGet, apiSend, isErrorBody, type ConsoleSession } from './api-client.ts';
import './app.css';
import { InviteAccept } from './invite-accept.tsx';
import { KitchenBoard } from './kitchen-board.tsx';
import { MenuAdmin } from './menu-admin.tsx';
import { RefundsAdmin } from './refunds-admin.tsx';
import { RevenuePanel } from './revenue-panel.tsx';
import { StaffAdmin } from './staff-admin.tsx';
import { SignOutButton } from './sign-out-button.tsx';
import { TablesAdmin } from './tables-admin.tsx';

type SessionState =
  | { kind: 'loading' }
  | { kind: 'unauthenticated' }
  | { kind: 'service-unavailable' }
  | { kind: 'store-access-denied' }
  | { kind: 'ready'; session: ConsoleSession };

type Route = { path: string; label: string; visible: (session: ConsoleSession) => boolean; render: (session: ConsoleSession) => React.ReactNode };

const ROUTES: Route[] = [
  { path: '/console/kitchen', label: 'Bếp', visible: (session) => session.allowedActions.includes('order:read'), render: (session) => <KitchenBoard session={session} /> },
  { path: '/console/menu', label: 'Menu', visible: (session) => session.allowedActions.includes('menu:read'), render: (session) => <MenuAdmin session={session} /> },
  { path: '/console/tables', label: 'Bàn', visible: (session) => session.allowedActions.includes('table:read'), render: (session) => <TablesAdmin session={session} /> },
  { path: '/console/refunds', label: 'Hoàn tiền', visible: (session) => session.allowedActions.includes('refund:decide'), render: (session) => <RefundsAdmin session={session} /> },
  { path: '/console/revenue', label: 'Doanh thu', visible: (session) => session.allowedActions.includes('report:read'), render: (session) => <RevenuePanel session={session} /> },
  { path: '/console/staff', label: 'Nhân viên', visible: (session) => session.role === 'owner', render: (session) => <StaffAdmin session={session} /> },
];

function normalizePath(pathname: string): string {
  return ROUTES.some((route) => route.path === pathname) ? pathname : ROUTES[0].path;
}

function useConsolePath(): [string, (path: string) => void] {
  const [path, setPath] = useState(() => normalizePath(window.location.pathname));

  useEffect(() => {
    function onPopState() {
      setPath(normalizePath(window.location.pathname));
    }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  function navigate(nextPath: string) {
    if (nextPath !== window.location.pathname) window.history.pushState(null, '', nextPath);
    setPath(normalizePath(nextPath));
  }

  return [path, navigate];
}

function useConsoleSession(enabled: boolean): SessionState {
  const [state, setState] = useState<SessionState>({ kind: 'loading' });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    apiGet<ConsoleSession>('/api/console/session').then((result) => {
      if (cancelled) return;
      if (result.status === 200 && result.data && 'allowedActions' in result.data) {
        setState({ kind: 'ready', session: result.data });
      } else if (result.status === 403) {
        setState({ kind: 'store-access-denied' });
      } else if (result.status === 503) {
        setState({ kind: 'service-unavailable' });
      } else {
        setState({ kind: 'unauthenticated' });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return state;
}

function SignInScreen() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setPending(true);
    setError(null);
    const result = await apiSend<{ url: string }>('/api/auth/sign-in/social', 'POST', { provider: 'google', callbackURL: '/console/kitchen' });
    if (result.status !== 200 || !result.data || !('url' in result.data) || typeof result.data.url !== 'string') {
      setPending(false);
      setError(isErrorBody(result.data) ? result.data.error : 'Không thể bắt đầu đăng nhập, vui lòng thử lại.');
      return;
    }
    window.location.href = result.data.url;
  }

  return (
    <main className="console-screen sign-in-screen">
      <h1>QR Menu Console</h1>
      <p>Đăng nhập bằng tài khoản Google được cấp quyền để tiếp tục.</p>
      {error && (
        <p className="console-error" role="alert">
          {error}
        </p>
      )}
      <button type="button" onClick={signIn} disabled={pending}>
        {pending ? 'Đang chuyển hướng…' : 'Đăng nhập bằng Google'}
      </button>
    </main>
  );
}

function ConsoleRouter({ session }: { session: ConsoleSession }) {
  const [path, navigate] = useConsolePath();
  const route = ROUTES.find((candidate) => candidate.path === path) ?? ROUTES[0];

  return (
    <div className="console-shell">
      <nav className="console-nav" aria-label="Điều hướng Console">
        {ROUTES.filter((candidate) => candidate.visible(session)).map((candidate) => (
          <a
            key={candidate.path}
            href={candidate.path}
            aria-current={candidate.path === route.path ? 'page' : undefined}
            onClick={(event) => {
              event.preventDefault();
              navigate(candidate.path);
            }}
          >
            {candidate.label}
          </a>
        ))}
        <div className="console-account">
          <span className="console-account-email">{session.user.email}</span>
          <SignOutButton />
        </div>
      </nav>
      <main className="console-main">{route.render(session)}</main>
    </div>
  );
}

function ConsoleApp() {
  const invited = window.location.pathname === '/console/invite';
  const session = useConsoleSession(!invited);

  if (invited) return <InviteAccept />;

  switch (session.kind) {
    case 'loading':
      return <p>Đang tải…</p>;
    case 'unauthenticated':
      return <SignInScreen />;
    case 'service-unavailable':
      return <p role="alert">Đăng nhập chưa được cấu hình, vui lòng liên hệ quản trị viên.</p>;
    case 'store-access-denied':
      // A Google account without an active membership still holds a valid session; without a way out the only
      // fix would be clearing cookies by hand before trying another account.
      return (
        <main className="console-screen">
          <p role="alert">Tài khoản này không có quyền truy cập Console.</p>
          <SignOutButton />
        </main>
      );
    case 'ready':
      return <ConsoleRouter session={session.session} />;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConsoleApp />
  </StrictMode>,
);
