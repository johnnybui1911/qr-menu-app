---
title: "QR Menu MVP — trọn vòng tiền tại bàn"
description: "Dựng MVP QR Menu & Instant Order trên Cloudflare (D1/R2/Workers) theo Decision Record D1–D23, test-first, chặn merge bằng 5 cổng CI."
status: in-progress
priority: P1
effort: 84h
branch: main
tags: [feature, backend, frontend, database, api, auth, critical]
blockedBy: []
blocks: []
created: 2026-09-19
---

# QR Menu MVP — trọn vòng tiền tại bàn

## Overview

Kế hoạch thi công greenfield cho `qr-menu-app`: khách quét QR tại bàn → xem menu → đặt món → nhận mã VietQR → chuyển khoản → webhook PayFS xác thực chữ ký → đơn `paid` → bếp thấy đơn trong ≤3 giây → `preparing` → `fulfilled`; Owner quản lý menu/bàn/refund và nhận email chốt ngày.

Kiến trúc đã khoá, kế hoạch này **không mở lại**: [Decision Record](../../docs/decisions/260919-post-xia-decision-record.md) (D1–D23, F1–F13) là nguồn sự thật; [`docs/PRD.md`](../../docs/PRD.md) là phạm vi sản phẩm. Thứ tự thi công theo khuyến nghị "A rồi C" của [brainstorm build approach](../reports/260919-brainstorm-build-approach.md): lát cắt dọc luồng tiền trước, sau đó hai nhánh song song.

Chế độ lập kế hoạch: `--tdd` (test viết trước ở mọi phase) · mode tự phát hiện `hard` (greenfield 6 workspace, 3 tích hợp ngoài chưa ai trong dự án chạy thật).

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | Một đồng VND (giả lập rồi thật) đi hết đường ống: storefront → API → D1 → VietQR → webhook đã ký → `paid` → bếp | P1 |
| 2 | Không mất tiền và không ghi nhận tiền hai lần: idempotency 3 tầng, state machine guard trong SQL, đối soát cron | P1 |
| 3 | Console có auth thật (Google + membership DB), Owner/Staff phân quyền theo bảng, bootstrap + mời nhân viên an toàn | P1 |
| 4 | Owner tự vận hành: menu + ảnh R2, bàn + xoay QR, duyệt refund, email chốt ngày | P2 |
| 5 | CI chặn merge đủ 5 cổng, trong đó có 1 e2e luồng tiền; 7 test bắt buộc của D14 + phiên brainstorm đều tồn tại | P1 |

## Hợp đồng liên phase (đọc trước khi cook bất kỳ phase nào)

Những quy ước sau là **biên giới chung**; phase nào vi phạm là phase sai, không phải hợp đồng sai.

| # | Hợp đồng | Nguồn |
|---|---|---|
| C1 | Chiều phụ thuộc `orders → catalog → identity`. Package không import app. Không có package thứ tư (`shared`/`common`/`utils`). Không barrel `index.ts`; mỗi workspace export `"./*": "./src/*.ts"` | D3 |
| C2 | Mọi truy cập D1 là SQL viết tay: `prepare().bind()` để đọc, `db.batch()` + câu assertion tự huỷ cuối lô để ghi. Không ORM, không nối chuỗi SQL, không `SELECT` rồi `UPDATE` hai round-trip | D2, F4 |
| C3 | Mỗi bảng có đúng **một** module sở hữu toàn bộ SQL của nó. Mệnh đề lặp lại (`store_id`, membership) là hằng chuỗi dùng chung, không copy-paste | D2 |
| C4 | Mọi giá trị tiền là `INTEGER` minor units VND (`fractionDigits = 0`). Không float, không `toFixed`. Sai định dạng thì **từ chối**, không làm tròn | D11, F9 |
| C5 | Client chỉ gửi `productId`, `quantity`, `notes`. Payload có `price`/`total` → lỗi `unknown_field`. Server đọc giá từ D1 và tự tính tổng; tổng được guard ngay trong SQL batch | D11 |
| C6 | Toàn bộ việc giải giá nằm trong **một** hàm `resolveLineItemPrice` của `catalog`. Không rải logic giá ra route hay UI | D19 |
| C7 | Token của khách (`table_token`, `order_token`, token invitation) sinh ≥32 byte CSPRNG, DB chỉ lưu SHA-256 digest, so khớp bằng JOIN trên digest, mọi thất bại trả **404 giống hệt nhau**. Token đi trong URL fragment rồi gửi qua header, không vào query string | D8, D17 |
| C8 | `payment_reference` = `QM` + 8 ký tự `[0-9A-Z]`, sinh bằng CSPRNG trong **một** hàm của code ứng dụng. **Cấm** `DEFAULT` sinh mã ở tầng cột SQL. `UNIQUE(store_id, payment_reference)` | D18, R4 |
| C9 | Mọi chỗ chạm PayFS nằm sau một cổng hẹp: module `payfs` trong `apps/worker` với đúng hai mặt tiếp xúc — `verifyWebhook`, `queryTransactions`. `packages/orders` không biết PayFS tồn tại | D22 |
| C10 | Không hard-code hostname. Mọi origin đọc từ biến môi trường, một tên biến cho một origin; có test khẳng định không còn hostname literal trong source/build input | D21 |
| C11 | Một tên biến cho một khái niệm secret: `PAYFS_WEBHOOK_API_KEY`, `PAYFS_WEBHOOK_SECRET`, `PAYFS_API_TOKEN`, `PAYFS_MERCHANT_BANK_BIN`, `PAYFS_MERCHANT_ACCOUNT`, `RESEND_API_KEY`, `RESEND_FROM_ADDRESS`, `EMAIL_LINK_HMAC_SECRET`, `OWNER_REPORT_EMAIL`, `INITIAL_OWNER_EMAIL`, `BETTER_AUTH_SECRET`, `INVITATION_HMAC_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. Không tái dùng chéo (R5, R6) — kể cả `BETTER_AUTH_SECRET` cho `context_hmac` của lời mời. Secret chỉ qua `wrangler secret put`. Không bí mật: `vars` `CONSOLE_ORIGIN`, `STOREFRONT_ORIGIN`, `PAYFS_API_BASE`, `RESEND_API_BASE`, và **một** biến build-time `VITE_STOREFRONT_API_BASE_URL` (Console cùng origin nên gọi `/api/...` tương đối, không cần biến nào). Biến `VITE_*` nằm trong bundle client — allowlist một phần tử, không thêm biến mới | D12, D16, D21 |
| C12 | Xung đột trạng thái / idempotency lệch capability trả **409**, không trả 200 im lặng. Webhook trùng ID khác facts trả **400**, tuyệt đối không retarget khoản tiền sang đơn khác | D9, D10 |
| C13 | `migrations/` là append-only, đánh số. Tại một thời điểm chỉ **một người** sở hữu số migration kế tiếp. File đã apply không bao giờ sửa | D2 |
| C14 | Mỗi phase kết thúc bằng lệnh xanh thật sự, không phải "đã viết xong code" | D14 |

## Phases

| # | Phase | Mốc | Phụ thuộc | Status |
|---|-------|-----|-----------|--------|
| 1 | [Skeleton & test harness](./phase-01-skeleton-and-test-harness.md) | M0 | — | Pending |
| 2 | [Schema nền, money & pricing](./phase-02-core-schema-money-and-pricing.md) | M1 | 1 | Pending |
| 3 | [Đặt đơn server-authoritative & VietQR](./phase-03-order-placement-and-vietqr.md) | M1 | 2 | Pending |
| 4 | [Webhook PayFS & chuyển `paid`](./phase-04-payfs-webhook-and-paid-transition.md) | M1–M2 | 3 | Pending |
| 5 | [Đối soát & email outbox](./phase-05-reconciliation-and-email-outbox.md) | M2 | 4 | Pending |
| 6 | [Auth Console, bootstrap & invitation](./phase-06-console-auth-bootstrap-and-invitations.md) | M3 | 2 | Pending |
| 7 | [Lệnh Console, kitchen inbox & refund](./phase-07-order-commands-kitchen-inbox-and-refunds.md) | M3 | 4, 5, 6 | Pending |
| 8 | [Menu, bàn/QR & ảnh R2](./phase-08-menu-tables-qr-and-r2-images.md) | M3 | 6 | Pending |
| 9 | [UI Storefront & Console](./phase-09-storefront-and-console-ui.md) | M3 | 3, 7, 8 | Pending |
| 10 | [Cổng ship, email thật & e2e](./phase-10-ship-gates-live-email-and-e2e.md) | M4 | 5, 9 | Pending |

Hai nhánh song song hợp lệ sau khi phase 2 xanh (phương án C của brainstorm): **nhánh tiền** 3 → 4 → 5 và **nhánh quản trị** 6 → 8. Chúng chỉ gặp nhau ở `apps/worker/src/index.ts` (bảng route) và `migrations/` — áp C13 khi chạy song song.

## Sở hữu file theo phase

Khai báo để chạy song song không đụng nhau. Ngoài danh sách của mình, phase chỉ được **thêm dòng** vào bốn file dùng chung: `apps/worker/src/index.ts` (bảng route), `apps/worker/src/console-route-match.ts` (allowlist — phase 7 và 8 đều thêm route), `packages/orders/src/email-outbox.ts` (phase 2 tạo với enqueue, phase 5 thêm claim/complete/retire — giữ C3 "một module sở hữu SQL của một bảng"), và `migrations/` (một người sở hữu số kế tiếp — C13). File test đã tồn tại: phase tạo file là chủ, phase sau chỉ thêm `describe` mới.

| Phase | Sở hữu độc quyền |
|---|---|
| 1 | `package.json`, `tsconfig.json`, `vitest.config.ts`, `wrangler.jsonc`, `apps/*/wrangler.jsonc`, `apps/*/vite.config.ts`, `scripts/assert-production-import-graph.ts`, `tests/support/**`, `tests/fixtures/migrations-probe/**`, `.github/workflows/ci.yml` (khung) |
| 2 | `migrations/0001-menu-core.sql` (gồm `orders.needs_attention`), `migrations/0002-ledgers-and-outbox.sql`, `packages/identity/src/{store,token-digest}.ts`, `packages/catalog/src/{money,pricing,catalog-read}.ts`, `packages/orders/src/codes.ts`, `packages/orders/src/email-outbox.ts` (phase 5 append-only) |
| 3 | `packages/catalog/src/tables-read.ts`, `packages/orders/src/{order-read,private-access,order-validation}.ts`, `packages/orders/src/commands/order-write.ts`, `apps/worker/src/{storefront-order-routes,storefront-cors,vietqr,log}.ts` |
| 4 | `apps/worker/src/payfs/**`, `apps/worker/src/payfs-webhook-routes.ts`, `packages/orders/src/transitions/**`, `packages/orders/src/provider-events.ts`, `packages/orders/src/commands/payment-settlement.ts`, `scripts/dev/sign-payfs-payload.ts`, `tests/fixtures/payfs/**` (không migration nào) |
| 5 | `apps/worker/src/{scheduled,order-email-service}.ts`, `apps/worker/src/payfs/{query-transactions,reconcile-pending-orders}.ts`, `packages/orders/src/{email-outbox,revenue-report}.ts` |
| 6 | `migrations/0003-better-auth-core.sql`, `0004-store-memberships.sql`, `0005-bootstrap-and-invitations.sql`, `apps/worker/src/{auth,console-request-context,http-response,console-route-match,console-session-routes,console-invitation-routes,console-membership-routes,environment}.ts`, `packages/identity/src/**` (trừ file của phase 2), `tests/support/console-session.ts`, `scripts/setup-secrets.sh`, `docs/runbook-oauth.md`, `.dev.vars.example` |
| 7 | `packages/orders/src/{refunds,command-ledger,kitchen-inbox}.ts`, `packages/orders/src/commands/order-commands.ts`, `apps/worker/src/{console-order-routes,console-refund-routes,console-provider-event-routes,console-report-routes}.ts` |
| 8 | `packages/catalog/src/{catalog-write,tables-write}.ts`, `packages/catalog/src/files/product-image.ts`, `apps/worker/src/{console-catalog-routes,console-table-routes,storefront-product-image-routes}.ts` |
| 9 | `apps/storefront/src/**`, `apps/console/src/**`, `vitest.browser.config.ts`, `tests/browser/**`, `tests/fixtures/vietqr/**` |
| 10 | `.github/workflows/**`, `tests/e2e/**`, `playwright.config.ts`, `scripts/e2e-seed.ts`, `docs/runbook-cutover.md`, `docs/runbook-smoke-test.md` |

## Success Criteria

- [ ] `npm run typecheck && npm test && npm run build:console && npm run build:storefront` xanh, và 1 e2e luồng tiền xanh — cả 5 cổng chặn merge trong CI (D14). `npm test` gồm ba tầng: `tests/node/**` (gate import-graph, hostname, secret-scan), `tests/unit+integration/**` (workerd + D1 thật), `tests/browser/**`
- [ ] 7 test bắt buộc tồn tại và xanh: tổng tiền server-authoritative · snapshot giá · idempotency 3 tầng · chuyển trạng thái trái phép 409 không side effect · phân quyền Staff/Owner · test vector chữ ký PayFS `86f02cef…c5e` · regex đối soát chạy trên `payment_reference` **do code sinh** với `content` có rác ngân hàng bao quanh
- [ ] Script tự ký payload bắn vào worker local làm đơn chuyển `paid`, không cần mạng, chạy được trong CI (D22)
- [ ] Cron `*/1` đối soát: đơn quá 2 phút được cứu bằng `/v1.1/transactions`, quá 15 phút gắn `needs_attention`, quá 30 phút `cancelled`; tiền về sau khi `cancelled` **không** hồi sinh đơn
- [ ] Job email chạy đủ vòng enqueue → claim → gửi → retire với backoff mũ; enqueue nằm trong **cùng** batch với chuyển trạng thái
- [ ] Bootstrap Owner lần hai bị từ chối; user Google lạ bị từ chối; token mời hết hạn/dùng lại bị từ chối với thông báo **giống hệt nhau**
- [ ] Staff không sửa được menu và không duyệt được refund; Owner duyệt refund chỉ ghi nhận trạng thái, không có side effect chuyển tiền (O4)
- [ ] Xoay QR bàn: token mới hiện đúng một lần, token cũ còn sống đúng 15 phút (D17)
- [ ] Bếp thấy đơn mới trong ≤3 giây bằng polling cursor `since` + ETag (D7)
- [ ] Gate import-graph phủ **cả** Console lẫn Storefront; không còn hostname literal trong source/build input (D3, D21)
- [ ] `git grep` không tìm thấy secret nào trong repo; mọi secret nạp bằng `wrangler secret put` (D16)

## Rủi ro & cách chặn

| Rủi ro | Vì sao thật | Chặn bằng | Phase |
|---|---|---|---|
| Canonicalization JSON lệch (escape Unicode, định dạng số) khi `content` có dấu tiếng Việt | PayFS ký trên JSON dựng lại, không phải byte gốc (F11). Bản chốt cũ ghi "raw body" là **sai** và sẽ từ chối 100% webhook hợp lệ | Test vector công bố chạy trong CI trước khi viết route; chữ ký lệch → ghi raw body vào `provider_events` rồi 401 | 4 |
| Khớp đơn chỉ dựa `content` + `amount` | Payload webhook không có trường nào trỏ về đơn (F13) | C8 + `amount` khớp tuyệt đối; lệch → không `paid`, gắn cờ cho Owner | 3, 4 |
| Ba tích hợp lạ (assets binding hai origin, chữ ký PayFS, `applyD1Migrations` trong workerd) không chạy cùng nhau | Chưa ai trong dự án này chạy thật | Phase 1–4 là lát cắt dọc: hỏng thì chỉ mất seed/scaffold, không mất hợp đồng nghiệp vụ | 1–4 |
| Retrofit idempotency/email outbox sau khi đã viết batch | Thêm sau = viết lại mọi SQL batch đã có (D23) | Migration nền của phase 2 (`0001-menu-core.sql` + `0002-ledgers-and-outbox.sql`) tạo sẵn `order_idempotency`, `order_commands`, `provider_events`, `provider_payments`, `order_email_jobs`; enqueue vào batch ngay từ phase 3 | 2, 3 |
| Preflight CORS mỗi request storefront | Token đi trong header, storefront khác origin (D17) | `Access-Control-Max-Age`; test khẳng định header có mặt | 3 |
| Chi phí read D1 khi polling 3s | D7 chấp nhận cho MVP | Endpoint bếp trả theo cursor `since` + ETag; ngưỡng nâng cấp ~30 bàn hoạt động | 7 |
| Cutover origin `workers.dev` → domain thật | Thiếu một chỗ là hỏng OAuth hoặc CORS (`redirect_uri_mismatch`) | C10 + runbook cutover liệt kê đủ **bốn** chỗ: OAuth redirect, CORS allowlist, cookie domain, build lại **storefront** với `VITE_STOREFRONT_API_BASE_URL` mới (Console cùng origin nên không phải build lại) | 10 |
| Hạn mức PayFS 30 giao dịch/tháng gói miễn phí | Một quán thật vượt trong ngày đầu | O6 — chốt gói trước ngày mở bán, không chặn code | — |

## Cổng red-team & validation (đã chạy 2026-09-19)

Bốn persona soi plan trước khi cook; báo cáo đầy đủ trong [`./reports/`](./reports/). Mọi Blocker dưới đây **đã được sửa vào plan**, không để lại cho người thi công tự phát hiện.

| # | Persona | Blocker | Đã sửa ở |
|---|---|---|---|
| 1 | Failure · Assumptions | `INSERT provider_events` nằm **ngoài** batch settle → worker chết giữa hai bước làm đơn kẹt vĩnh viễn, cả webhook retry lẫn cron đều bỏ qua vì `already_processed` | phase 4 quyết định #7, Architecture, T18 |
| 2 | Failure · Security | Row webhook **chưa xác thực** chiếm khoá idempotency `transaction_id` → sau khi sửa bug canonicalization, webhook hợp lệ bị 400 và đơn không bao giờ `paid` | phase 2 (`verified` + partial unique index), phase 4 quyết định #6, T11 |
| 3 | Security | Bootstrap cổng 1 không kiểm `emailVerified`, không chuẩn hoá email → tài khoản Google giả đốt `store_bootstrap_claims`, Owner thật vĩnh viễn không vào được | phase 6 Requirements, T9b, T9c |
| 4 | Security | Thiếu secret webhook không fail-closed → sót một `wrangler secret put` là bất kỳ ai POST `credit` với mã in trên màn hình khách cũng làm đơn `paid` | phase 4 quyết định #5, T11c |
| 5 | Security | Chỉ 1 trong 3 route invitation có guard → staff đọc được danh sách email mời và thu hồi lời mời | phase 6 Requirements, T18 |
| 6 | Security | `context_hmac` ký bằng `BETTER_AUTH_SECRET` (một secret hai việc) → xoay secret làm mọi lời mời chết im lặng | C11 + phase 6 quyết định #6 |
| 7 | Security | `scripts/e2e-seed.ts` commit Owner + session token vào repo | phase 10 quyết định #5 |
| 8 | Scope · Assumptions | Batch `paid` enqueue email nhưng không `kind` nào hợp lệ → CHECK abort **cả** batch ghi nhận tiền | phase 4 Requirements (bỏ enqueue), phase 2 (ba `kind`) |
| 9 | Scope · Assumptions | Phase 6 "song song" nhưng phụ thuộc module của phase 5 + migration 0007 đụng bảng phase 5 đang viết | `enqueueEmailJobStatement` dời về phase 2; bỏ 0007; phase 6 quyết định #7 |
| 10 | Scope | ~45 test `tests/node/**` + `tests/browser/**` không có runner và không nằm trong cổng CI → gate import-graph/hostname/secret-scan là hình thức | phase 1 (`vitest.node.config.ts`, `npm test`), phase 10 T3 |
| 11 | Scope | PRD §2.3.4 báo cáo doanh thu: có SQL (phase 5) và UI (phase 9) nhưng **không route nào** | phase 7 quyết định #5, T22 |
| 12 | Scope | Test âm cho e2e dùng `E2E_MUTATE=1` — một nhánh "không ghi nhận tiền" nằm trong code sản phẩm | phase 10 quyết định #3 |
| 13 | Assumptions | Test Console cần session mà không có cách mint cookie better-auth | phase 6 quyết định #8 + A4 |

Các mục "nên sửa" đã áp dụng: `payment_method` chỉ `vietqr` · `orders_kitchen_idx` khớp cursor `updated_at` · `provider_events.order_id/source` vào 0002 · `dedupe_key` thay partial UNIQUE của outbox · `resetDb` đọc `sqlite_master` thay danh sách bảng viết tay · `consoleOriginAllowed` phủ mọi method mutation · path ảnh chỉ nhận UUID · `.gitignore` `.dev.vars*` + ngoại lệ `.dev.vars.example` · chữ ký phải khớp `/^[0-9a-f]{64}$/i` · route thu hồi membership · màn mời nhân viên · `apps/worker/src/log.ts` redact token · allowlist biến `VITE_*`.

### Vòng sửa thứ hai (advisory review, cùng ngày)

Sau khi sửa 13 blocker, một vòng soi nữa bắt thêm những chỗ **plan tự mâu thuẫn** — đã sửa hết:

| Vấn đề | Đã sửa |
|---|---|
| `typecheck` rơi khỏi danh sách cổng CI ở phase 1 trong khi D14 và phase 10 T3 vẫn đòi | phase 1 Requirements + step 9 |
| `resetDb()` liệt bảng từ `sqlite_master` rồi DROP theo thứ tự tuỳ ý → vỡ FK khi xoá bảng cha còn row con | `PRAGMA defer_foreign_keys = true` mở đầu cùng batch |
| Binding `PROBE_MIGRATIONS` + fixture probe là scaffolding vĩnh viễn cho **một** test, và T8 như viết cũ không kiểm được gì | bỏ probe; T8 chỉ kiểm `resetDb()` chạy được với `migrations/` rỗng, bằng chứng schema thật là test đầu của phase 2 |
| VietQR chỉ có CRC check value + self round-trip → self-consistent-but-wrong, đúng cái bẫy chữ ký PayFS đã dạy | T2 neo vào **chuỗi VietQR mẫu công bố** + cổng quét bằng app ngân hàng thật ở phase 10 |
| `packages/orders/src/commands/payfs-matching.ts` vi phạm chính acceptance A2 (grep tên nhà cung cấp trong `packages/orders`) | đổi tên `payment-settlement.ts` |
| Base URL `api.payfs.vn`/`api.resend.com` literal trong `apps/worker/src` vi phạm T6 của phase 1 | `vars` `PAYFS_API_BASE`, `RESEND_API_BASE` (và stub được trong test) |
| `outcome='conflict_retry'` trả 200 — 200 là lệnh "đừng gửi lại", nên một thất bại tạm mất luôn retry | đọc lại đơn: `paid` → 200 `already_processed`, chưa → 5xx cho PayFS retry; thêm nhánh `provider_events_verified_unique` vào `recoverFailedBatch` |
| Cursor bếp `updated_at > since` không thể thoả T11 ("không bỏ sót khi trùng `updated_at`") | keyset hai cột `(updated_at, id) > (?, ?)`, cursor mang cả hai |
| `order:accept` trong `STAFF_ACTIONS` nhưng không route nào dùng | bỏ; `paid → preparing` chỉ có một tên là `order:prepare` |
| `migrations/0003-order-attention.sql` và `0007` chỉ để ALTER bảng mà phase trước chưa viết | gộp `needs_attention` vào 0001, ba `kind` vào 0002; toàn dự án còn **5** migration (0001–0005) |
| `email-outbox.ts` do hai phase cùng chạm nhưng ownership khai độc quyền | khai là file dùng chung thứ tư: phase 2 tạo, phase 5 append-only (giữ C3) |
| Email mời buộc mang token thô trong `payload_json` — xung đột C7 | chốt: giữ token, `completeJob`/`retireJob` null hoá `payload_json`; T20b kiểm |
| `VITE_CONSOLE_API_BASE_URL` vô nghĩa vì Console cùng origin | bỏ; allowlist còn đúng một biến, cutover chỉ build lại storefront |
| Tầng `test:browser` của phase 9 không được nối vào `npm test` | phase 9 sửa `package.json` root; `Intl vi-VN` NBSP được assert bằng `\u00a0` |
| Phase 8 T17 gọi route của phase 3 dù khai deps `[6]` | T17 kiểm qua `resolveTableByToken` trực tiếp |
| `tests/support/console-session.ts` nằm trong vùng độc quyền của phase 1 | carve-out cho phase 6 trong bảng sở hữu |

Đã kiểm và không có vấn đề (trích báo cáo): 6 bước verify webhook khớp D5 · token khách không vào query/log/`localStorage` · ân hạn 15 phút không leo quyền · SVG bị chặn vì không có magic bytes · enumeration bị chặn bởi allowlist 404 + payload từ chối giống hệt nhau · `UNIQUE(store_id, order_id)` chặn ghi nhận tiền hai lần · đối chiếu PRD → phase đủ, 7 test bắt buộc của D14 có mặt đủ.

## Dependencies

**Ngoài repo (không chặn phase 1–5):**

| # | Việc | Cần trước | Nguồn |
|---|---|---|---|
| O6 | Chốt gói dịch vụ PayFS (OpenBanking miễn phí 30 giao dịch/tháng) | ngày mở bán | D22 |
| O7 | Đăng ký PayFS + nối ngân hàng (MB / ACB / OCB) | phase 10 | D22 |
| O8 | Verify domain gửi email trên Resend (SPF/DKIM) + email nhận báo cáo + giờ chốt ngày | phase 10 | D23 |
| O9 | Cutover `workers.dev` → domain thật | ngày mở bán | D21 |

**Tài khoản/hạ tầng cần có từ phase 1:** Cloudflare account (D1 + R2 + Workers), Google Cloud OAuth client (phase 6), Resend API key chế độ test (phase 5).

**Tài liệu nền:** [PRD](../../docs/PRD.md) · [Decision Record](../../docs/decisions/260919-post-xia-decision-record.md) · [Xia report](../reports/260919-xia-nexus-handson-reference.md) · [Brainstorm build approach](../reports/260919-brainstorm-build-approach.md) · [Decisions locked](../reports/260919-brainstorm-decisions-locked.md) · [Pattern repo mẫu](../../docs/reference/nexus/00-index.md) · scout reports trong [`./reports/`](./reports/)

<!-- slug: qr-menu-mvp -->
