# Scout Report — 02: Tầng dữ liệu D1, lưu ảnh R2 và bindings

Nguồn đã đọc: `docs/reference/nexus/02-d1-data-layer-and-r2.md` (toàn bộ 986 dòng), `docs/decisions/260919-post-xia-decision-record.md` (D2, D4, D8, D9, D11, D13, D17, D19, D23, F1–F13), `docs/PRD.md` mục 5, cộng tham chiếu chéo bắt buộc tới `docs/reference/nexus/04-payfs-webhook-and-business-contracts.md` (mẫu `private-access.ts`, `meta.changes`, conditional UPDATE) và `docs/reference/nexus/03-better-auth-google-oauth.md` (khuyến nghị hash-at-rest `table_token`) vì D8/D17/D9 không đóng kín trong file 02 một mình. Non-goal tuân thủ: không đụng PayFS webhook, better-auth, build config.

---

## Kết luận cho người lập kế hoạch

1. **[XÁC MINH]** Không dùng ORM (D2, `docs/decisions/...:63-83`). Đọc = hàm thuần `(db: D1Database, ...)` + `prepare().bind()` + `.first<T>()`/`.all<T>()`; ghi = `db.batch([...])` với self-aborting UPDATE + commit assertion cuối lô. Nguồn mẫu: `docs/reference/nexus/02-d1-data-layer-and-r2.md:117-140` (đọc), `:178-240` (ghi).
2. **[XÁC MINH]** Mọi bảng nghiệp vụ phải có `store_id` NGAY từ migration 0001 (D4, `docs/decisions/...:159-165`), giá trị hằng cho MVP một quán (ví dụ CHECK `store_id = 'store_default'` theo khuôn `CHECK (store_id = 'store_nexus')` — `docs/reference/nexus/03-better-auth-google-oauth.md:325`). **KHÔNG copy** đề xuất bỏ `store_id` ở `docs/reference/nexus/02-d1-data-layer-and-r2.md:889-893` (mục 8.2.1) — đó là khuyến nghị của tài liệu tham chiếu (viết trước Decision Record), D4 đã ghi đè.
3. **[XÁC MINH]** Token bàn (`table_secrets.token_digest`) và token Secret Link đơn (`order_access.capability_digest`) **chỉ lưu SHA-256 digest**, không lưu token thô (D8, `docs/decisions/...:196-203`). Schema đề xuất mẫu tại `docs/reference/nexus/02-d1-data-layer-and-r2.md:833-846` (`tables.secret_token`, `orders.order_token` lưu **thẳng** giá trị có CHECK định dạng) **VI PHẠM D8** — không được copy nguyên khối DDL đó, phải tách sang bảng phụ theo mẫu `order_access`/`owner_invitations` (`docs/reference/nexus/04-payfs-webhook-and-business-contracts.md:1199-1244`, `docs/reference/nexus/03-better-auth-google-oauth.md:326-334`).
4. **[XÁC MINH]** `payment_reference` = `QM` + 8 ký tự `[0-9A-Z]`, sinh bằng CSPRNG **trong code ứng dụng**, cấm `DEFAULT` ở tầng cột SQL, `UNIQUE(store_id, payment_reference)` (D18, `docs/decisions/...:239-247`). Migration chỉ đặt CHECK định dạng + UNIQUE, không sinh giá trị.
5. **[XÁC MINH]** Order state machine dùng `UPDATE ... WHERE status = <from>`; 0 row bị ảnh hưởng ⇒ 409, không side effect (D9, `docs/decisions/...:167-177`). Cơ chế phát hiện 0-row: đọc `result.meta.changes` sau `.batch()`/`.run()` — mẫu tại `docs/reference/nexus/04-payfs-webhook-and-business-contracts.md:637-638` (`results[1]?.meta.changes === 1`) và `:1511-1512`.
6. **[XÁC MINH]** Toàn bộ giải giá dòng đơn nằm trong MỘT hàm `resolveLineItemPrice` của `catalog` (D19, `docs/decisions/...:249-259`); client chỉ được gửi `productId, quantity, notes`, payload có `price`/`total` → `unknown_field` (D11 pt.1, `docs/decisions/...:186-194`). **[SUY LUẬN]** Chữ ký hàm cụ thể không có trong tài liệu nguồn (chỉ có tên hàm) — đề xuất ở mục 3 bên dưới, đánh dấu rõ.
7. **[XÁC MINH]** Ảnh món: key opaque `product-images/<uuid>` (D13, đúng với `docs/reference/nexus/02-d1-data-layer-and-r2.md:479` `product-image.ts:299`) — **không** đổi sang `menu-images/` dù `docs/reference/nexus/02-d1-data-layer-and-r2.md:960-966` (mục 8.4) đề xuất vậy; D13 dùng nguyên literal `product-images/<uuid>`, Decision Record thắng.
8. **[SUY LUẬN có căn cứ]** D13 ghi "Ghi D1 trước, R2 sau" — cụm này trùng khớp chính xác với mô tả **luồng xoá ảnh** của SOURCE ("Xoá chủ động ... rồi mới xoá object R2. Thứ tự là D1 trước, R2 sau" — `docs/reference/nexus/02-d1-data-layer-and-r2.md` mục 5.5). Luồng **tạo/thay ảnh** của SOURCE thực tế làm ngược: R2 `put()` trước, `db.batch()` sau, compensation xoá R2 khi D1 fail (`docs/reference/nexus/02-d1-data-layer-and-r2.md:173-240`, `product-image.ts:294-333`) — đây mới là thứ khớp với "chấp nhận object mồ côi hơn là D1 sai" (nếu D1 ghi trước mà R2 sau đó fail, D1 sẽ trỏ tới object không tồn tại — đúng thứ D13 nói phải tránh). Kết luận thi công: **CREATE/REPLACE ảnh giữ đúng thứ tự SOURCE (R2 trước, D1 sau)**; chỉ **DELETE ảnh mới áp `D1 trước, R2 sau`**. Đây là điểm mơ hồ nhất của cả bộ tài liệu — nêu lại ở mục Câu hỏi còn mở để người lập kế hoạch xác nhận với chủ dự án nếu muốn chắc chắn 100%.
9. **[XÁC MINH]** Bảng `order_email_jobs`, cron `*/5`, claim bằng conditional UPDATE phải **có code + bảng từ M2** (D23, `docs/decisions/...:336-347`), chỉ việc gửi thật qua Resend là hoãn tới M4. Migration 0001 không bắt buộc chứa bảng này, nhưng phải nằm trong migration nền **trước khi** M2 bắt đầu code chuyển trạng thái đơn (vì enqueue nằm CÙNG batch với chuyển trạng thái — D12).

---

## Pattern bắt buộc

| Hạng mục | Cách làm cụ thể | Trích dẫn |
|---|---|---|
| Đánh số migration | Thư mục `migrations/`, tiền tố 4 chữ số tăng dần + mô tả kebab-case, append-only, không sửa file đã apply | `docs/reference/nexus/02-d1-data-layer-and-r2.md:12-25` (`migrations/AGENTS.md:5-7`) |
| Đổi shape bảng sau này | Migration mới kiểu copy-drop-recreate (backup sang bảng tạm `_sN_*`, drop, tạo lại, `INSERT ... SELECT`), không sửa file cũ | `docs/reference/nexus/02-d1-data-layer-and-r2.md:26-30` |
| Khoá chính | `id TEXT PRIMARY KEY NOT NULL`, sinh ID ở tầng app, không autoincrement | `docs/reference/nexus/02-d1-data-layer-and-r2.md:57` |
| Timestamp | `TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))` | `docs/reference/nexus/02-d1-data-layer-and-r2.md:58-59` |
| Tiền | `INTEGER` minor units, CHECK `>= 0 AND <= 9007199254740991` | `docs/reference/nexus/02-d1-data-layer-and-r2.md:60-62` |
| Boolean | `INTEGER ... CHECK (x IN (0,1))` | `docs/reference/nexus/02-d1-data-layer-and-r2.md:63` |
| Enum | `TEXT ... CHECK (col IN (...))` | `docs/reference/nexus/02-d1-data-layer-and-r2.md:64` |
| Đặt tên constraint | `<table>_<ý nghĩa>_<loại>` (`products_store_fk`, `products_file_all_or_none`) | `docs/reference/nexus/02-d1-data-layer-and-r2.md:65-66` |
| Tenant-scoping FK đa cột | Composite `UNIQUE(id, store_id)` trên bảng cha để bảng con FK theo cặp `(child_fk, store_id)` | `docs/reference/nexus/02-d1-data-layer-and-r2.md:67-69` |
| Index khớp query | Index nhiều cột khớp đúng thứ tự `ORDER BY` thật sự dùng | `docs/reference/nexus/02-d1-data-layer-and-r2.md:70-72` |
| Partial unique index | `CREATE UNIQUE INDEX ... WHERE active = 1` cho ràng buộc chỉ áp lên bản ghi active | `docs/reference/nexus/02-d1-data-layer-and-r2.md:73-74` |
| Invariant phức tạp | `TRIGGER` + `RAISE(ABORT, '<mã lỗi ổn định>')` | `docs/reference/nexus/02-d1-data-layer-and-r2.md:75-76` |
| All-or-none nhiều cột trên bảng MỚI | `CHECK` trực tiếp trong `CREATE TABLE` | `docs/reference/nexus/02-d1-data-layer-and-r2.md:96-98` (khác `ALTER TABLE ADD COLUMN` phải dùng TRIGGER) |
| Hàm đọc | `(db: D1Database, ...args)` thuần, không class/DI; `${column}` nội suy chỉ khi đã thu hẹp kiểu union, mọi giá trị khác qua `.bind()` | `docs/reference/nexus/02-d1-data-layer-and-r2.md:117-140` |
| API D1 | `.first<T>()` 0..1 dòng; `.all<T>()` nhiều dòng đọc `.results`; `.batch([...])` atomic; `Promise.all([...])` cho đọc song song độc lập; **không dùng `.run()`** cho mutation nghiệp vụ | `docs/reference/nexus/02-d1-data-layer-and-r2.md:142-150` |
| Mapping row→domain | Interface `XxxRow` snake_case cạnh hàm đọc; map tay sang camelCase trong object literal, KHÔNG `as any`; biến thể: alias ngay trong SQL (`AS updatedAt`) khi kiểu trả về đã khai tường minh | `docs/reference/nexus/02-d1-data-layer-and-r2.md:152-176` |
| Hằng chuỗi cho mệnh đề lặp | Tách `EXISTS (...)`/`WHERE store_id=?` lặp lại thành hằng dùng chung trong MỘT module sở hữu bảng đó — SOURCE lặp 9 lần trong `catalog-read.ts`, đừng lặp lại lỗi | `docs/decisions/260919-post-xia-decision-record.md:78-82` |
| Self-aborting UPDATE (optimistic concurrency + authz 1 round-trip) | `col = CASE WHEN <revision đúng AND EXISTS quyền> THEN col ELSE NULL END` ghi NULL vào cột `NOT NULL` để SQLite abort cả batch | `docs/reference/nexus/02-d1-data-layer-and-r2.md:178-215` |
| Commit assertion | Statement cuối `db.batch()` kiểm tra lại trạng thái SAU khi ghi, cùng kỹ thuật self-abort | `docs/reference/nexus/02-d1-data-layer-and-r2.md:216-232` |
| Nhận diện abort có chủ đích | `try { await db.batch([...]) } catch (e) { if (/NOT NULL constraint failed: (?:products|orders)\.<cột NOT NULL>/.test(e.message)) → 409 revision_conflict; else → 500 + incidentId }` | `docs/reference/nexus/02-d1-data-layer-and-r2.md:233-240` |
| Phát hiện 0-row-affected cho state machine | Đọc `result.meta.changes` của statement UPDATE trong `.batch()`/`.run()`; `=== 1` là thành công, `=== 0` map sang 409 | `docs/reference/nexus/04-payfs-webhook-and-business-contracts.md:637-638`, `:1511-1512` |
| Conditional UPDATE cho transition | `UPDATE orders SET status=<to> WHERE store_id=? AND id=? AND status=<from>` cộng `EXISTS` trên history row vừa insert trong CÙNG batch | `docs/reference/nexus/04-payfs-webhook-and-business-contracts.md:1016-1033` |
| Idempotency persistence | Bảng ledger `UNIQUE(store_id, request_key)` + `payload_hash`/`capability_digest`; batch fail vì đụng UNIQUE → đọc lại ledger: cùng action+hash → replay; khác → 409 `idempotency_conflict` | `docs/reference/nexus/02-d1-data-layer-and-r2.md:260-280`; `docs/reference/nexus/04-payfs-webhook-and-business-contracts.md:378-397, 480-487` |
| Token digest sinh & lưu | ≥32 byte CSPRNG (`crypto.getRandomValues`) → base64url; server hash SHA-256 qua `crypto.subtle.digest('SHA-256', ...)` → hex; DB chỉ lưu hex 64 ký tự với CHECK `length=64 AND NOT GLOB '*[^0-9a-f]*'` | `docs/reference/nexus/04-payfs-webhook-and-business-contracts.md:1199-1235` |
| Token lookup | JOIN trên digest trong 1 câu SQL, KHÔNG select-rồi-so-sánh-trong-JS; token qua header/URL fragment, không query string | `docs/reference/nexus/04-payfs-webhook-and-business-contracts.md:1255-1283` |
| Cửa sổ ân hạn token | `revoked_at IS NULL OR revoked_at > <now>` trong WHERE của JOIN | `docs/decisions/260919-post-xia-decision-record.md:213-219` (D17) |
| 404 đồng nhất | Mọi nhánh thất bại (không tồn tại/sai/hết hạn) trả cùng một payload lỗi, không phân biệt lý do | `docs/decisions/260919-post-xia-decision-record.md:196-203` (D8) |
| Money — số chữ số thập phân | `Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits`, cache kết quả | `docs/reference/nexus/02-d1-data-layer-and-r2.md:379-388` (`money.ts:20-39`) |
| Money — decimal→minor | Regex `^(?:0\|[1-9]\d*)(?:\.(\d+))?$`; thừa chữ số thập phân → ném lỗi (KHÔNG làm tròn); `BigInt` để tránh sai số float; trần `Number.MAX_SAFE_INTEGER` | `docs/reference/nexus/02-d1-data-layer-and-r2.md:390-420` (`money.ts:41-75`) |
| R2 object key | `product-images/<uuid v4>` — opaque, không nhúng tên/id/extension | `docs/decisions/260919-post-xia-decision-record.md:222-227` (D13); `docs/reference/nexus/02-d1-data-layer-and-r2.md:479` |
| MIME thật | Suy từ magic bytes (12 byte đầu: JPEG `FF D8 FF`, PNG 8-byte signature, WebP `RIFF....WEBP`), KHÔNG tin `Content-Type` client | `docs/reference/nexus/02-d1-data-layer-and-r2.md:530-542` (`product-image.ts:37-48`) |
| Giới hạn kích thước nhiều lớp | (1) route kiểm `Content-Type` upload = `application/octet-stream`; (2) `Content-Length` khai báo ≤ 5MB nếu có; (3) đếm byte khi stream, huỷ giữa chừng khi vượt hạn mức; (4) DB CHECK/TRIGGER `image_size BETWEEN 1 AND 5000000` là phòng tuyến cuối | `docs/reference/nexus/02-d1-data-layer-and-r2.md:517-545` |
| Ghi D1/R2 cho **tạo/thay** ảnh | R2 `put()` trước (dùng key mới luôn) → verify `object.size === byteCount` → `db.batch()` ghi metadata (self-abort + commit assertion) → nếu batch fail: compensation xoá object R2 vừa tạo (retry ×3, best-effort, chấp nhận orphan nếu retry cạn) | `docs/reference/nexus/02-d1-data-layer-and-r2.md:475-495, 610-625` |
| Ghi D1/R2 cho **xoá/thay** ảnh | D1 trước (null hoá 4 cột metadata / ghi metadata mới) → R2 sau (xoá object cũ, best-effort, log lỗi không chặn response) | `docs/reference/nexus/02-d1-data-layer-and-r2.md` mục 5.5 |
| Cache header ảnh public | `Cache-Control: public, max-age=31536000, immutable` + xử lý `If-None-Match` khớp `object.httpEtag` → 304. **Đảo ngược SOURCE** (`no-store`, không xử lý `If-None-Match`) | `docs/decisions/260919-post-xia-decision-record.md:227` (D13); `docs/reference/nexus/02-d1-data-layer-and-r2.md:890-895` |
| Response header ảnh | `ETag: object.httpEtag`, `X-Content-Type-Options: nosniff`, `object.writeHttpMetadata(headers)` để lấy Content-Type đã lưu lúc upload | `docs/reference/nexus/02-d1-data-layer-and-r2.md:660-680` |

---

## Hình dạng file/config/SQL cần tạo

### `migrations/0001-menu-core.sql`

DDL xương sống (đủ chạy được, đối chiếu D4/D8/D17/D18 — đã SỬA so với đề xuất gốc ở `docs/reference/nexus/02-d1-data-layer-and-r2.md:830-990` để thêm `store_id` và tách token sang bảng digest):

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE categories (
  id TEXT PRIMARY KEY NOT NULL,
  store_id TEXT NOT NULL CHECK (store_id = 'store_default'),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  slug TEXT NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0 CHECK (display_order >= 0),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT categories_store_slug_unique UNIQUE (store_id, slug),
  CONSTRAINT categories_id_store_unique UNIQUE (id, store_id)
);
CREATE UNIQUE INDEX categories_store_active_order_unique
  ON categories (store_id, display_order) WHERE is_active = 1;

CREATE TABLE products (
  id TEXT PRIMARY KEY NOT NULL,
  store_id TEXT NOT NULL CHECK (store_id = 'store_default'),
  category_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT 'VND' CHECK (length(currency) = 3 AND currency = upper(currency)),
  price_minor INTEGER NOT NULL DEFAULT 0 CHECK (price_minor >= 0 AND price_minor <= 9007199254740991),
  is_available INTEGER NOT NULL DEFAULT 1 CHECK (is_available IN (0, 1)),
  display_order INTEGER NOT NULL DEFAULT 0 CHECK (display_order >= 0),
  image_key TEXT,
  image_filename TEXT,
  image_content_type TEXT,
  image_size INTEGER,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT products_category_fk FOREIGN KEY (category_id, store_id) REFERENCES categories(id, store_id),
  CONSTRAINT products_store_slug_unique UNIQUE (store_id, slug),
  CONSTRAINT products_id_store_unique UNIQUE (id, store_id),
  CONSTRAINT products_image_all_or_none CHECK (
    (image_key IS NULL AND image_filename IS NULL AND image_content_type IS NULL AND image_size IS NULL)
    OR (image_key IS NOT NULL AND image_filename IS NOT NULL
        AND image_content_type IN ('image/jpeg','image/png','image/webp')
        AND image_size BETWEEN 1 AND 5000000)
  )
);
CREATE INDEX products_store_menu_idx
  ON products (store_id, category_id, is_available, display_order, id);
CREATE INDEX products_store_updated_idx
  ON products (store_id, updated_at DESC, id ASC);

CREATE TABLE tables (
  id TEXT PRIMARY KEY NOT NULL,
  store_id TEXT NOT NULL CHECK (store_id = 'store_default'),
  table_number TEXT NOT NULL CHECK (length(table_number) BETWEEN 1 AND 32),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT tables_store_number_unique UNIQUE (store_id, table_number),
  CONSTRAINT tables_id_store_unique UNIQUE (id, store_id)
);

-- D17: bảng riêng cho token bàn, chỉ lưu digest, nhiều digest sống song song trong cửa sổ ân hạn
CREATE TABLE table_secrets (
  id TEXT PRIMARY KEY NOT NULL,
  store_id TEXT NOT NULL CHECK (store_id = 'store_default'),
  table_id TEXT NOT NULL,
  token_digest TEXT NOT NULL CHECK (length(token_digest) = 64 AND token_digest NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  revoked_at TEXT,
  CONSTRAINT table_secrets_table_fk FOREIGN KEY (table_id, store_id) REFERENCES tables(id, store_id),
  CONSTRAINT table_secrets_store_digest_unique UNIQUE (store_id, token_digest)
);
CREATE INDEX table_secrets_lookup_idx
  ON table_secrets (store_id, token_digest, revoked_at);

CREATE TABLE orders (
  id TEXT PRIMARY KEY NOT NULL,
  store_id TEXT NOT NULL CHECK (store_id = 'store_default'),
  order_code TEXT NOT NULL,
  table_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_payment'
    CHECK (status IN ('pending_payment','paid','preparing','fulfilled','cancelled','refunded')),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  total_amount_minor INTEGER NOT NULL CHECK (total_amount_minor BETWEEN 0 AND 9007199254740991),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('vietqr','cash')),
  -- D18: format cố định, sinh trong app code, KHÔNG DEFAULT ở tầng cột
  payment_reference TEXT NOT NULL CHECK (
    length(payment_reference) = 10
    AND payment_reference GLOB 'QM[0-9A-Z][0-9A-Z][0-9A-Z][0-9A-Z][0-9A-Z][0-9A-Z][0-9A-Z][0-9A-Z]'
  ),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT orders_table_fk FOREIGN KEY (table_id, store_id) REFERENCES tables(id, store_id),
  CONSTRAINT orders_store_code_unique UNIQUE (store_id, order_code),
  CONSTRAINT orders_store_payment_reference_unique UNIQUE (store_id, payment_reference),
  CONSTRAINT orders_id_store_currency_unique UNIQUE (id, store_id, currency)
);
CREATE INDEX orders_kitchen_idx ON orders (store_id, status, created_at ASC, id ASC);
CREATE INDEX orders_table_created_idx ON orders (store_id, table_id, created_at DESC, id DESC);

-- D8: Secret Link tra cứu đơn — chỉ lưu digest, KHÔNG có cột order_token trên orders
CREATE TABLE order_access (
  id TEXT PRIMARY KEY NOT NULL,
  store_id TEXT NOT NULL CHECK (store_id = 'store_default'),
  order_id TEXT NOT NULL,
  capability_digest TEXT NOT NULL CHECK (length(capability_digest) = 64 AND capability_digest NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT order_access_order_fk FOREIGN KEY (order_id, store_id) REFERENCES orders(id, store_id),
  CONSTRAINT order_access_one_per_order UNIQUE (order_id, store_id),
  CONSTRAINT order_access_store_digest_unique UNIQUE (store_id, capability_digest)
);

CREATE TABLE order_items (
  id TEXT PRIMARY KEY NOT NULL,
  store_id TEXT NOT NULL CHECK (store_id = 'store_default'),
  order_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  product_name_snapshot TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  unit_price_snapshot_minor INTEGER NOT NULL CHECK (unit_price_snapshot_minor BETWEEN 0 AND 9007199254740991),
  line_total_minor INTEGER NOT NULL CHECK (
    line_total_minor BETWEEN 0 AND 9007199254740991
    AND line_total_minor = unit_price_snapshot_minor * quantity
  ),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  notes TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 500),
  position INTEGER NOT NULL CHECK (position >= 0),
  CONSTRAINT order_items_order_currency_fk
    FOREIGN KEY (order_id, store_id, currency) REFERENCES orders(id, store_id, currency),
  CONSTRAINT order_items_product_fk FOREIGN KEY (product_id, store_id) REFERENCES products(id, store_id),
  CONSTRAINT order_items_store_position_unique UNIQUE (order_id, store_id, position)
);
CREATE INDEX order_items_order_idx ON order_items (order_id, position);

CREATE TABLE refund_requests (
  id TEXT PRIMARY KEY NOT NULL,
  store_id TEXT NOT NULL CHECK (store_id = 'store_default'),
  order_id TEXT NOT NULL,
  requested_by_staff_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  decided_at TEXT,
  decided_by_user_id TEXT,
  CONSTRAINT refund_requests_order_fk FOREIGN KEY (order_id, store_id) REFERENCES orders(id, store_id),
  CONSTRAINT refund_requests_store_order_unique UNIQUE (store_id, order_id),
  CONSTRAINT refund_requests_decision_shape CHECK (
    (status = 'pending' AND decided_at IS NULL AND decided_by_user_id IS NULL)
    OR (status IN ('approved','rejected') AND decided_at IS NOT NULL AND decided_by_user_id IS NOT NULL)
  )
);
CREATE INDEX refund_requests_status_idx ON refund_requests (store_id, status, created_at ASC, id ASC);
CREATE TRIGGER refund_requests_terminal_immutable
BEFORE UPDATE ON refund_requests
WHEN OLD.status IN ('approved','rejected')
BEGIN
  SELECT RAISE(ABORT, 'refund_decision_is_final');
END;
```

Nguồn xương sống: `docs/reference/nexus/02-d1-data-layer-and-r2.md:830-990` (mục 8.3, đã sửa `store_id` + tách token theo D4/D8/D17/D18); trigger refund immutable bám nguyên mẫu `0010-refund-decisions.sql` qua `docs/reference/nexus/02-d1-data-layer-and-r2.md:975-980`.

### `migrations/0002-idempotency-and-outbox.sql` (không chặn 0001, nhưng bảng email jobs phải xong trước code M2 theo D23)

Xương sống (tên cột theo mẫu `docs/reference/nexus/02-d1-data-layer-and-r2.md:270-280`, `0006-order-brief-contract.sql:310-339`, và D10/D23):

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE order_idempotency (           -- Tầng "khách đặt đơn" của D10
  id TEXT PRIMARY KEY NOT NULL,
  store_id TEXT NOT NULL CHECK (store_id = 'store_default'),
  request_key TEXT NOT NULL CHECK (length(request_key) BETWEEN 16 AND 128 AND request_key NOT GLOB '*[^A-Za-z0-9_-]*'),
  capability_digest TEXT NOT NULL CHECK (length(capability_digest) = 64 AND capability_digest NOT GLOB '*[^0-9a-f]*'),
  order_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT order_idempotency_store_key_unique UNIQUE (store_id, request_key)
);

CREATE TABLE order_commands (               -- Tầng "lệnh Console" của D10
  id TEXT PRIMARY KEY NOT NULL,
  store_id TEXT NOT NULL CHECK (store_id = 'store_default'),
  request_key TEXT NOT NULL CHECK (length(request_key) BETWEEN 16 AND 128 AND request_key NOT GLOB '*[^A-Za-z0-9_-]*'),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  action TEXT NOT NULL,
  order_id TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT order_commands_store_key_unique UNIQUE (store_id, request_key)
);

CREATE TABLE provider_events (              -- Tầng "webhook provider" của D10
  id TEXT PRIMARY KEY NOT NULL,
  store_id TEXT NOT NULL CHECK (store_id = 'store_default'),
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  facts_fingerprint TEXT NOT NULL CHECK (length(facts_fingerprint) = 64 AND facts_fingerprint NOT GLOB '*[^0-9a-f]*'),
  raw_payload TEXT NOT NULL,
  outcome TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT provider_events_provider_event_unique UNIQUE (provider, provider_event_id)
);

CREATE TABLE provider_payments (
  id TEXT PRIMARY KEY NOT NULL,
  store_id TEXT NOT NULL CHECK (store_id = 'store_default'),
  order_id TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT provider_payments_order_fk FOREIGN KEY (order_id, store_id) REFERENCES orders(id, store_id),
  CONSTRAINT provider_payments_store_order_unique UNIQUE (store_id, order_id)   -- chặn ghi nhận tiền 2 lần (D10)
);

CREATE TABLE order_email_jobs (             -- D12/D23 — bắt buộc có code+bảng từ M2
  id TEXT PRIMARY KEY NOT NULL,
  store_id TEXT NOT NULL CHECK (store_id = 'store_default'),
  order_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','retired')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT order_email_jobs_order_fk FOREIGN KEY (order_id, store_id) REFERENCES orders(id, store_id)
);
CREATE INDEX order_email_jobs_claim_idx ON order_email_jobs (status, available_at ASC, id ASC);
```

### `packages/catalog/src/money.ts`

**[XÁC MINH]** Bê nguyên API từ SOURCE, chỉ đổi tên module path (`docs/reference/nexus/02-d1-data-layer-and-r2.md:390-420, 942-943`):

```ts
export class MoneyError extends Error {
  constructor(public readonly code: 'currency_invalid' | 'money_invalid' | 'money_over_precision' | 'money_out_of_range', message: string) { super(message); }
}
export function currencyFractionDigits(currency: string): number;   // Intl.NumberFormat(...).resolvedOptions().maximumFractionDigits, cache theo currency
export function decimalToMinor(decimal: string, currency: string): number;  // regex reject, BigInt scale, MAX_SAFE_INTEGER cap, KHÔNG làm tròn
export function minorToDecimal(minor: number, currency: string): string;    // fractionDigits===0 → String(minor) thẳng (đúng nhánh VND)
```

### `packages/catalog/src/pricing.ts` — **[SUY LUẬN]** (D19 chỉ nêu tên hàm, không có chữ ký nguồn)

Một hàm duy nhất giải giá dòng đơn, nhận input đã qua validate `rejectUnknown` (D11 pt.1):

```ts
export interface LineItemInput { productId: string; quantity: number; notes: string }
export type LineItemResolution =
  | { ok: true; productId: string; productNameSnapshot: string; unitPriceMinor: number; lineTotalMinor: number; currency: string }
  | { ok: false; code: 'product_not_found' | 'product_unavailable'; productId: string };

export async function resolveLineItemPrice(db: D1Database, storeId: string, input: LineItemInput): Promise<LineItemResolution>;
export async function resolveOrderLineItems(db: D1Database, storeId: string, items: LineItemInput[]): Promise<
  { ok: true; lines: Extract<LineItemResolution, { ok: true }>[]; totalAmountMinor: number }
  | { ok: false; rejected: Extract<LineItemResolution, { ok: false }>[] }
>;
```

Đọc `products` bằng 1 câu SQL duy nhất (`WHERE store_id=? AND id IN (...)`), tính `lineTotalMinor = unitPriceMinor * quantity` bằng số nguyên an toàn (đối chiếu trần `money.ts`), từ chối cả đơn nếu bất kỳ dòng nào `is_available=0` hoặc không tìm thấy (D11 pt.5). Route/UI KHÔNG được tự tính giá — mọi lời gọi tính tiền đi qua hàm này (D19).

### `packages/catalog/src/catalog-read.ts` / `catalog-write.ts`

Hàm thuần `(db: D1Database, storeId: string, ...)`. Hằng chuỗi dùng chung cho package này (không phải package thứ 4 `shared` — D3 cấm) đặt cạnh trong `catalog-read.ts`, ví dụ `const STORE_SCOPE_SQL = 'store_id = ?'`.

### `packages/catalog/src/tables.ts`

`issueTableToken(db, storeId, tableId)`: sinh 32-byte CSPRNG base64url, SHA-256 digest, `db.batch([INSERT INTO table_secrets ..., UPDATE table_secrets SET revoked_at=<now+15min> WHERE table_id=? AND revoked_at IS NULL AND id != <new id>])` — trả token thô đúng một lần cho response, không bao giờ đọc lại. `resolveTableByToken(db, storeId, token)`: hash rồi `SELECT tables.* FROM tables JOIN table_secrets ON ... WHERE token_digest=? AND (revoked_at IS NULL OR revoked_at > ?)`.

### `packages/catalog/src/files/product-image.ts`

Bê khung `inspectAndCountProductImage` (magic-byte sniff + byte counter), `contentTypeFor`, `compensateNewObject` (retry ×3) nguyên vẹn theo `docs/reference/nexus/02-d1-data-layer-and-r2.md:530-625`; đổi `Cache-Control` phát ảnh thành `public, max-age=31536000, immutable` + xử lý `If-None-Match` (D13) thay vì `no-store` của SOURCE.

### `packages/orders/src/transitions/order-transitions.ts`

Guard thuần tách khỏi SQL, một hàm `*Eligible(status): boolean` cho mỗi transition hợp lệ (`paidEligible`, `preparingEligible`, `fulfilledEligible`, `cancelledEligible`, `refundedEligible`), theo khuôn `docs/reference/nexus/04-payfs-webhook-and-business-contracts.md:963-1032`.

### `packages/orders/src/order-write.ts` + `packages/orders/src/persistence/command-store.ts`

`runCommandBatch` kiểu SOURCE: `db.batch([...statements, guard])`, catch → phân loại lỗi qua `recoverFailedBatch` (ledger tồn tại → replay; sai trạng thái → 409; đơn biến mất → 404; còn lại → 500), theo `docs/reference/nexus/02-d1-data-layer-and-r2.md:245-280` và `docs/reference/nexus/04-payfs-webhook-and-business-contracts.md:1121-1135`.

### `packages/orders/src/private-access.ts`

Bê nguyên `digestOrderCapability` + JOIN lookup theo `docs/reference/nexus/04-payfs-webhook-and-business-contracts.md:1223-1265`, đổi bảng đích từ `order_access`-của-SOURCE (đã có multi-tenant `store_id`) sang `order_access` của TARGET (schema mục 3 report này).

---

## Test cần viết trước (TDD)

| Tên test | Assert gì | Dữ liệu vào | Trích dẫn pattern |
|---|---|---|---|
| `money.decimalToMinor rejects fractional VND` | Ném `MoneyError` code `money_over_precision` | `decimalToMinor('45000.50', 'VND')` | `docs/reference/nexus/02-d1-data-layer-and-r2.md:390-420` (`money.ts:49-54`, nhánh VND `fractionDigits=0`) |
| `money round-trip VND` | `minorToDecimal(decimalToMinor('45000','VND'),'VND') === '45000'` | `'45000'`, `'VND'` | `docs/reference/nexus/02-d1-data-layer-and-r2.md:420-425` (`money.ts:71`) |
| `resolveLineItemPrice rejects unavailable product` | Trả `{ ok:false, code:'product_unavailable' }`, KHÔNG tạo order_items | product `is_available=0` | D11 pt.5 (`docs/decisions/...:190-191`) |
| `resolveLineItemPrice ignores client price field` | Payload có `price`/`total` bị từ chối ở tầng validate `unknown_field`, không lặng lẽ bỏ qua, KHÔNG chạm `resolveLineItemPrice` | `{ productId, quantity:2, price: 1 }` | D11 pt.1 (`docs/decisions/...:186-187`) |
| `order_items line_total CHECK rejects mismatch` (integration D1 thật) | `INSERT` với `line_total_minor != unit_price_snapshot_minor*quantity` bị SQLite abort | `unit_price_snapshot_minor=20000, quantity=2, line_total_minor=39999` | `docs/reference/nexus/02-d1-data-layer-and-r2.md:912-916` (CHECK trong DDL) |
| `order transition guarded UPDATE returns 0 rows on stale status` | `result.meta.changes === 0` khi order đã ở `preparing` nhưng gọi transition `paid→preparing` lại lần 2 → map 409, **0 row nào khác bị ghi** (kiểm `updated_at` không đổi) | order.status = `'preparing'`, gọi lại `markPreparing` | `docs/reference/nexus/04-payfs-webhook-and-business-contracts.md:637-638,1511-1512, 1016-1033` |
| `commit assertion rolls back full batch on stale revision` | Batch cập nhật `products` với `expectedRevision` sai → toàn bộ statement trong batch bị rollback (đọc lại DB, không cột nào đổi), lỗi map 409 `revision_conflict` | `expectedRevision = product.revision - 1` | `docs/reference/nexus/02-d1-data-layer-and-r2.md:178-240` |
| `table_secrets grace window still resolves` | Token vừa bị xoay (revoked_at = now+15min) vẫn `resolveTableByToken` ra đúng bàn; sau khi `revoked_at` đã qua → 404 | 2 lần gọi: ngay sau xoay, và giả lập thời gian +16 phút | D17 (`docs/decisions/...:213-219`) |
| `unknown/expired/wrong token return identical 404` | So 3 response body (không tồn tại / hết hạn / sai định dạng) bằng `toEqual`, phải giống hệt | 3 case | D8 (`docs/decisions/...:200-202`) |
| `product image upload rejects spoofed extension` | `.jpg` Content-Type header nhưng magic bytes không khớp bất kỳ whitelist nào → 415, KHÔNG gọi `R2.put` | body = PDF bytes, header `image/jpeg` | `docs/reference/nexus/02-d1-data-layer-and-r2.md:530-545` (`contentTypeFor`) |
| `product image upload aborts stream over 5MB before completing put` | Stream bị `cancel()` giữa chừng, `R2.put` không hoàn tất, lỗi `product_image_size_exceeded` (413) | body giả lập > 5_000_000 byte | `docs/reference/nexus/02-d1-data-layer-and-r2.md:543-545` |
| `product image GET honors If-None-Match` | Header `If-None-Match` khớp `ETag` trước đó → response 304, không body | Gọi GET 2 lần, lần 2 kèm ETag lần 1 | D13 (`docs/decisions/...:227`) |
| `payment_reference matcher works on generator output, not hand-written constant` | Sinh `payment_reference` bằng hàm generator thật, nhét vào `content` giả lập rác ngân hàng bao quanh, matcher (`upper(content) LIKE '%'||ref||'%'`) phải khớp | `content = 'NGUYEN VAN A chuyen tien Ma GD ' + generatedRef + ' Trace123'` | D18 (`docs/decisions/...:239-247`), cảnh báo lệch của SOURCE tại `docs/decisions/...:230-235` (D16) |
| `order idempotency replays on same request_key + capability` | Gọi tạo đơn 2 lần cùng `request_key`+`capability_digest` → trả về CÙNG `order_id`, không có row `orders` thứ hai | request lặp lại | D10 (`docs/decisions/...:181-184`); `docs/reference/nexus/04-payfs-webhook-and-business-contracts.md:378-397` |

(13 test — vượt ngưỡng ≥8 yêu cầu, phủ đủ D8/D9/D11/D13/D17/D18 và 5 test bắt buộc của D14.)

---

## Cạm bẫy & lệch chuẩn so với repo mẫu

1. **KHÔNG bỏ `store_id`.** `docs/reference/nexus/02-d1-data-layer-and-r2.md:889-893` (mục 8.2.1) đề xuất bỏ `store_id` vì "QR Menu MVP là một quán". D4 (`docs/decisions/...:159-165`) ghi đè: giữ `store_id` hằng ngay từ migration đầu vì chi phí thêm sau gần bằng 0 còn chi phí bỏ rồi thêm lại là migrate toàn bộ khoá/FK/index/query. Toàn bộ DDL đề xuất ở mục 3 report này ĐÃ thêm lại `store_id` — không dùng nguyên khối DDL gốc trong tài liệu 02.
2. **KHÔNG lưu token thô.** DDL mẫu ở `docs/reference/nexus/02-d1-data-layer-and-r2.md:833-846` có `tables.secret_token TEXT NOT NULL CHECK(...)` và `orders.order_token TEXT NOT NULL CHECK(...)` — lưu giá trị token **thẳng vào bảng chính**, không phải digest. Đây là vi phạm trực tiếp D8. Copy nguyên khối đó là bug bảo mật nghiêm trọng (rò token qua backup/log/dump DB). Phải dùng `table_secrets` (D17) và `order_access` (D8, mượn mẫu `order_access`/`owner_invitations` của repo mẫu) như mục 3 report.
3. **Thứ tự ghi D1/R2 KHÔNG đồng nhất giữa tạo và xoá ảnh** — xem mục Kết luận #8. Copy máy móc "D1 trước, R2 sau" cho CẢ luồng upload sẽ tạo ra đúng lỗi mà D13 muốn tránh (D1 trỏ tới object chưa tồn tại). Chỉ áp "D1 trước" cho xoá/thay ảnh cũ; luồng tạo mới giữ thứ tự R2-trước-D1-sau-có-compensation của SOURCE.
4. **Đừng dùng `store_bootstrap_claims`/`owner_invitations`/`store_memberships` nhiều tầng của repo mẫu** cho phạm vi report này — nằm ngoài D2/D4/D8/D9/D11/D13/D17/D19/D23 được giao, thuộc D15/D20 (auth, ngoài phạm vi/non-goal của assignment này).
5. **Đừng copy chính tả `canceled` (1 chữ `l`)** của SOURCE (`0006-order-brief-contract.sql:31`) — Decision Record và PRD dùng `cancelled` (2 chữ `l`). Không nhất quán chính tả giữa migration/CHECK và code sẽ vỡ transition guard.
6. **Đừng đặt `DEFAULT` sinh `payment_reference` ở cột SQL** — đây chính là lỗi R4 mà D18 chỉ đích danh của repo mẫu (`docs/decisions/...:242`): DEFAULT sinh 32 hex trong khi matcher cần 18 hex → row dùng DEFAULT không bao giờ khớp webhook. Migration chỉ đặt CHECK định dạng, sinh giá trị 100% ở app code.
7. **`Cache-Control: no-store` của SOURCE cho ảnh (cả Console lẫn Storefront) không được copy cho route Storefront** — D13 yêu cầu `immutable` + `If-None-Match` cho ảnh public menu. Route Console (ảnh cho Owner quản lý, có auth) có thể giữ `private, no-store` vì không phải nội dung public bất biến theo cùng nghĩa.
8. **Đừng copy `.run()` cho mutation nghiệp vụ.** SOURCE cố tình không dùng `.run()` trong catalog/orders — mọi ghi đi qua `.batch()` để giữ tính atomic + kỹ thuật self-abort. `.run()` đơn lẻ chỉ chấp nhận được cho các job hạ tầng không cần atomic với bảng khác (ví dụ claim `order_email_jobs` — vẫn nên dùng conditional `UPDATE ... RETURNING`/`.run()` rồi đọc `meta.changes`, theo đúng mẫu `docs/reference/nexus/04-payfs-webhook-and-business-contracts.md:1511-1512`).
9. **`order_access` không nằm trong danh sách bảng mà PRD §5 liệt kê** (`docs/PRD.md` mục 5 chỉ liệt `categories, products, tables, orders, order_items, refund_requests`) — đây là khoảng trống của PRD, không phải lỗi report này. D8 bắt buộc phải có bảng digest riêng cho Secret Link đơn hàng; nếu người lập kế hoạch bỏ qua bảng này, tính năng "Secret Link theo dõi tiến độ món" (PRD §2.1 bước 4, §4.1 mục 4) không thể triển khai đúng D8.

---

## Câu hỏi còn mở

1. **Thứ tự ghi D1/R2 chính xác cho luồng TẠO ảnh mới** — D13 viết literal "Ghi D1 trước, R2 sau" nhưng cách diễn giải hợp lý duy nhất (không tự mâu thuẫn với "chấp nhận object mồ côi hơn D1 sai") là áp dụng riêng cho luồng XOÁ, còn luồng TẠO giữ thứ tự ngược của SOURCE. Report này đã chọn cách diễn giải có căn cứ nhất (mục Kết luận #8), nhưng đây KHÔNG phải trích dẫn tường minh 1-1 — nên xác nhận lại với chủ dự án trước khi khoá migration/route liên quan nếu cần độ chắc chắn tuyệt đối.
2. **Tên hằng `store_id` cho MVP một quán** (`'store_default'` trong report này) chưa được Decision Record hay PRD chốt literal string — D4 chỉ nói "giá trị hằng cho MVP một quán", không cho tên cụ thể. Người lập kế hoạch cần chốt 1 giá trị duy nhất trước khi viết migration thật (khác đi không ảnh hưởng kiến trúc, chỉ cần nhất quán toàn bộ CHECK/FK).
3. **`order_code` vs `payment_reference`** — PRD §5 liệt cả hai cột trên `orders` (`id, order_code, payment_reference, ...`) nhưng không giải thích khác biệt công dụng giữa `order_code` (mã hiển thị cho khách/bếp?) và `payment_reference` (mã đối soát ngân hàng, D18). Tài liệu 02 không đề cập `order_code`. Report này giữ cả hai cột theo đúng liệt kê PRD nhưng không có nguồn nào định nghĩa format/mục đích của `order_code` — cần làm rõ với PM/chủ dự án hoặc suy ra từ tài liệu 03/04 (ngoài phạm vi report này).