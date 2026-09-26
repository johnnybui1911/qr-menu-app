import { useEffect, useRef, useState } from 'react';
import { request } from './api-client.ts';
import { Cart } from './cart.tsx';
import { readCart, writeCart } from './cart-storage.ts';
import { MenuScreen } from './menu-screen.tsx';
import { PaymentScreen } from './payment-screen.tsx';
import { consumeRouteToken } from './token.ts';
import { TrackingScreen } from './tracking-screen.tsx';
import type { CartLine, MenuResponse, OrderView, PublicProduct } from './types.ts';

// A page reload on `/t` (hash already stripped by a prior mount) has no fragment to read; falling back to a
// previously placed order's Secret Link lets the customer keep watching payment/tracking instead of hitting a
// dead end. The cart itself is never recovered this way (decision #1 — sessionStorage cart is table-scoped, not
// resumed blindly), only the order the customer already committed to.
const ORDER_TOKEN_STORAGE_KEY = 'qr-menu-order-token';

type Screen =
  | { kind: 'no-token' }
  | { kind: 'loading' }
  | { kind: 'load-error'; message: string }
  | { kind: 'menu'; tableToken: string; menu: MenuResponse }
  | { kind: 'payment'; orderToken: string; order: OrderView }
  | { kind: 'tracking'; orderToken: string; order: OrderView };

export function App() {
  const [screen, setScreen] = useState<Screen>({ kind: 'loading' });
  const [cart, setCart] = useState<CartLine[]>([]);

  // Reading the fragment strips it (a destructive, one-time action) — StrictMode intentionally invokes this
  // effect twice in dev to surface exactly this class of bug, so a ref guard makes the read idempotent per mount.
  const routeConsumedRef = useRef(false);
  useEffect(() => {
    if (routeConsumedRef.current) return;
    routeConsumedRef.current = true;
    const route = consumeRouteToken(window.location, window.history);
    if (route.kind === 'table') {
      void loadMenu(route.token);
      return;
    }
    if (route.kind === 'order') {
      void loadOrder(route.token);
      return;
    }
    const savedOrderToken = sessionStorage.getItem(ORDER_TOKEN_STORAGE_KEY);
    if (savedOrderToken) {
      void loadOrder(savedOrderToken);
      return;
    }
    setScreen({ kind: 'no-token' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadMenu(tableToken: string) {
    setScreen({ kind: 'loading' });
    const result = await request<MenuResponse>({ path: '/api/storefront/menu', tableToken });
    if (!result.ok) {
      setScreen({ kind: 'load-error', message: 'Không tìm thấy bàn, vui lòng quét lại mã QR.' });
      return;
    }
    setCart(await readCart(tableToken));
    setScreen({ kind: 'menu', tableToken, menu: result.data });
  }

  async function loadOrder(orderToken: string) {
    setScreen({ kind: 'loading' });
    const result = await request<OrderView>({ path: '/api/storefront/orders/current', orderToken });
    if (!result.ok) {
      sessionStorage.removeItem(ORDER_TOKEN_STORAGE_KEY);
      setScreen({ kind: 'load-error', message: 'Không tìm thấy đơn, vui lòng dùng đường dẫn khác.' });
      return;
    }
    sessionStorage.setItem(ORDER_TOKEN_STORAGE_KEY, orderToken);
    setScreen(
      result.data.status === 'pending_payment'
        ? { kind: 'payment', orderToken, order: result.data }
        : { kind: 'tracking', orderToken, order: result.data },
    );
  }

  function updateCart(next: CartLine[]) {
    setCart(next);
    if (screen.kind === 'menu') void writeCart(screen.tableToken, next);
  }

  function addToCart(product: PublicProduct) {
    const existing = cart.find((line) => line.productId === product.id);
    updateCart(
      existing
        ? cart.map((line) => (line.productId === product.id ? { ...line, quantity: Math.min(99, line.quantity + 1) } : line))
        : [...cart, { productId: product.id, name: product.name, priceMinor: product.priceMinor, quantity: 1, notes: '' }],
    );
  }

  function setQuantity(productId: string, quantity: number) {
    updateCart(
      quantity <= 0
        ? cart.filter((line) => line.productId !== productId)
        : cart.map((line) => (line.productId === productId ? { ...line, quantity: Math.min(99, quantity) } : line)),
    );
  }

  function setNotes(productId: string, notes: string) {
    updateCart(cart.map((line) => (line.productId === productId ? { ...line, notes } : line)));
  }

  function removeFromCart(productId: string) {
    updateCart(cart.filter((line) => line.productId !== productId));
  }

  function handleOrderPlaced(order: OrderView, orderToken: string) {
    if (screen.kind === 'menu') void writeCart(screen.tableToken, []);
    setCart([]);
    sessionStorage.setItem(ORDER_TOKEN_STORAGE_KEY, orderToken);
    setScreen({ kind: 'payment', orderToken, order });
  }

  if (screen.kind === 'no-token') {
    return (
      <main className="app-shell">
        <p role="alert">Vui lòng quét lại mã QR</p>
      </main>
    );
  }
  if (screen.kind === 'loading') {
    return (
      <main className="app-shell">
        <p role="status">Đang tải…</p>
      </main>
    );
  }
  if (screen.kind === 'load-error') {
    return (
      <main className="app-shell">
        <p role="alert">{screen.message}</p>
      </main>
    );
  }
  if (screen.kind === 'menu') {
    return (
      <main className="app-shell">
        <MenuScreen menu={screen.menu} onAdd={addToCart} />
        <Cart
          tableToken={screen.tableToken}
          cart={cart}
          onQuantityChange={setQuantity}
          onNotesChange={setNotes}
          onRemove={removeFromCart}
          onOrderPlaced={handleOrderPlaced}
        />
      </main>
    );
  }
  if (screen.kind === 'payment') {
    return (
      <main className="app-shell">
        <PaymentScreen
          orderToken={screen.orderToken}
          order={screen.order}
          onPaid={(order) => setScreen({ kind: 'tracking', orderToken: screen.orderToken, order })}
          onExpiredOrCancelled={() => sessionStorage.removeItem(ORDER_TOKEN_STORAGE_KEY)}
        />
      </main>
    );
  }
  return (
    <main className="app-shell">
      <TrackingScreen orderToken={screen.orderToken} order={screen.order} />
    </main>
  );
}
