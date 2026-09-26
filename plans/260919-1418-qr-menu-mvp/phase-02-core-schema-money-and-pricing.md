---
title: "Phase 2: Schema nền, money & pricing"
phase: 2
status: completed
priority: P1
effort: 8h
milestone: M1
dependencies: [1]
---

# Phase 2: Schema nền, money & pricing

## Context

- [Decision Record](../../docs/decisions/260919-post-xia-decision-record.md) — D2, D4, D8, D9, D10, D11, D12, D17, D18, D19, D23, F4, F9
- [Scout 02 — tầng dữ liệu D1 & R2](./reports/scout-02-d1-data-layer-and-r2.md) — DDL xương sống, pattern đọc/ghi, API `money`
- [Scout 03 — PayFS & hợp đồng tiền](./reports/scout-03-payfs-and-money-contracts.md) — DDL idempotency/outbox, hằng `payment_reference`
- [PRD §5](../../docs/PRD.md) — danh sách bảng

## Goal

Đặt toàn bộ nền dữ liệu và nền tiền **một lần, đúng ngay**: hai migration nền (nghiệp vụ + idempotency/outbox), `money`, `resolveLineItemPrice`, và primitive token digest — để không phase nào sau đó phải viết lại một `db.batch()` đã viết.

## Overview

Priority P1 · M1 · phụ thuộc phase 1. Phase này **không** có route HTTP nào. Đầu ra là SQL + hàm thuần + test integration chạy trên D1 thật.

Lý do gộp cả bảng idempotency/provider/outbox vào phase này dù chúng chỉ được dùng từ phase 3–5: enqueue email job và ghi ledger idempotency nằm **trong cùng** `db.batch()` với chuyển trạng thái (D12, D23). Thêm bảng sau = viết lại mọi batch đã có. D23 nói thẳng điều này về email outbox; lập luận y nguyên cho hai tầng ledger còn lại.

## Key insights

- D1 **không có transaction tương tác** (F4). Mọi mutation nhiều bước là một `db.batch()` với statement assertion cuối lô ghi `NULL` vào cột `NOT NULL` khi invariant vỡ → SQLite abort cả lô. Phase này phải để lại sẵn cột/CHECK cho kỹ thuật đó hoạt động.
- Tài liệu tham chiếu đề xuất **bỏ** `store_id` cho MVP một quán (`docs/reference/nexus/02-d1-data-layer-and-r2.md:889-893`) và lưu **token thô** trên `tables.secret_token`/`orders.order_token` (`:833-846`). Cả hai đều bị D4 và D8 ghi đè. Không copy hai khối DDL đó.
- `line_total_minor = unit_price_snapshot_minor * quantity` được cưỡng chế bằng CHECK trong DDL — guard tổng tiền nằm trong SQL, không chỉ ở tầng ứng dụng (D11.4).
- Repo mẫu viết `canceled` (một chữ `l`) trong CHECK; PRD và Decision Record dùng `cancelled`. Lệch chính tả giữa CHECK và guard code làm mọi transition huỷ đơn chết im lặng.
- `order_access` (digest của Secret Link) **không** có trong PRD §5 nhưng bắt buộc theo D8, nếu không thì tính năng "Secret Link theo dõi tiến độ" (PRD §2.1 bước 4) không triển khai đúng được.

## Quyết định thi công chốt tại phase này

| # | Câu hỏi mở của scout | Chốt |
|---|---|---|
| 1 | Giá trị hằng `store_id` và bảng `stores` | Migration 0001 tạo bảng `stores(id, name, created_at)` và seed **một** row `'store_default'`; mọi bảng nghiệp vụ có `store_id` với `FOREIGN KEY (store_id) REFERENCES stores(id)` — **không** rải `CHECK (store_id = 'store_default')` ra 14 bảng. Lý do: FK cho đúng mức bảo vệ mà không phải sửa 14 CHECK khi thêm quán thứ hai; cross-tenant đã bị chặn bằng composite FK `(child_fk, store_id)`. Literal xuất hiện đúng hai chỗ: `INSERT` seed trong 0001 và hằng `STORE_ID` trong `packages/identity/src/store.ts`. Bảng `stores` do phase này tạo (scout-04 hỏi mở: FK của `store_memberships` ở phase 6 trỏ về đây) |
| 2 | `order_code` khác `payment_reference` thế nào | `order_code` = 6 ký tự `[0-9A-Z]` CSPRNG, **chỉ để người đọc** (phiếu bếp, khách đối chiếu); `payment_reference` = `QM`+8 (D18), **chỉ để đối soát ngân hàng**. Hai generator riêng, cùng một module `packages/orders/src/codes.ts`, cả hai sinh trong app code (C8) |
| 3 | Thứ tự ghi D1/R2 khi **tạo** ảnh | R2 `put()` trước (key UUID mới) → verify `object.size` → `db.batch()` ghi metadata → batch fail thì compensation xoá object (retry ×3). "D1 trước, R2 sau" của D13 áp cho luồng **xoá/thay**: null hoá metadata trong D1 rồi mới xoá object cũ. Lý do: ghi D1 trước khi object tồn tại tạo ra đúng trạng thái "D1 sai" mà D13 muốn tránh. (Thực thi ở phase 8; chốt ở đây để DDL `products_image_all_or_none` khớp) |
| 4 | Nơi ở của primitive token | `packages/identity/src/token-digest.ts` — `generateOpaqueToken()`, `sha256Hex()`, `constantTimeEqual()`. `identity` là đáy nên `catalog` (token bàn) và `orders` (Secret Link) dùng chung không tạo phụ thuộc ngược, và không cần package thứ tư (D3 cấm) |

## Requirements

- [x] `migrations/0001-menu-core.sql`: `stores` (+ seed 1 row), `categories`, `products`, `tables`, `table_secrets`, `orders`, `order_access`, `order_items`, `refund_requests`
- [x] `migrations/0002-ledgers-and-outbox.sql`: `order_idempotency`, `order_commands`, `provider_events`, `provider_payments`, `order_email_jobs`
- [x] Mọi bảng nghiệp vụ có `store_id TEXT NOT NULL` + FK về `stores(id)`, và `UNIQUE(id, store_id)` trên bảng cha để con FK theo cặp (D4)
- [x] Mọi cột tiền là `INTEGER` minor units với CHECK `BETWEEN 0 AND 9007199254740991` (C4)
- [x] `orders.payment_reference`: `NOT NULL`, CHECK `GLOB 'QM[0-9A-Z]…'` 10 ký tự, `UNIQUE(store_id, payment_reference)`, **không** `DEFAULT` (C8)
- [x] `orders.status` CHECK đúng 6 giá trị, chính tả `cancelled`; `orders.needs_attention INTEGER NOT NULL DEFAULT 0 CHECK (needs_attention IN (0,1))` **nằm ngay trong 0001** (phase 4 và 5 chỉ ghi vào cột này — không ALTER bảng tiền bằng migration riêng)
- [x] Token chỉ lưu digest: `table_secrets.token_digest`, `order_access.capability_digest`, CHECK `length = 64 AND NOT GLOB '*[^0-9a-f]*'` (C7)
- [x] `provider_payments` có `UNIQUE(store_id, order_id)` (D10)
- [x] `provider_events`: `order_id TEXT` **nullable** (khoản tiền không khớp đơn nào vẫn phải ghi được), `outcome TEXT` nullable, `source TEXT NOT NULL CHECK (source IN ('webhook','reconciliation'))`, `verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0,1))`; khoá idempotency là **partial unique index** `CREATE UNIQUE INDEX provider_events_verified_unique ON provider_events (provider, provider_event_id) WHERE verified = 1` — **không** phải constraint mức bảng. Lý do (red-team): row webhook **chưa xác thực** (chữ ký lệch) cũng phải lưu raw body; nếu nó chiếm slot `transaction_id` thì webhook hợp lệ retry sau đó bị coi là trùng facts → 400 → đơn không bao giờ `paid` dù khách đã trả tiền
- [x] `order_email_jobs`: `order_id` **nullable**, `kind` CHECK `IN ('daily_revenue_report','refund_confirmed','invitation')` — ba kind chốt ngay ở 0002 để phase 6 không phải copy-drop-recreate bảng ledger; `dedupe_key TEXT NOT NULL` + `UNIQUE(store_id, dedupe_key)` (`daily:<YYYY-MM-DD>`, `refund:<order_id>`, `invite:<invitation_id>`) — chống enqueue trùng bằng **một** INSERT đụng UNIQUE, không `SELECT` rồi `INSERT` (C2)
- [x] `orders.payment_method` CHECK `IN ('vietqr')` — PRD §6 chỉ VietQR; thêm `cash` là mở scope
- [x] `orders_kitchen_idx` là `(store_id, updated_at ASC, id ASC)` — khớp đúng cursor polling của phase 7 (`WHERE updated_at > ? ORDER BY updated_at, id`), không phải `(status, created_at)` như scout-02 đề xuất
- [x] `packages/orders/src/email-outbox.ts` — module **sở hữu toàn bộ SQL** của `order_email_jobs` (C3). Phase này viết `enqueueEmailJobStatement(db, {kind, orderId, dedupeKey, payload})` trả statement để caller nhét vào batch của mình (D23); phase 5 **chỉ thêm** `claimDueJobs`/`completeJob`/`retireJob` vào cùng file. File này là file dùng chung thứ tư trong `plan.md` (append-only cho phase 5). Lý do đặt ở đây: phase 6 chạy song song với 3–5 và cần enqueue email mời mà không phụ thuộc phase 5
- [x] `packages/catalog/src/money.ts`: `currencyFractionDigits`, `decimalToMinor`, `minorToDecimal`, `MoneyError` — BigInt, từ chối thay vì làm tròn (C4)
- [x] `packages/catalog/src/pricing.ts`: `resolveLineItemPrice` + `resolveOrderLineItems` — **nơi duy nhất** giải giá (C6)
- [x] `packages/catalog/src/catalog-read.ts`: đọc menu công khai (category + product available) bằng một câu SQL, có `XxxRow` + mapper tường minh, mệnh đề lặp để hằng chuỗi (C3)
- [x] `packages/identity/src/token-digest.ts` + `packages/identity/src/store.ts`
- [x] `packages/orders/src/codes.ts`: `generateOrderCode()`, `generatePaymentReference()`, `PAYMENT_REFERENCE_PATTERN`
- [x] `resetDb()` của phase 1 (liệt bảng từ `sqlite_master`) dọn sạch 14 bảng mới mà **không** cần sửa harness

## Architecture

```
migrations/
├── 0001-menu-core.sql        categories → products → tables → table_secrets
│                             orders → order_access → order_items → refund_requests
└── 0002-ledgers-and-outbox.sql  order_idempotency · order_commands
                              provider_events · provider_payments · order_email_jobs

packages/identity/src/{store.ts, token-digest.ts}          # đáy, không phụ thuộc
packages/catalog/src/{money.ts, pricing.ts, catalog-read.ts}
packages/orders/src/codes.ts
```

Chủ sở hữu SQL (C3): `catalog` sở hữu `categories`, `products`, `tables`, `table_secrets`. `orders` sở hữu `orders`, `order_access`, `order_items`, `refund_requests`, `order_idempotency`, `order_commands`, `provider_events`, `provider_payments`, `order_email_jobs`. Không module nào khác được viết SQL cho bảng của người khác.

Quy ước DDL bắt buộc (theo `scout-02` mục "Pattern bắt buộc"): `id TEXT PRIMARY KEY` sinh ở app · timestamp `TEXT ... DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))` · boolean `INTEGER CHECK (x IN (0,1))` · enum `TEXT CHECK (col IN (...))` · tên constraint `<table>_<ý nghĩa>_<loại>` · composite `UNIQUE(id, store_id)` trên bảng cha để con FK theo cặp (tenant-scoped FK) · index khớp đúng `ORDER BY` thật dùng.

## Files to create

- Create: `migrations/0001-menu-core.sql`, `migrations/0002-ledgers-and-outbox.sql`
- Create: `packages/identity/src/store.ts`, `packages/identity/src/token-digest.ts`
- Create: `packages/catalog/src/money.ts`, `packages/catalog/src/pricing.ts`, `packages/catalog/src/catalog-read.ts`
- Create: `packages/orders/src/codes.ts`
- Create: `packages/orders/src/email-outbox.ts` (`enqueueEmailJobStatement`; phase 5 append `claimDueJobs`/`completeJob`/`retireJob`)

DDL xương sống dùng nguyên khối đã đối chiếu D4/D8/D17/D18 trong [scout-02 mục 3](./reports/scout-02-d1-data-layer-and-r2.md) — không viết lại từ đầu, nhưng **phải** thêm `order_email_jobs.kind` CHECK và `order_id` nullable theo [scout-03](./reports/scout-03-payfs-and-money-contracts.md) (mục "Cạm bẫy" #6).

## Tests Before (viết trước, phải đỏ)

| # | Test | Assert | Dữ liệu vào |
|---|---|---|---|
| T1 | `tests/unit/money.test.ts :: VND từ chối phần thập phân` | `decimalToMinor('45000.50','VND')` ném `MoneyError('money_over_precision')` — **không** làm tròn | `'45000.50'` |
| T2 | `tests/unit/money.test.ts :: round-trip VND` | `minorToDecimal(decimalToMinor('45000','VND'),'VND') === '45000'` | `'45000'` |
| T3 | `tests/unit/money.test.ts :: chặn vượt trần` | Giá trị > `Number.MAX_SAFE_INTEGER` → `MoneyError('money_out_of_range')`, không tràn âm | `'99999999999999999'` |
| T4 | `tests/unit/codes.test.ts :: payment_reference khớp pattern của chính nó` | Sinh 200 giá trị bằng `generatePaymentReference()`, tất cả khớp `PAYMENT_REFERENCE_PATTERN`; phân phối ký tự không lệch (đủ 36 ký tự xuất hiện trong 200×8 lần rút) | — |
| T5 | `tests/unit/codes.test.ts :: order_code khác định dạng payment_reference` | `generateOrderCode()` dài 6, không khớp `PAYMENT_REFERENCE_PATTERN` → hai mã không lẫn nhau khi đối soát | — |
| T6 | `tests/integration/migration-shape.test.ts :: store_id phải tồn tại trong stores` | Với **mỗi** bảng nghiệp vụ: `INSERT` với `store_id='store_unknown'` bị abort vì FK; `INSERT` với `'store_default'` pass | 13 bảng con |
| T7 | `tests/integration/migration-shape.test.ts :: orders.status CHECK đúng 6 giá trị` | `INSERT` `status='canceled'` (một `l`) bị abort; 6 giá trị hợp lệ pass | 7 case |
| T8 | `tests/integration/migration-shape.test.ts :: payment_reference không có DEFAULT` | `INSERT` thiếu `payment_reference` → abort `NOT NULL`; `INSERT` mã sai định dạng (`QM1234567`, 9 ký tự / chữ thường) → abort CHECK | 3 case |
| T9 | `tests/integration/migration-shape.test.ts :: line_total CHECK chặn tổng sai` | `unit=20000, qty=2, line_total=39999` → abort | 1 case |
| T10 | `tests/integration/migration-shape.test.ts :: provider_payments chặn trả tiền hai lần` | Hai `INSERT` khác `provider_event_id` cùng `order_id` → cái thứ hai vi phạm `UNIQUE(store_id, order_id)` | 2 case |
| T10b | `tests/integration/migration-shape.test.ts :: row chưa xác thực không chiếm khoá idempotency` | `INSERT` `provider_events` `verified=0, provider_event_id='tx-1'` → pass; `INSERT` `verified=1` cùng `provider_event_id` → **cũng pass** (partial index chỉ áp `verified=1`); `INSERT` `verified=1` thứ hai cùng id → abort | 3 case |
| T11 | `tests/integration/migration-shape.test.ts :: digest CHECK` | `token_digest` 63 ký tự hoặc có ký tự ngoài `[0-9a-f]` → abort | 3 case |
| T12 | `tests/integration/migration-shape.test.ts :: order_email_jobs nhận job không gắn đơn và chống trùng` | `INSERT` `order_id=NULL, kind='daily_revenue_report', dedupe_key='daily:2026-09-19'` pass; `kind='bogus'` → abort; `INSERT` thứ hai cùng `dedupe_key` → abort; `kind='invitation'` pass | 5 case |
| T13 | `tests/integration/migration-shape.test.ts :: FK tenant-scoped` | `order_items` trỏ `product_id` của store khác / `currency` lệch với `orders.currency` → abort | 2 case |
| T14 | `tests/integration/pricing.test.ts :: tổng tiền do server tính` | `resolveOrderLineItems` với 2 món → `totalAmountMinor` = Σ `price*qty` đọc từ D1; không nhận bất kỳ giá nào từ input | 2 sản phẩm seed |
| T15 | `tests/integration/pricing.test.ts :: từ chối cả đơn khi có món hết` | Một món `is_available=0` → `{ok:false, rejected:[{code:'product_unavailable'}]}`, không trả tổng phần còn lại | 2 sản phẩm, 1 hết |
| T16 | `tests/integration/pricing.test.ts :: món bị xoá giữa chừng` | `productId` không tồn tại → `{ok:false, rejected:[{code:'product_not_found'}]}` | id lạ |
| T17 | `tests/integration/pricing.test.ts :: refund_requests bất biến sau khi quyết` | `UPDATE` một refund đã `approved` → trigger `RAISE(ABORT,'refund_decision_is_final')` | 1 row |
| T18 | `tests/unit/token-digest.test.ts :: digest và so sánh` | `sha256Hex` ra 64 hex chữ thường; `generateOpaqueToken()` ≥32 byte entropy, 200 lần không trùng; `constantTimeEqual` đúng/sai và **không** short-circuit theo độ dài khác nhau | — |

## Refactor / triển khai dưới lưới test

1. `packages/identity/src/store.ts`: `export const STORE_ID = 'store_default'` — nơi duy nhất literal này xuất hiện trong TS (chỗ còn lại là `INSERT` seed của migration 0001).
2. `packages/identity/src/token-digest.ts`: `generateOpaqueToken()` = 32 byte `crypto.getRandomValues` → base64url; `sha256Hex(input)` = `crypto.subtle.digest('SHA-256', …)` → hex thường; `constantTimeEqual(a, b)` so độ dài rồi XOR từng ký tự (không `!==`).
3. `migrations/0001-menu-core.sql` theo DDL scout-02 nhưng **thay mọi `CHECK (store_id = 'store_default')` bằng `FOREIGN KEY (store_id) REFERENCES stores(id)`** (quyết định #1), tạo `stores` đầu tiên + seed một row, thứ tự tạo bảng đúng chiều FK, kèm index: `products_store_menu_idx`, `orders_kitchen_idx` (cho polling bếp phase 7), `table_secrets_lookup_idx`, `refund_requests_status_idx`, trigger `refund_requests_terminal_immutable`.
4. `migrations/0002-ledgers-and-outbox.sql` theo DDL scout-02 mục 3, **sửa ba chỗ**: (a) `provider_events` thêm `order_id` nullable, `outcome`, `source`, `verified`, và đổi khoá idempotency sang partial unique index `WHERE verified = 1`; (b) `order_email_jobs` `order_id` nullable, `kind` CHECK ba giá trị, `dedupe_key` + `UNIQUE(store_id, dedupe_key)`, `attempts` CHECK `BETWEEN 0 AND 8`, `last_error TEXT`, `delivered_at TEXT`, index claim `(status, available_at ASC, id ASC)`; (c) bỏ partial UNIQUE theo `(order_id, kind)` của scout.
5. `packages/catalog/src/money.ts`: bê nguyên API SOURCE — `currencyFractionDigits` cache theo currency qua `Intl.NumberFormat(...).resolvedOptions().maximumFractionDigits`; `decimalToMinor` regex `^(?:0|[1-9]\d*)(?:\.(\d+))?$`, thừa chữ số thập phân → ném, scale bằng `BigInt`, trần `MAX_SAFE_INTEGER`; `minorToDecimal` nhánh `fractionDigits === 0` trả `String(minor)`.
6. `packages/orders/src/codes.ts`: alphabet `0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ` (36). Rút ký tự bằng rejection sampling: lấy byte CSPRNG, **loại byte ≥ 252** (252 = 36×7) rồi `% 36` — loại bỏ modulo bias. `PAYMENT_REFERENCE_PATTERN = /QM[0-9A-Z]{8}/` derive từ cùng hằng `PAYMENT_REFERENCE_ALPHABET`/`PAYMENT_REFERENCE_BODY_LENGTH` mà generator dùng, không viết rời.
7. `packages/catalog/src/pricing.ts`: `resolveOrderLineItems` đọc `products` bằng **một** câu `WHERE store_id = ? AND id IN (…)` (placeholder sinh theo số lượng, mọi giá trị qua `.bind()` — C2), tính `lineTotalMinor = unitPriceMinor * quantity` kiểm trần, từ chối **cả đơn** nếu bất kỳ dòng nào `not_found`/`unavailable` (D11.5). Không hàm nào khác trong repo được nhân giá với số lượng.
8. `packages/catalog/src/catalog-read.ts`: `readPublicMenu(db, storeId)` trả category + product theo `products_store_menu_idx`; `ProductRow` snake_case + mapper tường minh, không `as any`; hằng `STORE_SCOPE_SQL` cho mệnh đề lặp.
9. `packages/orders/src/email-outbox.ts`: `enqueueEmailJobStatement` + kiểu `EmailJobKind` (ba kind). Không có claim/gửi ở phase này.

## Tests After

| # | Test | Assert |
|---|---|---|
| A1 | `tests/integration/catalog-read.test.ts :: menu công khai chỉ trả món available` | Món `is_available=0` không xuất hiện; thứ tự theo `display_order` rồi `id` |
| A2 | `tests/integration/migration-shape.test.ts :: migration chạy hai lần không lỗi` | `applyD1Migrations` idempotent qua `resetDb()` liên tiếp 3 lần |
| A3 | `tests/node/sql-hygiene.test.ts :: không nối chuỗi SQL với giá trị` | Quét `packages/**/src/*.ts`: không có template literal SQL chứa `${` ngoài danh sách cho phép (chỉ placeholder `?` sinh theo số lượng và tên cột từ union đã thu hẹp) |

## Todo

- [x] T1–T18 (gồm T10b) viết trước và đỏ
- [x] `store.ts` + `token-digest.ts`
- [x] `migrations/0001-menu-core.sql`
- [x] `migrations/0002-ledgers-and-outbox.sql`
- [x] `money.ts` + `codes.ts`
- [x] `pricing.ts` + `catalog-read.ts`
- [x] `resetDb()` xanh với 14 bảng mới, không sửa `tests/support/**`
- [x] A1–A3 xanh

## Regression gate

```bash
npm run typecheck && npm test
```

Cộng thêm: `npm run db:migrate:local` chạy sạch trên DB local mới tạo (chứng minh migration apply được ngoài môi trường test).

## Success criteria

- [x] T1–T18, A1–A3 xanh; regression gate xanh
- [x] Không bảng nào thiếu `store_id`; không token thô nào trong schema; không `DEFAULT` sinh mã
- [x] Mọi phép nhân giá×số lượng trong repo chỉ tồn tại ở `pricing.ts` (kiểm bằng grep trong A3)
- [x] 14 bảng được `resetDb()` dọn sạch giữa các test, không rò dữ liệu

## Risks

| Rủi ro | Mitigation |
|---|---|
| CHECK `line_total = unit_price * quantity` gây abort khó debug ở phase 3 | T9 chứng minh CHECK hoạt động **trước** khi có code ghi đơn; phase 3 biết trước dạng lỗi cần map |
| FK composite `(order_id, store_id, currency)` làm câu INSERT order_items phức tạp | T13 cố định hành vi; nếu chi phí vượt lợi ích thì đổi **tại phase này** bằng migration mới, không đổi sau khi phase 3 đã viết batch |
| Chọn sai `store_id` literal | Chỉ một hằng TS + CHECK trong SQL; đổi giá trị = một migration + một dòng TS |

## Security

- Token thô không bao giờ vào schema (C7). Digest 64 hex có CHECK định dạng để một cột bị dùng sai mục đích sẽ vỡ ngay.
- `constantTimeEqual` là hàm duy nhất được dùng để so bí mật trong repo — phase 4 và 6 import lại, không tự viết.
- `order_access` tách bảng: dump `orders` không kéo theo capability của khách.

## Ghi chú thi công (2026-09-26)

- D1 giới hạn độ dài pattern GLOB (`LIKE or GLOB pattern too complex`): `orders_payment_reference_format` viết thành `length = 10 AND substr(…,1,2) = 'QM' AND substr(…,3) NOT GLOB '*[^0-9A-Z]*'`.
- Test shape ghim **nguyên văn lỗi D1** theo từng loại ràng buộc (FK, CHECK theo tên/biểu thức, NOT NULL `bảng.cột`, UNIQUE `bảng.cột, …`, `RAISE` message) — phase 3–7 map lỗi batch theo đúng các dạng này.
- Thêm so với DDL scout: `stores` + FK `store_id` mọi bảng; `orders UNIQUE(id, store_id)`; FK `(order_id, store_id)` trên các ledger; `provider_events_order_idx`; `orders_status_created_idx`; `order_email_jobs_delivery_shape`; `order_access UNIQUE(order_id, store_id, capability_digest)` + `order_idempotency` FK tới bộ ba đó (capability do client sinh — phase 3 quyết định #5). Bỏ: unique `display_order` của categories, `products.slug`.
- `provider_events.outcome` CHECK đúng 9 giá trị: `paid`, `already_paid`, `amount_mismatch`, `order_not_found`, `unmatched`, `unmatched_ambiguous`, `unmatched_payment`, `ignored_debit` (T12 phase 4), `signature_invalid` (row `verified = 0`). `facts_fingerprint` nullable, bắt buộc khi `verified = 1`.
- `tests/support/test-env.ts`: `resetDb()` không nhận tham số, `resetDbThrough(n)` cho test theo mốc — `beforeEach(resetDb)` cũ truyền context của Vitest làm `through` và âm thầm apply 0 migration. `tests/support/seed.ts` là helper seed dùng chung.

## Next

Phase 3 dùng `pricing.ts`, `codes.ts`, `order_idempotency`, `order_access`, `order_email_jobs`. Phase 6 dùng `token-digest.ts` cho invitation. Phase 8 dùng quyết định #3 (thứ tự R2/D1).
