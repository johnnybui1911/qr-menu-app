export type PublicProduct = {
  id: string;
  name: string;
  description: string;
  priceMinor: number;
  currency: string;
  /** false = shown as sold out; hidden products are not returned at all. */
  isAvailable: boolean;
  /** UUID for GET /api/storefront/product-images/:uuid, or null without an image. */
  imageId: string | null;
};

export type PublicCategory = { id: string; name: string; slug: string; products: PublicProduct[] };

export type ConsoleProduct = PublicProduct & { categoryId: string; isActive: boolean; displayOrder: number; revision: number };
export type ConsoleCategory = { id: string; name: string; slug: string; displayOrder: number; isActive: boolean; products: ConsoleProduct[] };

const IMAGE_KEY_PREFIX = 'product-images/';

type ProductRow = {
  id: string;
  category_id: string;
  name: string;
  description: string;
  price_minor: number;
  currency: string;
  is_available: number;
  is_active: number;
  display_order: number;
  revision: number;
  image_key: string | null;
};

type CategoryRow = { id: string; name: string; slug: string; display_order: number; is_active: number };

const PRODUCT_COLUMNS_SQL = `p.id, p.category_id, p.name, p.description, p.price_minor, p.currency, p.is_available, p.is_active,
  p.display_order, p.revision, p.image_key`;

function publicProduct(row: ProductRow): PublicProduct {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    priceMinor: row.price_minor,
    currency: row.currency,
    isAvailable: row.is_available === 1,
    imageId: row.image_key?.startsWith(IMAGE_KEY_PREFIX) ? row.image_key.slice(IMAGE_KEY_PREFIX.length) : null,
  };
}

/** The customer-facing menu: active products (sold-out ones flagged) under active categories, in display order. */
export async function readPublicMenu(db: D1Database, storeId: string): Promise<PublicCategory[]> {
  const [categories, products] = await Promise.all([
    db
      .prepare('SELECT id, name, slug, display_order, is_active FROM categories WHERE store_id = ? AND is_active = 1 ORDER BY display_order, id')
      .bind(storeId)
      .all<CategoryRow>(),
    db
      .prepare(`SELECT ${PRODUCT_COLUMNS_SQL} FROM products p WHERE p.store_id = ? AND p.is_active = 1 ORDER BY p.display_order, p.id`)
      .bind(storeId)
      .all<ProductRow>(),
  ]);
  return categories.results
    .map((category) => ({
      id: category.id,
      name: category.name,
      slug: category.slug,
      products: products.results.filter((product) => product.category_id === category.id).map(publicProduct),
    }))
    .filter((category) => category.products.length > 0);
}

/** The owner's menu: every category and product, including hidden ones, with the revision needed to edit them. */
export async function readConsoleMenu(db: D1Database, storeId: string): Promise<ConsoleCategory[]> {
  const [categories, products] = await Promise.all([
    db.prepare('SELECT id, name, slug, display_order, is_active FROM categories WHERE store_id = ? ORDER BY display_order, id').bind(storeId).all<CategoryRow>(),
    db.prepare(`SELECT ${PRODUCT_COLUMNS_SQL} FROM products p WHERE p.store_id = ? ORDER BY p.display_order, p.id`).bind(storeId).all<ProductRow>(),
  ]);
  return categories.results.map((category) => ({
    id: category.id,
    name: category.name,
    slug: category.slug,
    displayOrder: category.display_order,
    isActive: category.is_active === 1,
    products: products.results
      .filter((product) => product.category_id === category.id)
      .map((product) => ({
        ...publicProduct(product),
        categoryId: product.category_id,
        isActive: product.is_active === 1,
        displayOrder: product.display_order,
        revision: product.revision,
      })),
  }));
}
