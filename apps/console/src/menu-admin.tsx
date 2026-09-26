import { useEffect, useRef, useState } from 'react';
import { apiGet, apiSend, apiUploadImage, isErrorBody, type ConsoleSession } from './api-client.ts';
import { formatVnd } from './format-money.ts';

type ConsoleProduct = {
  id: string;
  categoryId: string;
  name: string;
  description: string;
  priceMinor: number;
  currency: string;
  isAvailable: boolean;
  isActive: boolean;
  displayOrder: number;
  revision: number;
  imageId: string | null;
};

type ConsoleCategory = { id: string; name: string; slug: string; displayOrder: number; isActive: boolean; products: ConsoleProduct[] };

const WRITE_ERROR_MESSAGE: Record<string, string> = {
  slug_taken: 'Đường dẫn danh mục đã được dùng.',
  category_not_found: 'Danh mục không tồn tại.',
  category_not_empty: 'Danh mục còn món, không thể xoá.',
  not_found: 'Không tìm thấy.',
  invalid_field: 'Thiếu thông tin bắt buộc.',
  invalid_price: 'Giá không hợp lệ (chỉ số nguyên hoặc thập phân, không phải số thực dấu chấm động).',
  invalid_json: 'Dữ liệu gửi lên không hợp lệ.',
  product_image_size_exceeded: 'Ảnh vượt quá 5MB.',
  product_image_type_unsupported: 'Định dạng ảnh không được hỗ trợ (chỉ JPEG/PNG/WebP).',
  product_image_empty: 'Ảnh trống.',
  product_image_store_failed: 'Không lưu được ảnh, vui lòng thử lại.',
};

function writeErrorMessage(code: string): string {
  return WRITE_ERROR_MESSAGE[code] ?? 'Không thực hiện được thao tác.';
}

async function loadCategories(): Promise<ConsoleCategory[]> {
  const result = await apiGet<{ categories: ConsoleCategory[] }>('/api/console/categories');
  return result.status === 200 && result.data && 'categories' in result.data ? result.data.categories : [];
}

export function MenuAdmin({ session }: { session: ConsoleSession }) {
  const [categories, setCategories] = useState<ConsoleCategory[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [editingProductId, setEditingProductId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState({ name: '', description: '', price: '', displayOrder: '0' });
  const [newCategory, setNewCategory] = useState({ name: '', slug: '' });
  const [newProductByCategory, setNewProductByCategory] = useState<Record<string, { name: string; price: string }>>({});
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const canWrite = session.allowedActions.includes('menu:write');
  const canToggleStock = session.allowedActions.includes('menu:stock:toggle');
  const canWriteImage = session.allowedActions.includes('menu:image:write');

  async function reload() {
    setCategories(await loadCategories());
  }

  useEffect(() => {
    if (session.allowedActions.includes('menu:read')) reload();
  }, [session]);

  if (!session.allowedActions.includes('menu:read')) {
    return <p role="alert">Bạn không có quyền truy cập trang này.</p>;
  }

  if (categories === null) return <p>Đang tải…</p>;

  async function createCategory() {
    const name = newCategory.name.trim();
    const slug = newCategory.slug.trim();
    if (name.length === 0 || slug.length === 0) return;
    const result = await apiSend('/api/console/categories', 'POST', { name, slug, displayOrder: categories!.length });
    if (result.status !== 201) {
      setError(writeErrorMessage(isErrorBody(result.data) ? result.data.error : 'invalid_field'));
      return;
    }
    setNewCategory({ name: '', slug: '' });
    setError(null);
    await reload();
  }

  async function deleteCategory(categoryId: string) {
    const result = await apiSend(`/api/console/categories/${categoryId}`, 'DELETE');
    if (result.status !== 200) {
      setError(writeErrorMessage(isErrorBody(result.data) ? result.data.error : 'not_found'));
      return;
    }
    setError(null);
    await reload();
  }

  async function createProduct(categoryId: string) {
    const draft = newProductByCategory[categoryId] ?? { name: '', price: '' };
    const name = draft.name.trim();
    if (name.length === 0 || draft.price.trim().length === 0) return;
    const result = await apiSend('/api/console/products', 'POST', { categoryId, name, description: '', price: draft.price.trim(), displayOrder: 0 });
    if (result.status !== 201) {
      setError(writeErrorMessage(isErrorBody(result.data) ? result.data.error : 'invalid_price'));
      return;
    }
    setNewProductByCategory((previous) => ({ ...previous, [categoryId]: { name: '', price: '' } }));
    setError(null);
    await reload();
  }

  function startEdit(product: ConsoleProduct) {
    setEditingProductId(product.id);
    setEditDraft({ name: product.name, description: product.description, price: String(product.priceMinor), displayOrder: String(product.displayOrder) });
    setConflict(null);
  }

  async function saveEdit(product: ConsoleProduct) {
    const result = await apiSend(`/api/console/products/${product.id}`, 'PATCH', {
      expectedRevision: product.revision,
      name: editDraft.name.trim(),
      description: editDraft.description,
      price: editDraft.price.trim(),
      displayOrder: Number(editDraft.displayOrder),
    });
    if (result.status === 409 && isErrorBody(result.data) && result.data.error === 'revision_conflict') {
      setEditingProductId(null);
      setConflict(product.id);
      return;
    }
    if (result.status !== 200) {
      setError(writeErrorMessage(isErrorBody(result.data) ? result.data.error : 'invalid_field'));
      return;
    }
    setEditingProductId(null);
    setConflict(null);
    setError(null);
    await reload();
  }

  async function toggleAvailability(product: ConsoleProduct) {
    const result = await apiSend(`/api/console/products/${product.id}/availability`, 'POST', { available: !product.isAvailable });
    if (result.status !== 200) {
      setError('Không đổi được trạng thái hết món.');
      return;
    }
    await reload();
  }

  async function deleteProduct(product: ConsoleProduct) {
    const result = await apiSend(`/api/console/products/${product.id}`, 'DELETE');
    if (result.status !== 200) {
      setError('Không xoá được món.');
      return;
    }
    await reload();
  }

  async function uploadImage(product: ConsoleProduct, file: File) {
    const result = await apiUploadImage(product.id, file, { expectedRevision: product.revision, filename: file.name });
    if (result.status !== 200) {
      setError(writeErrorMessage(isErrorBody(result.data) ? result.data.error : 'product_image_store_failed'));
      return;
    }
    await reload();
  }

  async function removeImage(product: ConsoleProduct) {
    const result = await apiSend(`/api/console/products/${product.id}/image`, 'DELETE');
    if (result.status !== 200) {
      setError('Không xoá được ảnh.');
      return;
    }
    await reload();
  }

  return (
    <section className="console-screen menu-admin" aria-label="Quản lý menu">
      <h1>Menu</h1>
      {error && (
        <p className="console-error" role="alert">
          {error}
        </p>
      )}
      {categories.map((category) => (
        <article key={category.id} className="menu-category">
          <header>
            <h2>{category.name}</h2>
            {canWrite && (
              <button type="button" onClick={() => deleteCategory(category.id)}>
                Xoá danh mục
              </button>
            )}
          </header>
          <ul className="menu-product-list">
            {category.products.map((product) => (
              <li key={product.id} className="menu-product" data-testid={`product-${product.id}`}>
                {editingProductId === product.id ? (
                  <div className="menu-product-edit">
                    <label htmlFor={`edit-name-${product.id}`}>Tên món</label>
                    <input id={`edit-name-${product.id}`} value={editDraft.name} onChange={(event) => setEditDraft((draft) => ({ ...draft, name: event.target.value }))} />
                    <label htmlFor={`edit-description-${product.id}`}>Mô tả</label>
                    <input
                      id={`edit-description-${product.id}`}
                      value={editDraft.description}
                      onChange={(event) => setEditDraft((draft) => ({ ...draft, description: event.target.value }))}
                    />
                    <label htmlFor={`edit-price-${product.id}`}>Giá (VND)</label>
                    <input id={`edit-price-${product.id}`} value={editDraft.price} onChange={(event) => setEditDraft((draft) => ({ ...draft, price: event.target.value }))} />
                    <button type="button" onClick={() => saveEdit(product)}>
                      Lưu món
                    </button>
                    <button type="button" onClick={() => setEditingProductId(null)}>
                      Huỷ
                    </button>
                  </div>
                ) : (
                  <div className="menu-product-view">
                    <span className="menu-product-name">{product.name}</span>
                    <span className="menu-product-price">{formatVnd(product.priceMinor)}</span>
                    {!product.isAvailable && <span className="badge">Hết món</span>}
                    {!product.isActive && <span className="badge">Đã ẩn</span>}
                    {conflict === product.id && (
                      <p className="console-error" role="alert">
                        Món đã được sửa ở nơi khác, tải lại.{' '}
                        <button type="button" onClick={reload}>
                          Tải lại
                        </button>
                      </p>
                    )}
                    {canWrite && (
                      <button type="button" aria-label={`Sửa món ${product.name}`} onClick={() => startEdit(product)}>
                        Sửa
                      </button>
                    )}
                    {canToggleStock && (
                      <button type="button" onClick={() => toggleAvailability(product)}>
                        {product.isAvailable ? 'Đánh dấu hết món' : 'Đánh dấu còn hàng'}
                      </button>
                    )}
                    {canWrite && (
                      <button type="button" onClick={() => deleteProduct(product)}>
                        Xoá món
                      </button>
                    )}
                    {canWriteImage && (
                      <>
                        <input
                          type="file"
                          accept="image/jpeg,image/png,image/webp"
                          aria-label={`Ảnh món ${product.name}`}
                          ref={(node) => {
                            fileInputRefs.current[product.id] = node;
                          }}
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (file) uploadImage(product, file);
                          }}
                        />
                        {product.imageId && (
                          <button type="button" onClick={() => removeImage(product)}>
                            Xoá ảnh
                          </button>
                        )}
                      </>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
          {canWrite && (
            <div className="menu-new-product">
              <label htmlFor={`new-product-name-${category.id}`}>Món mới</label>
              <input
                id={`new-product-name-${category.id}`}
                value={newProductByCategory[category.id]?.name ?? ''}
                onChange={(event) => setNewProductByCategory((previous) => ({ ...previous, [category.id]: { name: event.target.value, price: previous[category.id]?.price ?? '' } }))}
              />
              <label htmlFor={`new-product-price-${category.id}`}>Giá</label>
              <input
                id={`new-product-price-${category.id}`}
                value={newProductByCategory[category.id]?.price ?? ''}
                onChange={(event) => setNewProductByCategory((previous) => ({ ...previous, [category.id]: { name: previous[category.id]?.name ?? '', price: event.target.value } }))}
              />
              <button type="button" onClick={() => createProduct(category.id)}>
                Thêm món
              </button>
            </div>
          )}
        </article>
      ))}
      {canWrite && (
        <div className="menu-new-category">
          <h2>Thêm danh mục</h2>
          <label htmlFor="new-category-name">Tên danh mục</label>
          <input id="new-category-name" value={newCategory.name} onChange={(event) => setNewCategory((draft) => ({ ...draft, name: event.target.value }))} />
          <label htmlFor="new-category-slug">Đường dẫn</label>
          <input id="new-category-slug" value={newCategory.slug} onChange={(event) => setNewCategory((draft) => ({ ...draft, slug: event.target.value }))} />
          <button type="button" onClick={createCategory}>
            Thêm danh mục
          </button>
        </div>
      )}
    </section>
  );
}
