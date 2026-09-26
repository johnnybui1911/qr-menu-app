---
title: "Phase 8: Menu, bàn/QR & ảnh R2"
phase: 8
status: todo
priority: P1
effort: 10h
milestone: M3
dependencies: [6]
---

# Phase 8: Menu, bàn/QR & ảnh R2

## Context

- [Decision Record](../../docs/decisions/260919-post-xia-decision-record.md) — D2, D13, D15, D17, D19
- [Scout 02 — tầng dữ liệu & R2](./reports/scout-02-d1-data-layer-and-r2.md) — vòng đời ảnh, magic bytes, self-aborting UPDATE, `issueTableToken`
- [PRD §2.3.2, §2.3.3](../../docs/PRD.md)

## Goal

Owner tự vận hành quán: thêm/sửa/xoá danh mục và món, tải ảnh lên R2 an toàn, bật/tắt hết món, quản lý bàn và **xoay** mã QR với cửa sổ ân hạn 15 phút.

## Overview

Priority P1 · M3 · phụ thuộc phase 6 (session + RBAC Owner). Chạy song song được với phase 7 (file không chồng nhau; điểm gặp là `console-route-match.ts` và `index.ts` — chỉ thêm dòng).

## Key insights

- **"Xuất QR" = sinh token mới, hiện đúng một lần** (D17). DB chỉ có digest nên không có đường đọc lại. Token cũ sống thêm 15 phút để khách đang ngồi không bị 404 giữa bữa → một bàn có nhiều digest sống song song.
- Ảnh: key **opaque** `product-images/<uuid>`, MIME xác định bằng **magic bytes** (không tin `Content-Type` client), chặn kích thước ở 4 lớp (route → `Content-Length` → đếm byte khi stream → CHECK DB 5 MB).
- Thứ tự ghi khác nhau giữa tạo và xoá (quyết định #3 của phase 2): **tạo** = R2 trước, D1 sau, compensation xoá object nếu batch fail; **xoá/thay** = D1 trước (null hoá metadata), R2 sau (best-effort).
- `Cache-Control: public, max-age=31536000, immutable` + xử lý `If-None-Match` cho ảnh public — **đảo ngược** `no-store` của repo mẫu, vì key UUID là bất biến và menu phải tải nhanh trên 3G (D13). Route ảnh cho Console (có auth) giữ `private, no-store`.
- Cập nhật món dùng **self-aborting UPDATE** với `expectedRevision`: `col = CASE WHEN <revision đúng> THEN col ELSE NULL END` → sai revision thì rollback cả batch, map 409 `revision_conflict`. Hai Owner sửa cùng lúc không ghi đè nhau im lặng.
- `products.price_minor` phẳng, không biến thể (D19). Cỡ ly khác giá = món riêng. Giải giá vẫn chỉ nằm ở `pricing.ts` (C6) — phase này **không** thêm đường tính giá nào.

## Quyết định thi công chốt tại phase này

| # | Vấn đề | Chốt |
|---|---|---|
| 1 | Xoá món đã từng được đặt | **Không xoá vật lý**: `is_active = 0` (ẩn khỏi menu). `order_items` FK tới `products` nên xoá thật sẽ vỡ đơn cũ hoặc buộc phải nới FK — cả hai đều tệ hơn một cột cờ |
| 2 | Xoá danh mục còn món | Chặn: 409 `category_not_empty`. Owner phải chuyển/ẩn món trước. Rẻ hơn cascade và không mất dữ liệu |
| 3 | QR trả về dạng gì | Response trả `tokenUrl` = `${STOREFRONT_ORIGIN}/t#<token>` (token trong fragment — D17) **và** payload QR để client render cục bộ bằng cùng thư viện `qrcode` của phase 3. Không sinh ảnh PNG phía server |
| 4 | Cửa sổ ân hạn | Hằng `TABLE_TOKEN_GRACE_MS = 15 * 60 * 1000` trong `packages/catalog/src/tables-write.ts`; token cũ được set `revoked_at = now + grace` trong **cùng** batch với INSERT token mới |
| 5 | Ảnh phát qua đường nào | `GET /api/storefront/product-images/:key` (công khai, immutable cache). Không phát R2 public bucket URL: giữ một cổng để đổi cache/kiểm soát sau này |

## Requirements

- [x] CRUD danh mục: `GET/POST /api/console/categories`, `PATCH/DELETE /api/console/categories/:id`; quyền `menu:write`
- [x] CRUD món: `GET/POST /api/console/products`, `PATCH /api/console/products/:id` (kèm `expectedRevision`), `POST /api/console/products/:id/availability`; quyền `menu:write` / `menu:stock:toggle`
- [x] Upload ảnh: `PUT /api/console/products/:id/image` — body nhị phân, giới hạn 5 MB, MIME từ magic bytes (`image/jpeg`, `image/png`, `image/webp`); quyền `menu:image:write`
- [x] Xoá ảnh: `DELETE /api/console/products/:id/image` — D1 trước, R2 sau
- [x] Phát ảnh: `GET /api/storefront/product-images/:uuid` — path param **chỉ là UUID** (`/^[0-9a-f-]{36}$/`), server tự ghép key `product-images/${uuid}` (client không được điều khiển object key của bucket `FILES`); `immutable` + `ETag` + `304`, `X-Content-Type-Options: nosniff`
- [x] CRUD bàn: `GET/POST /api/console/tables`, `PATCH /api/console/tables/:id`; quyền `table:write`
- [x] Xoay QR: `POST /api/console/tables/:id/qr` — sinh token mới, trả **một lần**, đặt `revoked_at = now + 15m` cho token cũ; quyền `table:qr:export`
- [x] `packages/catalog/src/tables-write.ts` (`issueTableToken`) tách khỏi `tables-read.ts` của phase 3
- [x] Mọi mutation nhiều bước đi qua một `db.batch()` có assertion; sửa món có `expectedRevision`

## Architecture

```
PUT /api/console/products/:id/image          (D13 — tạo: R2 trước, D1 sau)
  ├─ permission menu:image:write                              → 403
  ├─ Content-Length > 5MB?                                    → 413
  ├─ stream: đếm byte + sniff 12 byte đầu (magic bytes)
  │     vượt 5MB giữa stream → cancel()                       → 413
  │     magic bytes không thuộc whitelist                      → 415
  ├─ key = `product-images/${crypto.randomUUID()}`
  ├─ FILES.put(key, bytes, {httpMetadata:{contentType}})
  ├─ verify object.size === byteCount                          → 500 + xoá object
  ├─ db.batch([ UPDATE products SET image_key/filename/content_type/size,
  │             revision = revision + 1
  │               WHERE store_id=? AND id=? AND revision=?,     ← expectedRevision
  │             assertion ])
  │     batch fail → compensation: FILES.delete(key) ×3 (best-effort)
  └─ 200 { imageKey, revision }   ← key cũ được xoá sau khi D1 đã commit

POST /api/console/tables/:id/qr              (D17 — xoay + ân hạn)
  └─ db.batch([
       INSERT table_secrets (token_digest = sha256(token)),
       UPDATE table_secrets SET revoked_at = <now + 15m>
         WHERE store_id=? AND table_id=? AND revoked_at IS NULL AND token_digest != ?,
       assertion: tồn tại đúng 1 secret của bàn này có revoked_at IS NULL
     ])
     → 200 { tokenUrl, qrPayload }   ← token thô chỉ ở đây, không bao giờ đọc lại
```

## Files to create / modify

- Create: `packages/catalog/src/catalog-write.ts` — danh mục + món (sở hữu SQL)
- Create: `packages/catalog/src/tables-write.ts` — `issueTableToken`, `TABLE_TOKEN_GRACE_MS`
- Create: `packages/catalog/src/files/product-image.ts` — `inspectAndCountProductImage`, `contentTypeFor`, `compensateNewObject`
- Create: `apps/worker/src/console-catalog-routes.ts`, `apps/worker/src/console-table-routes.ts`, `apps/worker/src/storefront-product-image-routes.ts`
- Modify: `apps/worker/src/console-route-match.ts`, `apps/worker/src/index.ts`
- Modify: `packages/catalog/src/catalog-read.ts` — thêm hàm đọc cho Console (gồm món đã ẩn)

## Tests Before (viết trước, phải đỏ)

| # | Test | Assert | Dữ liệu vào |
|---|---|---|---|
| T1 | `tests/unit/product-image.test.ts :: MIME từ magic bytes` | JPEG/PNG/WebP nhận đúng; PDF/`text` → `null` | 5 buffer |
| T2 | `tests/unit/product-image.test.ts :: extension/Content-Type giả không qua được` | Header `image/jpeg` nhưng bytes là PDF → 415, **không** gọi `FILES.put` (stub đếm 0) | 1 case |
| T3 | `tests/unit/product-image.test.ts :: hủy stream khi vượt 5MB` | Body 5_000_001 byte → `product_image_size_exceeded`, stream bị `cancel()`, không `put` hoàn tất | 1 case |
| T4 | `tests/integration/console-catalog.test.ts :: Owner tạo danh mục và món` | POST → 201, đọc lại thấy đúng; `price_minor` là INTEGER, không nhận chuỗi thập phân có phần lẻ | 2 request |
| T5 | `tests/integration/console-catalog.test.ts :: staff bị chặn` | Session staff: POST/PATCH/DELETE danh mục và món → 403; `GET` menu → 200 (`menu:read`) | 4 request |
| T6 | `tests/integration/console-catalog.test.ts :: expectedRevision sai → 409` | Hai PATCH với cùng `expectedRevision` → cái thứ hai 409 `revision_conflict`, **không** cột nào bị đổi bởi cái thứ hai | 2 request |
| T7 | `tests/integration/console-catalog.test.ts :: xoá danh mục còn món bị chặn` | DELETE danh mục có 1 món → 409 `category_not_empty`, danh mục còn nguyên | 1 request |
| T8 | `tests/integration/console-catalog.test.ts :: ẩn món thay vì xoá` | DELETE món đã có `order_items` → món `is_active=0`, `order_items` còn nguyên, món mất khỏi menu công khai | 1 request |
| T9 | `tests/integration/console-catalog.test.ts :: bật/tắt hết món` | `availability` false → món còn trong Console nhưng không đặt được (phase 3 trả `product_unavailable`) | 2 request |
| T10 | `tests/integration/product-image.test.ts :: upload thành công ghi cả R2 và D1` | 200; `FILES.get(key)` có object; `products.image_*` đủ 4 cột; `revision` +1 | 1 upload |
| T11 | `tests/integration/product-image.test.ts :: batch fail → compensation xoá object` | Ép `expectedRevision` sai → 409; `FILES.get(key)` trả `null` (object đã bị xoá) | 1 upload |
| T12 | `tests/integration/product-image.test.ts :: CHECK all-or-none` | `UPDATE` chỉ set `image_key` mà không set 3 cột còn lại → abort | 1 case |
| T13 | `tests/integration/product-image.test.ts :: xoá ảnh D1 trước R2 sau` | DELETE → 4 cột `image_*` = NULL ngay; object bị xoá sau; R2 lỗi vẫn trả 200 (chỉ log) | 1 case + stub lỗi |
| T14 | `tests/integration/product-image.test.ts :: phát ảnh có cache immutable + 304` | GET lần 1: `Cache-Control: public, max-age=31536000, immutable`, có `ETag`, `nosniff`; lần 2 với `If-None-Match` → 304 không body | 2 request |
| T15 | `tests/integration/product-image.test.ts :: key lạ → 404 đồng nhất` | UUID không tồn tại / sai định dạng / chứa `../` / chứa prefix khác (`secrets/x`) → **cùng một** 404; `FILES.get` chỉ được gọi với key bắt đầu bằng `product-images/` | 4 request |
| T16 | `tests/integration/console-tables.test.ts :: xoay QR trả token một lần` | POST `/qr` → body có `tokenUrl` chứa `#`; gọi `GET /api/console/tables/:id` → **không** có token nào; DB chỉ có digest | 2 request |
| T17 | `tests/integration/console-tables.test.ts :: token cũ sống 15 phút` | Sau khi xoay: `resolveTableByToken` (đọc trực tiếp, **không** qua route đặt đơn của phase 3 — giữ nhánh quản trị độc lập với nhánh tiền) vẫn giải ra đúng bàn với token cũ; giả lập +16 phút → không giải ra | 2 lần gọi |
| T18 | `tests/integration/console-tables.test.ts :: xoay hai lần liên tiếp` | Ba token: token 1 và 2 đều còn trong ân hạn của mình, token 3 mới nhất `revoked_at IS NULL`; assertion không vỡ khi có nhiều digest sống | 2 lần xoay |
| T19 | `tests/integration/console-tables.test.ts :: staff không xoay được QR` | Session staff → 403; `table:read` → 200 | 2 request |
| T20 | `tests/integration/console-tables.test.ts :: số bàn trùng bị chặn` | POST bàn cùng `table_number` → 409 (`UNIQUE(store_id, table_number)`) | 2 request |

## Refactor / triển khai dưới lưới test

1. `product-image.ts`: `contentTypeFor(first12Bytes)` whitelist 3 MIME; `inspectAndCountProductImage(stream, limit)` đọc chunk, sniff 12 byte đầu, đếm byte, `cancel()` khi vượt; `compensateNewObject(bucket, key)` retry ×3 rồi log.
2. `catalog-write.ts`: mỗi mutation là một `db.batch()`; sửa món dùng self-aborting `CASE WHEN revision = ? THEN … ELSE NULL END` và `revision = revision + 1`; xoá danh mục có statement điều kiện `NOT EXISTS (SELECT 1 FROM products WHERE category_id = ? AND is_active = 1)`.
3. `tables-write.ts`: `issueTableToken(db, storeId, tableId)` theo sơ đồ Architecture, trả token thô **một lần**; `TABLE_TOKEN_GRACE_MS` là hằng duy nhất.
4. `console-catalog-routes.ts` / `console-table-routes.ts`: permission → parse → domain → map lỗi (`409 revision_conflict`, `409 category_not_empty`, `413`, `415`); tất cả qua `withConsoleAuthHeaders`.
5. `storefront-product-image-routes.ts`: đọc **UUID** từ path rồi tự ghép `product-images/${uuid}` (không nhận key thô), `FILES.get(key, {onlyIf: {etagDoesNotMatch}})`, `object.writeHttpMetadata(headers)`, set `immutable` + `nosniff`, 404 đồng nhất khi thiếu.
6. `catalog-read.ts`: thêm `readConsoleMenu` (gồm món `is_active=0`) — tách khỏi `readPublicMenu` để storefront không bao giờ thấy món ẩn.
7. Thêm route vào allowlist + mount.

## Tests After

| # | Test | Assert |
|---|---|---|
| A1 | `tests/integration/console-catalog.test.ts :: menu công khai và menu Console khác nhau` | Món `is_active=0` chỉ thấy ở Console; món `is_available=0` thấy ở cả hai nhưng storefront hiện "hết món" |
| A2 | `tests/node/image-cache-policy.test.ts :: không còn no-store cho ảnh public` | Grep `storefront-product-image-routes.ts`: không có `no-store`; có `immutable` (D13 đảo ngược repo mẫu) |
| A3 | `tests/integration/console-tables.test.ts :: token không vào log hay query string` | Không route nào nhận token qua query; hàm log redact `tokenUrl` |

## Todo

- [x] T1–T20 viết trước và đỏ
- [x] `product-image.ts` (sniff + đếm byte trước)
- [x] `catalog-write.ts` (danh mục → món → availability)
- [x] `tables-write.ts`
- [x] 3 file route + allowlist + mount
- [x] `readConsoleMenu`
- [x] A1–A3 xanh

## Regression gate

```bash
npm run typecheck && npm test
```

## Success criteria

- [x] T1–T20, A1–A3 xanh
- [x] Ảnh: MIME theo magic bytes, ≤5 MB, key opaque, cache immutable + 304
- [x] Batch ảnh fail → không để lại object mồ côi trong trường hợp thường (T11)
- [x] Xoay QR: token hiện một lần, token cũ sống đúng 15 phút, nhiều digest song song không vỡ assertion
- [x] Staff không sửa được menu/bàn/QR; Owner làm được tất cả
- [x] Không xoá vật lý món đã từng được đặt

## Risks

| Rủi ro | Mitigation |
|---|---|
| Object mồ côi khi compensation cạn retry | Chấp nhận (D13: "object mồ côi hơn là D1 sai"); key opaque nên không rò thông tin. Ghi log có `incidentId` để dọn tay nếu cần |
| `immutable` cache làm ảnh cũ dính lại sau khi Owner đổi ảnh | Mỗi upload sinh **key UUID mới** nên URL đổi theo → cache cũ không bao giờ được dùng lại |
| Ân hạn 15 phút bị hiểu là "token cũ vẫn in được" | T16 khẳng định không có đường đọc lại token; UI phase 9 nói rõ "chỉ hiện một lần" |
| Nhiều digest sống song song làm JOIN trả nhiều bàn | `UNIQUE(store_id, token_digest)` + JOIN trên digest cụ thể → luôn ra tối đa một bàn (T18) |

## Security

- Không tin `Content-Type` client; MIME từ magic bytes; `nosniff` khi phát lại.
- Key R2 opaque: không nhúng tên món/id/extension → không rò catalog qua URL.
- Token bàn chỉ digest trong DB, hiện một lần, đi trong fragment (C7, D17).
- Owner-only cho mọi mutation menu/bàn; staff chỉ đọc (kiểm qua HTTP, không chỉ qua hàm thuần).

## Ghi chú thi công (2026-09-26)

Chia làm hai phần vì hai người thi công song song: `Main` làm toàn bộ tầng domain (`packages/catalog/src/{catalog-write,tables-write,catalog-read}.ts`, `packages/catalog/src/files/product-image.ts`, `apps/worker/src/storefront-product-image-routes.ts`) kèm T1–T3, T6, T10–T15, T17, T18 (một phần) qua `tests/unit/product-image.test.ts` + `tests/integration/{catalog-write,product-image,tables-write,catalog-read,pricing}.test.ts`; agent phụ (tôi) chỉ làm tầng route Console: `apps/worker/src/console-catalog-routes.ts`, `apps/worker/src/console-table-routes.ts`, cộng dòng vào `console-route-match.ts`/`console-session-routes.ts` (append-only, không đụng route của phase 7 đang chạy song song).

**Route mới**: `GET/POST /api/console/categories`, `PATCH/DELETE /api/console/categories/:id`, `GET/POST /api/console/products`, `PATCH/DELETE /api/console/products/:id`, `POST /api/console/products/:id/availability`, `PUT/DELETE /api/console/products/:id/image`, `GET/POST /api/console/tables`, `PATCH /api/console/tables/:id`, `POST /api/console/tables/:id/qr`. Giá vào bằng field `price` (chuỗi thập phân) qua `decimalToMinor(value, 'VND')` — sai định dạng/thừa số lẻ → `400 invalid_price`, không bao giờ nhận float. Quyền qua `evaluatePermission` (đã có sẵn từ phase 6: `menu:read/write/stock:toggle/image:write`, `table:read/write/qr:export`) qua `withConsoleContext`.

**Upload ảnh qua route**: vì `uploadProductImage` cần `expectedRevision`, route đọc từ header `x-expected-revision` (không có trong Requirements gốc nhưng cần thiết vì `PUT` với body nhị phân không có chỗ nào khác để mang revision — JSON body sẽ xung đột với body ảnh). `Content-Length` > 5MB bị chặn ở route trước khi đọc `request.body` (413 sớm); body rỗng → domain layer tự trả `product_image_empty` (400).

**Test route-level viết mới**: `tests/integration/console-catalog.test.ts` (T4, T5, T6, T7, T8+A1, T9, cộng 413/415 qua route ảnh) và `tests/integration/console-tables.test.ts` (T16, T17, T18, T19, T20, A3) — tất cả gọi qua HTTP thật bằng `consoleRequest`/`createConsoleSession` (helper của phase 6, tái dùng đúng như thiết kế). **A2 bỏ qua theo chỉ đạo của Main**: đã được T14 (của Main, `product-image.test.ts`) kiểm hành vi `immutable` cache thật; viết thêm `tests/node/image-cache-policy.test.ts` chỉ là grep trùng lặp.

**Mutation-check đã chạy tay**: xoá điều kiện `evaluatePermission` trong `forbidden()` của `console-catalog-routes.ts` (luôn trả `null` = cho qua) → T5 đỏ (staff POST category nhận `201` thay vì `403`), khôi phục lại → 8/8 xanh.

`npm run typecheck && npm test` xanh: node 40/40 (không đổi so với phase 6), workerd 292/292 (265 của phase 6 + 27 test mới của phase 7+8 cộng dồn — không tự tách riêng được vì phase 7 chạy cùng lúc).

## Next

Phase 9 dựng UI Console (menu, bàn, QR) và storefront (menu + ảnh). Phase 10 đưa luồng ảnh vào e2e nếu có thời gian, nhưng e2e chặn merge chỉ bắt buộc cho luồng tiền.
