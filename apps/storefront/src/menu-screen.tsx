import { productImageUrl } from './api-client.ts';
import { formatVnd } from './format-money.ts';
import type { MenuResponse, PublicProduct } from './types.ts';

export type MenuScreenProps = {
  menu: MenuResponse;
  onAdd: (product: PublicProduct) => void;
};

export function MenuScreen({ menu, onAdd }: MenuScreenProps) {
  return (
    <section aria-label="Thực đơn">
      <p className="table-banner">Bàn số {menu.table.tableNumber}</p>
      {menu.categories.map((category) => (
        <div key={category.id} className="menu-category">
          <h2>{category.name}</h2>
          <ul className="product-list">
            {category.products.map((product) => (
              <li key={product.id} className="product-card">
                {product.imageId ? (
                  <img src={productImageUrl(product.imageId)} alt={product.name} loading="lazy" />
                ) : (
                  <div className="product-card-placeholder" aria-hidden="true" />
                )}
                <div className="product-info">
                  <h3>{product.name}</h3>
                  <p>{product.description}</p>
                  <p className="product-price">{formatVnd(product.priceMinor)}</p>
                </div>
                <button
                  type="button"
                  disabled={!product.isAvailable}
                  onClick={() => {
                    if (product.isAvailable) onAdd(product);
                  }}
                >
                  {product.isAvailable ? 'Thêm vào giỏ' : 'Hết món'}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
