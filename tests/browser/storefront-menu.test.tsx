import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { MenuScreen } from '../../apps/storefront/src/menu-screen.tsx';
import type { MenuResponse } from '../../apps/storefront/src/types.ts';

const MENU: MenuResponse = {
  table: { tableNumber: 5 },
  categories: [
    {
      id: 'cat-1',
      name: 'Đồ uống',
      slug: 'do-uong',
      products: [
        {
          id: 'p1',
          name: 'Trà đá',
          description: 'Trà đá mát lạnh',
          priceMinor: 5000,
          currency: 'VND',
          isAvailable: true,
          imageId: '11111111-1111-1111-1111-111111111111',
        },
        {
          id: 'p2',
          name: 'Cà phê sữa',
          description: 'Hết hàng hôm nay',
          priceMinor: 25000,
          currency: 'VND',
          isAvailable: false,
          imageId: null,
        },
      ],
    },
  ],
};

describe('MenuScreen', () => {
  it('T3: disables a sold-out product with a label and never adds it to the cart on click', async () => {
    const onAdd = vi.fn();
    const screen = await render(<MenuScreen menu={MENU} onAdd={onAdd} />);

    const soldOutButton = screen.getByRole('button', { name: /hết món/i });
    await expect.element(soldOutButton).toBeDisabled();

    // A disabled native <button> refuses to dispatch a click event at all — the strongest possible proof.
    (soldOutButton.element() as HTMLButtonElement).click();
    expect(onAdd).not.toHaveBeenCalled();

    await screen.getByRole('button', { name: /thêm vào giỏ/i }).click();
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }));
  });

  it('A1: renders the product image through the storefront route, never a direct R2 URL', async () => {
    const screen = await render(<MenuScreen menu={MENU} onAdd={vi.fn()} />);
    const image = screen.getByRole('img');
    await expect.element(image).toBeVisible();

    const src = (image.element() as HTMLImageElement).getAttribute('src') ?? '';
    expect(src).toContain('/api/storefront/product-images/11111111-1111-1111-1111-111111111111');
    expect(src).not.toMatch(/r2\.dev|\.r2\.|cloudflarestorage/i);
  });
});
