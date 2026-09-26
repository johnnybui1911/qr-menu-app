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
    <main className="console-screen sign-in-screen standalone-screen">
      <h1 className="text-xl font-bold">QR Menu Console</h1>
      <p className="mt-2 text-sm text-slate-600">Đăng nhập bằng tài khoản Google được cấp quyền để tiếp tục.</p>
      {error && (
        <p className="console-error" role="alert">
          {error}
        </p>
      )}
      <button type="button" className="btn-primary mt-6 w-full" onClick={signIn} disabled={pending}>
        {pending ? 'Đang chuyển hướng…' : 'Đăng nhập bằng Google'}
      </button>
    </main>
  );
}

function ConsoleRouter({ session }: { session: ConsoleSession }) {
  const [path, navigate] = useConsolePath();
  const route = ROUTES.find((candidate) => candidate.path === path) ?? ROUTES[0];

  return (
    <div className="console-shell min-h-dvh lg:grid lg:grid-cols-[240px_1fr]">
      <nav
        className="console-nav sticky top-0 z-10 grid grid-cols-[1fr_auto] items-center gap-x-3 border-b border-slate-200 bg-white/90 px-4 pt-2 backdrop-blur lg:flex lg:h-dvh lg:flex-col lg:items-stretch lg:border-r lg:border-b-0 lg:p-4"
        aria-label="Điều hướng Console"
      >
        <div className="flex items-center gap-2 text-base font-bold whitespace-nowrap text-slate-900 lg:mb-6 lg:px-3">
          <span className="grid size-8 place-items-center rounded-lg bg-brand-600 text-sm text-white" aria-hidden="true">
            QR
          </span>
          QR Menu
        </div>
        <div className="col-span-2 row-start-2 -mx-4 flex gap-1 overflow-x-auto px-4 py-2 [scrollbar-width:none] lg:mx-0 lg:flex-col lg:overflow-visible lg:p-0">
          {ROUTES.filter((candidate) => candidate.visible(session)).map((candidate) => (
            <a
              key={candidate.path}
              href={candidate.path}
              className="flex min-h-11 shrink-0 items-center rounded-lg px-3 text-sm font-medium whitespace-nowrap text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900 aria-[current=page]:bg-brand-50 aria-[current=page]:text-brand-700"
              aria-current={candidate.path === route.path ? 'page' : undefined}
              onClick={(event) => {
                event.preventDefault();
                navigate(candidate.path);
              }}
            >
              {candidate.label}
            </a>
          ))}
        </div>
        <div className="console-account flex min-w-0 items-center gap-2 lg:mt-auto lg:flex-col lg:items-stretch lg:border-t lg:border-slate-200 lg:pt-4">
          <span className="console-account-email sr-only max-w-[40vw] truncate text-xs text-slate-500 sm:not-sr-only sm:block lg:max-w-none lg:px-1">{session.user.email}</span>
          <SignOutButton />
        </div>
      </nav>
      <main className="console-main mx-auto w-full max-w-6xl p-4 sm:p-6 lg:p-8">{route.render(session)}</main>
    </div>
  );
}

function ConsoleApp() {
  const invited = window.location.pathname === '/console/invite';
  const session = useConsoleSession(!invited);

  if (invited) return <InviteAccept />;

  switch (session.kind) {
    case 'loading':
      return <p className="p-8 text-center text-sm text-slate-500">Đang tải…</p>;
    case 'unauthenticated':
      return <SignInScreen />;
    case 'service-unavailable':
      return (
        <main className="standalone-screen">
          <p role="alert" className="console-error">
            Đăng nhập chưa được cấu hình, vui lòng liên hệ quản trị viên.
          </p>
        </main>
      );
    case 'store-access-denied':
      // A Google account without an active membership still holds a valid session; without a way out the only
      // fix would be clearing cookies by hand before trying another account.
      return (
        <main className="console-screen standalone-screen">
          <p role="alert" className="mb-4 text-sm font-medium text-slate-700">
            Tài khoản này không có quyền truy cập Console.
          </p>
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
