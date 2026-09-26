---
title: "Phase 3: Đặt đơn server-authoritative & VietQR"
phase: 3
status: completed
priority: P1
effort: 8h
milestone: M1
dependencies: [2]
---

# Phase 3: Đặt đơn server-authoritative & VietQR

## Context

- [Decision Record](../../docs/decisions/260919-post-xia-decision-record.md) — D8, D10 (tầng khách), D11, D16, D17, D18, D21
- [Scout 03 — PayFS & hợp đồng tiền](./reports/scout-03-payfs-and-money-contracts.md) — idempotency tầng A, `rejectUnknown`, nguồn tài khoản nhận tiền
- [Scout 02 — tầng dữ liệu](./reports/scout-02-d1-data-layer-and-r2.md) — `order_access`, JOIN digest, `runCommandBatch`
- [PRD §2.1, §4.1](../../docs/PRD.md)

## Goal

Khách quét QR đọc được menu và đặt được đơn: server tự tính tổng, snapshot giá, sinh `payment_reference`, trả về mã VietQR và Secret Link — bấm trùng bao nhiêu lần cũng chỉ ra một đơn.

## Overview

Priority P1 · M1 · phụ thuộc phase 2. Đây là nửa đầu của lát cắt dọc luồng tiền; phase 4 nối nửa sau (webhook → `paid`). Hết phase này, đơn tồn tại ở `pending_payment` với mã đối soát đã sẵn sàng cho webhook.

## Key insights

- Payload khách **chỉ** được có `productId`, `quantity`, `notes`. Có `price`/`total` → `400 unknown_field`, không bỏ qua im lặng (D11.1). Đây là hợp đồng, không phải phòng thủ thừa: bỏ qua im lặng làm client tưởng giá của nó được dùng.
- Token bàn đi trong **URL fragment** rồi gửi qua header (D17) → request storefront là cross-origin có custom header → **có preflight**. Thiếu `Access-Control-Max-Age` là mất 1 RTT mỗi lần gọi.
- Mọi thất bại giải token trả **404 giống hệt nhau** (D8). Phân biệt "sai token" với "token hết hạn" là rò thông tin.
- `payment_reference` sinh trong app code, `UNIQUE(store_id, payment_reference)`; đụng UNIQUE thì **sinh lại và thử tiếp** (tối đa 3 lần) chứ không trả lỗi cho khách.
- Tổng tiền phải được guard **trong** batch: statement assertion cuối lô kiểm `total_amount_minor = (SELECT SUM(line_total_minor) FROM order_items WHERE order_id = ?)` (D11.4).

## Quyết định thi công chốt tại phase này

| # | Vấn đề | Chốt |
|---|---|---|
| 1 | Sinh ảnh QR ở đâu | Server trả **payload EMVCo/VietQR dạng chuỗi** (`00020101…6304<CRC>`); storefront render QR cục bộ bằng thư viện `qrcode` (npm, không phải `@qr/*` nên không vi phạm D3). Không gọi dịch vụ sinh ảnh QR bên ngoài: thêm phụ thuộc mạng vào đúng bước khách đang trả tiền |
| 2 | Nguồn tài khoản nhận tiền | Đúng hai biến, dùng chung cho cả sinh QR lẫn đối soát: `PAYFS_MERCHANT_BANK_BIN` (6 số NAPAS) và `PAYFS_MERCHANT_ACCOUNT`. Thiếu/sai định dạng → **ẩn QR**, trả `503 payment_unavailable`, không hiện thông tin sai (bài học R6/D16) |
| 3 | Sở hữu `tables` | Phase này sở hữu `packages/catalog/src/tables-read.ts` (`resolveTableByToken`); phase 8 sở hữu `tables-write.ts` (phát/xoay token). Hai file, không tranh chấp |
| 4 | `request_key` của idempotency | Client sinh, gửi qua header `Idempotency-Key`, định dạng `^[A-Za-z0-9_-]{16,128}$`; thiếu header → `400 idempotency_key_required` (không tự sinh hộ: tự sinh làm mất hết tác dụng chống bấm trùng) |
| 5 | Ai sinh token Secret Link (quyết định 2026-09-26, có tư vấn kongming) | **Client** sinh `orderToken` (≥32 byte CSPRNG, base64url) cùng lúc với `Idempotency-Key`, gửi trong header `X-Order-Token` của `POST /orders`; server chỉ kiểm định dạng `^[A-Za-z0-9_-]{43,128}$` và lưu SHA-256 vào `order_access` + `order_idempotency` (FK bộ ba, phase 2). Server **không** sinh và **không** trả token. Lý do: DB chỉ giữ digest nên replay (mất response, bấm lại) không thể trả lại token do server sinh → khách có đơn mà không có Secret Link. Client đã giữ token thì replay chỉ cần trả đơn. Cùng key + token khác → `409 idempotency_conflict`. Theo repo mẫu (`docs/reference/nexus/04-…:340-430`). Phương án HMAC(secret, order_id) bị loại: replay khi đó chỉ được chặn bằng token bàn — dùng chung cả bàn, sống lâu |

## Requirements

- [x] `GET /api/storefront/menu` — cần header `X-Table-Token`, trả menu công khai + thông tin bàn
- [x] `POST /api/storefront/orders` — tạo đơn server-authoritative, idempotent theo `Idempotency-Key`
- [x] `GET /api/storefront/orders/current` — tra cứu đơn bằng header `X-Order-Token` (Secret Link)
- [x] CORS cho origin storefront: allowlist từ `STOREFRONT_ORIGIN`, **không** credentials, `Access-Control-Max-Age` ≥ 600, cho phép header `X-Table-Token`, `X-Order-Token`, `Idempotency-Key`
- [x] Một `db.batch()` duy nhất cho tạo đơn: `orders` + `order_items`(n) + `order_access` + `order_idempotency` + assertion tổng tiền
- [x] Token Secret Link do client sinh (quyết định #5): header `X-Order-Token` bắt buộc trên `POST /orders`, DB chỉ có digest, response **không** chứa token
- [x] `apps/worker/src/vietqr.ts`: build payload EMVCo với CRC16-CCITT, `payment_reference` nằm ở trường nội dung chuyển khoản
- [x] Mọi thất bại token (bàn hoặc đơn) → 404 payload giống hệt

## Architecture

```
POST /api/storefront/orders
  │ 1. CORS + rejectUnknown(body)                      → 400 unknown_field
  │ 2. resolveTableByToken(sha256(X-Table-Token))       → 404 đồng nhất
  │ 3. validate Idempotency-Key + X-Order-Token        → 400
  │ 3b. ledger có sẵn key → cùng digest: trả đơn cũ (201) | khác: 409 idempotency_conflict
  │ 4. resolveOrderLineItems (catalog)                   → 409 items_unavailable (kèm danh sách)
  │ 5. generateOrderCode + generatePaymentReference
  │ 6. db.batch([
  │      INSERT orders …,
  │      INSERT order_items ×n …,
  │      INSERT order_access (capability_digest) …,
  │      INSERT order_idempotency (request_key, capability_digest, order_id) …,
  │      assertion: total_amount_minor = SUM(line_total_minor) AND status='pending_payment'
  │    ])
  │    ├─ UNIQUE(store_id, request_key) vỡ → đọc ledger:
  │    │    cùng capability → replay đơn cũ (201)   |  khác → 409 idempotency_conflict
  │    └─ UNIQUE(payment_reference) vỡ → sinh lại (≤3 lần) → hết lượt thì 503
  └─ 201 { orderCode, status, totalAmountMinor, paymentReference, vietqrPayload }
```

`apps/worker` chỉ là adapter: đọc header, gọi `packages/orders`, map lỗi domain sang HTTP. Không quy tắc nghiệp vụ nào nằm trong route (D1).

## Files to create / modify

- Create: `packages/catalog/src/tables-read.ts` — `resolveTableByToken(db, storeId, token)` JOIN trên digest + cửa sổ ân hạn
- Create: `packages/orders/src/commands/order-write.ts` — `createOrder(...)`, `runCommandBatch`, `recoverFailedBatch`
- Create: `packages/orders/src/order-read.ts` — `readOrderByCapability(db, storeId, token)`
- Create: `packages/orders/src/private-access.ts` — `digestOrderCapability`, issue + lookup
- Create: `packages/orders/src/order-validation.ts` — `rejectUnknown`, schema item
- Create: `tests/fixtures/vietqr/sample.txt` — chuỗi VietQR mẫu công bố + URL nguồn (phase này sở hữu)
- Create: `apps/worker/src/vietqr.ts`, `apps/worker/src/storefront-order-routes.ts`, `apps/worker/src/storefront-cors.ts`
- Create: `apps/worker/src/log.ts` — `logEvent(event)` redact `orderToken`/`tableToken`/`tokenUrl`/`Authorization`; mọi phase sau log qua đây (A3 kiểm hàm này tồn tại và redact)
- Modify: `apps/worker/src/index.ts` — mount `/api/storefront/*`

## Tests Before (viết trước, phải đỏ)

| # | Test | Assert | Dữ liệu vào |
|---|---|---|---|
| T1 | `tests/unit/vietqr.test.ts :: CRC16-CCITT đúng check value` | CRC16-CCITT-FALSE của `"123456789"` = `0x29B1` (check value công bố của thuật toán) | `"123456789"` |
| T2 | `tests/unit/vietqr.test.ts :: khớp chuỗi VietQR mẫu công bố` | Với **cùng** bank BIN / số tài khoản / số tiền / nội dung của một chuỗi VietQR mẫu công bố (NAPAS/vietqr.io: AID `A000000727`, service `QRIBFTTA`, nội dung ở tag `62`/`08`), generator phải cho ra **chuỗi giống hệt** — neo ngoài, không self-consistent. Fixture `tests/fixtures/vietqr/sample.txt` ghi rõ nguồn | 1 vector |
| T2b | `tests/unit/vietqr.test.ts :: payload TLV parse lại được` | Parse ngược payload sinh ra: mỗi TLV có `length` khớp, `payment_reference` nằm đúng trường nội dung, `amount` = `total_amount_minor`, 4 ký tự cuối là CRC hợp lệ | order giả 45000 VND |
| T3 | `tests/unit/vietqr.test.ts :: config thiếu → không sinh QR` | `PAYFS_MERCHANT_BANK_BIN` rỗng / sai định dạng → trả `null`, route map `503`, **không** sinh payload với giá trị rỗng | 3 config sai |
| T4 | `tests/unit/order-validation.test.ts :: từ chối field lạ` | Body item có `price` → `unknown_field`; có `total` ở cấp đơn → `unknown_field`; đủ 3 field hợp lệ → pass | 3 body |
| T5 | `tests/integration/storefront-order.test.ts :: tổng tiền do server tính` | Client gửi `quantity` 2×20000 + 1×15000 → `totalAmountMinor = 55000` bất kể client gửi gì; `order_items.unit_price_snapshot_minor` khớp giá D1 | 2 sản phẩm seed |
| T6 | `tests/integration/storefront-order.test.ts :: snapshot giá bất biến` | Tạo đơn → `UPDATE products SET price_minor = 99000` → đọc lại đơn: `unit_price_snapshot_minor` và `total_amount_minor` **không** đổi | 1 đơn |
| T7 | `tests/integration/storefront-order.test.ts :: replay cùng Idempotency-Key + capability` | POST 2 lần cùng key và cùng `X-Order-Token` → cùng body 201, `SELECT count(*) FROM orders` = 1 | 2 request |
| T8 | `tests/integration/storefront-order.test.ts :: key trùng capability khác → 409` | Cùng `Idempotency-Key`, `X-Order-Token` khác → `409 idempotency_conflict`, không tạo đơn thứ hai | 2 request |
| T9 | `tests/integration/storefront-order.test.ts :: món hết → từ chối cả đơn` | 1 trong 2 món `is_available=0` → `409`, body liệt kê `productId` có vấn đề, `orders` rỗng | 2 món |
| T10 | `tests/integration/storefront-order.test.ts :: 404 đồng nhất cho token bàn` | 3 case (không tồn tại / sai định dạng / đã hết ân hạn) → `toEqual` cùng body, cùng status | 3 request |
| T11 | `tests/integration/storefront-order.test.ts :: token bàn trong ân hạn vẫn đặt được` | Token vừa bị xoay (`revoked_at = now+15m`) vẫn tạo được đơn; sau mốc → 404 | thao tác thời gian |
| T12 | `tests/integration/storefront-order.test.ts :: Secret Link chỉ trả đúng đơn của mình` | `X-Order-Token` của đơn A không đọc được đơn B → 404 đồng nhất; đúng token → trả status + item | 2 đơn |
| T13 | `tests/integration/storefront-order.test.ts :: DB không lưu token thô` | Sau khi tạo đơn: `SELECT` toàn bộ `orders`/`order_access`/`order_idempotency` không chứa `X-Order-Token` hay `X-Table-Token` đã gửi; response cũng không chứa `X-Order-Token` | 1 đơn |
| T14 | `tests/integration/storefront-order.test.ts :: assertion tổng tiền chặn batch sai` | Ép `total_amount_minor` lệch 1 đồng trong batch → toàn bộ batch rollback, `orders` và `order_items` đều rỗng | 1 batch dựng tay |
| T15 | `tests/integration/storefront-cors.test.ts :: preflight có Max-Age` | `OPTIONS` từ `STOREFRONT_ORIGIN` → 204 với `Access-Control-Allow-Headers` chứa 3 header, `Access-Control-Max-Age` ≥ 600, **không** có `Access-Control-Allow-Credentials` | 1 request |
| T16 | `tests/integration/storefront-cors.test.ts :: origin lạ bị từ chối` | Origin không khớp env → không có `Access-Control-Allow-Origin` trong response | 1 request |
| T17 | `tests/integration/storefront-order.test.ts :: đụng UNIQUE payment_reference thì sinh lại` | Ép generator trả mã đã tồn tại ở lần đầu → đơn vẫn tạo thành công với mã khác, không lộ lỗi ra client | stub generator |

## Refactor / triển khai dưới lưới test

1. `order-validation.ts`: `rejectUnknown` duyệt allowlist khóa theo từng cấp (đơn: `items`; item: `productId`, `quantity`, `notes`), gặp khóa lạ → `{code:'unknown_field', field}`. `quantity` là số nguyên 1..99; `notes` ≤ 500 ký tự.
2. `tables-read.ts`: `resolveTableByToken` hash token rồi **một** câu `SELECT tables.* FROM tables JOIN table_secrets ON table_secrets.table_id = tables.id AND table_secrets.store_id = tables.store_id WHERE table_secrets.token_digest = ? AND (revoked_at IS NULL OR revoked_at > ?)`. Không select-rồi-so-sánh trong JS.
3. `private-access.ts`: `issueOrderCapability()` sinh token bằng `generateOpaqueToken()` (phase 2), trả `{token, digest}`; `lookupOrderByCapability` JOIN trên digest.
4. `order-write.ts`: `createOrder` gọi `resolveOrderLineItems` (không tự tính giá — C6), sinh `order_code` + `payment_reference`, dựng batch theo sơ đồ Architecture; `runCommandBatch` catch lỗi batch rồi `recoverFailedBatch` phân loại: ledger tồn tại + cùng capability → replay; ledger tồn tại + khác → 409; `NOT NULL constraint failed: orders.<cột assertion>` → 409 `total_mismatch`; `UNIQUE … payment_reference` → thử lại; còn lại → 500 + `incidentId`.
5. `vietqr.ts`: build TLV EMVCo (`00` version, `01` static/dynamic, `38` merchant account info với AID NAPAS + BIN + số tài khoản, `54` amount, `58` `VN`, `62`/`08` nội dung = `payment_reference`), CRC16-CCITT-FALSE 4 hex in hoa ở `6304`. Đọc config qua một hàm `readMerchantConfig(env)` fail-closed.
6. `storefront-cors.ts`: allowlist một origin từ `env.STOREFRONT_ORIGIN`; `Vary: Origin`; `Access-Control-Max-Age: 600`; không credentials (F10).
7. `storefront-order-routes.ts`: 3 route theo Requirements; toàn bộ lỗi đi qua một hàm `jsonError(code, status)` để 404 luôn cùng shape. Mount trước handler asset nhưng sau route webhook (phase 4 chèn vào đầu).
8. `apps/worker/src/index.ts`: thêm nhánh `/api/storefront/*`; giữ 404 JSON cho phần chưa map.

## Tests After

| # | Test | Assert |
|---|---|---|
| A1 | `tests/integration/storefront-menu.test.ts :: menu cần token bàn` | Thiếu `X-Table-Token` → 404 đồng nhất; có token hợp lệ → trả category + món available, không trả món ẩn |
| A2 | `tests/integration/storefront-order.test.ts :: response tạo đơn đủ trường` | Body chứa `orderCode`, `status`, `paymentReference`, `totalAmountMinor`, `vietqrPayload`; gọi `GET current` bằng `X-Order-Token` đã gửi ra đúng đơn |
| A3 | `tests/node/log-hygiene.test.ts :: token không vào log` | Hàm log của worker nhận object có `orderToken`/`tableToken` → output đã redact |

## Todo

- [x] T1–T17 (gồm T2b) viết trước và đỏ
- [x] `order-validation.ts` + `tables-read.ts`
- [x] `private-access.ts` + `order-read.ts`
- [x] `order-write.ts` (batch + recover)
- [x] `vietqr.ts` + `storefront-cors.ts`
- [x] `storefront-order-routes.ts` + mount vào `index.ts`
- [x] A1–A3 xanh

## Regression gate

```bash
npm run typecheck && npm test
```

## Success criteria

- [x] T1–T17, A1–A3 xanh
- [x] Không có phép tính tiền nào ngoài `pricing.ts`; route không đọc `products` trực tiếp
- [x] Token bàn/đơn không xuất hiện trong DB, log, hay query string
- [x] Bấm đặt đơn 5 lần liên tiếp cùng `Idempotency-Key` → đúng 1 row `orders`
- [x] Thiếu config tài khoản nhận tiền → 503 rõ ràng, không QR rỗng

## Risks

| Rủi ro | Mitigation |
|---|---|
| Payload VietQR sai TLV → khách quét không được, phát hiện muộn | T1 kiểm CRC theo check value công bố, **T2 neo vào chuỗi VietQR mẫu bên ngoài** (không chỉ self round-trip — đúng cái bẫy mà chữ ký PayFS đã dạy), T2b parse ngược; phase 10 có cổng **quét thử bằng app ngân hàng thật** trước khi mở bán |
| Preflight mỗi request làm menu chậm trên 3G | T15 cố định `Access-Control-Max-Age`; nếu vẫn chậm, cân nhắc trả token qua cookie **chỉ khi** xem lại D17 trước |
| `recoverFailedBatch` phân loại sai lỗi → 500 thay vì 409 | Test T8/T14 phủ hai nhánh chính; mọi nhánh còn lại trả 500 kèm `incidentId`, không map bừa |

## Security

- Token bàn chỉ tồn tại trong fragment URL trên máy khách; token Secret Link do client sinh và chỉ tồn tại phía client (C7, D8, D17, quyết định #5).
- 404 đồng nhất cho mọi thất bại token; không log token (A3).
- `rejectUnknown` chặn mass-assignment: client không thể đặt `status`, `total_amount_minor`, `payment_reference`.
- Không CORS credentials cho storefront (F10); cookie session chỉ thuộc Console.

## Ghi chú thi công (2026-09-26)

- Neo T2: chuỗi `Generate(120000, "970415", "0011001932418", …)` công bố trong README của `github.com/subiz/vietqr` (CRC `C15C` kiểm độc lập) — `tests/fixtures/vietqr/`. Đây là output của một thư viện bên thứ ba, không phải mẫu NAPAS; cổng quét bằng app ngân hàng thật ở phase 10 vẫn bắt buộc.
- Kiểm cấu hình tài khoản nhận tiền **trước** khi tạo đơn: không có QR thì không có đơn (`503 payment_unavailable`).
- Response tạo đơn và `GET current` dùng chung một view: `orderCode, status, tableNumber, currency, totalAmountMinor, paymentReference, createdAt, items, vietqrPayload` (`vietqrPayload` chỉ khi `pending_payment`, còn lại `null`).
- Mã lỗi tạo đơn: `unknown_field`/`invalid_field` (400, kèm `field`), `invalid_json`, `idempotency_key_invalid`, `order_token_invalid` (400), `not_found` (404 đồng nhất), `items_unavailable` (409, kèm `items`), `idempotency_conflict`, `order_token_in_use` (409), `payment_unavailable` (503); assertion tổng tiền vỡ là lỗi lập trình → `500 internal_error` + `incidentId` được log (tư vấn kongming phase 3).
- `apps/worker/src/worker-secrets.d.ts` khai kiểu các secret (optional, buộc fail-closed) cho cả `Env` toàn cục lẫn `Cloudflare.Env`; `vitest.config.ts` bind giá trị test.
- Bằng chứng chạy thật: `wrangler dev` + D1 local — preflight, menu, đặt đơn, replay giống từng byte, chặn giá phía client, Secret Link.

## Next

Phase 4 đọc `payment_reference` do phase này sinh và chuyển đơn sang `paid` trong batch có enqueue email. Phase 9 dựng UI tiêu thụ đúng 3 route này.
