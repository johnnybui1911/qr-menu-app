# Xia Report — nexus-handson → QR Menu App

Mode: `--compare` (tài liệu tham chiếu, không sinh code).
Ngày: 2026-09-19.
Nguồn: `~/Desktop/nexus-handson` (local, read-only — `git status` xác nhận 0 file tracked bị thay đổi).
Đích: `~/Desktop/qr-menu-app` — greenfield, hiện chỉ có `docs/PRD.md`.

Tài liệu chi tiết: [`docs/reference/nexus/`](../../docs/reference/nexus/00-index.md) (5 file, 4769 dòng, ~700 trích dẫn `path:line`).

---

## 1. Kết luận đứng đầu

Repo mẫu là **tham chiếu chất lượng cao cho tầng nghiệp vụ và tầng dữ liệu**, nhưng **không khớp stack mà PRD của bạn đang giả định**. Ba lệch pha phải chốt trước dòng code đầu tiên:

| PRD nói | SOURCE thực tế | Bằng chứng |
| --- | --- | --- |
| Next.js / Cloudflare Pages | Vite 8 + React 19 SPA, phục vụ bằng Worker `assets` binding | `docs/PRD.md:35-36` vs `wrangler.jsonc:4,8-16`; `package.json:14,25` |
| Drizzle ORM | Raw SQL `prepare().bind()` + `db.batch()`, migration SQL viết tay | `docs/PRD.md:37` vs `packages/catalog/src/catalog-read.ts`, `migrations/0001..0016` |
| `packages/core` (1 package) | 3 package: `@nexus/catalog`, `@nexus/orders`, `@nexus/identity` | `docs/PRD.md:37` vs `package.json:56-58` |

Ngoài ra PRD ghi "đơn nổ về màn hình Bếp **real-time**" (`docs/PRD.md:20`); SOURCE **không có** WebSocket / SSE / Durable Object — chỉ `setInterval` 5 giây ở client (`apps/storefront/src/storefront-app.tsx:306-309`).

**Điểm rủi ro: CAO (7 hạng mục critical).** Theo khung challenge, mức này yêu cầu dừng ở `--compare` trước khi lập kế hoạch thực thi — đúng phạm vi bàn giao lần này.

---

## 2. Giải phẫu nguồn (source anatomy)

```
nexus-handson/
├── apps/
│   ├── worker/src/        18 file phẳng, mỗi file = một mặt tiếp xúc HTTP
│   │                      (console-*, storefront-*, payfs-webhook, auth, environment)
│   ├── console/           SPA React chia theo destination (Products / Orders / Third-party logs)
│   └── storefront/        SPA React, HTTP-only, origin riêng, wrangler.jsonc riêng
├── packages/
│   ├── catalog/           products, variant matrix, CSV import, R2 files, money, snapshot giá
│   ├── orders/            order read/write/commands, transitions, persistence ledger, email outbox
│   └── identity/          google-identity, admission, membership, permissions, invitations
├── migrations/            0001..0016, append-only SQL, không dùng tooling ORM
├── tests/                 unit 15 · integration 35 · browser 7 · node 2 · e2e 7
├── scripts/               assert-production-import-graph.ts, verification/evidence-ledger.ts
└── wrangler.jsonc         Console+API (DB, FILES, ASSETS, cron) — storefront tách riêng
```

Bốn quy tắc kiến trúc mà repo mẫu tự cưỡng chế (`AGENTS.md:16-18`, `README.md:10`):

1. Worker chỉ là HTTP adapter + platform composition; domain write / SQL batch / transition rule nằm trong `packages/`.
2. Console chỉ được import `catalog`; type UI của Order ở lại trong app Console.
3. Storefront thuần HTTP, không import package nào.
4. `orders` → `catalog` một chiều; `catalog` không bao giờ phụ thuộc `orders`; package không bao giờ phụ thuộc app.

Quy tắc 1–4 được **kiểm bằng máy** chứ không bằng niềm tin: plugin Vite thu module thật vào bundle production rồi `scripts/assert-production-import-graph.ts` chặn build nếu lọt file design/prototype/fixture.

---

## 3. Ma trận phụ thuộc (source → target)

Target là greenfield nên không có cột `EXISTS`. Phân loại: **REUSE** (bê gần nguyên văn) · **ADAPT** (giữ pattern, đổi domain) · **NEW** (PRD yêu cầu, SOURCE không có) · **REJECT** (không mang sang).

| Thành phần SOURCE | File gốc | Phân loại | Ghi chú |
| --- | --- | --- | --- |
| `money.ts` (minor units, BigInt, từ chối thay vì làm tròn) | `packages/catalog/src/money.ts:41-75` | **REUSE** | VND có `fractionDigits = 0` → dùng nguyên |
| Snapshot giá lúc đặt đơn | `packages/catalog/src/private-order-snapshot.ts:70-110` | **REUSE** | Khớp đúng contract "Price Snapshot" của PRD |
| Idempotency khách đặt đơn (`order_idempotency` UNIQUE + capability digest) | `packages/orders/src/commands/order-write.ts:49-72,97-100,291-295` | **REUSE** | Replay đơn cũ; lệch capability → 409 |
| Idempotency webhook (`transaction_id` UNIQUE + `facts_fingerprint`) | `migrations/0013-payfs-webhook-payments.sql:1-11`; `order-commands.ts:493-540` | **REUSE** | `ON CONFLICT DO NOTHING`, trùng ID khác facts → 400 |
| `db.batch()` + commit assertion tự huỷ | `packages/catalog/src/files/product-image.ts:189-208` | **REUSE** | D1 không có `SELECT FOR UPDATE`; đây là cách duy nhất atomic |
| State machine guard thuần | `packages/orders/src/transitions/order-transitions.ts:45-59` | **ADAPT** | SOURCE: `pending/paid/fulfilled/canceled`. Thêm `preparing`, `refunded` |
| Secret link (token 32 byte, lưu SHA-256 digest, 404 đồng nhất) | `packages/orders/src/private-access.ts:5-27` | **REUSE** | Áp cho `order_token` và `table_token` |
| Email outbox + cron + backoff | `migrations/0014`; `apps/worker/src/order-email-service.ts:37-114`; `wrangler.jsonc:21-23` | **REUSE** | Đổi secret HMAC (xem R5) |
| Vòng đời ảnh R2 (key UUID, MIME từ magic bytes, ghi D1 trước R2 sau, compensation) | `packages/catalog/src/files/product-image.ts` | **ADAPT** | Đổi `Cache-Control: no-store` → `immutable` (xem R6) |
| betterAuth trực tiếp trên binding D1 | `apps/worker/src/auth.ts` | **REUSE** | Không cần ORM cho auth |
| Hai cổng chặn Google user lạ (`getUserInfo` → admission, `validateUserInfo` → membership) | `apps/worker/src/auth.ts:108-131` | **REUSE** | Cổng 2 là fail-closed thật |
| Invitation token (digest + HMAC context, TTL 7 ngày, one-time) | `migrations/0012`; `packages/identity/src/invitations.ts` | **ADAPT** | Mở `role CHECK` cho `staff` |
| `evaluatePermission` 3 tầng (route allowlist → identity gate → permission) | `console-route-match.ts`; `index.ts:92-114`; `permissions.ts:27-46` | **ADAPT** | Rút gọn về Owner/Staff |
| Provider event log (raw payload, màn "Third-party logs") | `migrations/0015:1-21`; `console-provider-event-routes.ts` | **REUSE** | Bắt buộc để đối soát tiền |
| `applyD1Migrations` + reset bằng DROP toàn bảng trong test | `tests/support/catalog-test-env.ts:113-156` | **REUSE** | Nền cho toàn bộ test có D1 |
| Import-graph gate | `scripts/assert-production-import-graph.ts` | **ADAPT** | SOURCE chỉ gate Console; target phải gate cả Storefront |
| Multi-store (`store_id` mọi bảng, `store_memberships`) | `migrations/0009` | **ADAPT** | Xem D4 |
| CSV import, variant matrix, delivery file | `packages/catalog/src/import/*`, `variant-matrix.ts` | **REJECT** | Ngoài scope MVP (`docs/PRD.md:78-81`) |
| `payment-intergration-prd.md` | file gốc `:16-20` | **REJECT** | Chứa API key / webhook secret / số tài khoản **plaintext** |
| Real-time kitchen inbox | — | **NEW** | SOURCE chỉ polling 5s |
| Table / QR token | — | **NEW** | SOURCE không có khái niệm bàn |
| Refund request → owner approve | một phần: `permissions` đã có `refund:request` / `refund:decide` | **NEW (một phần)** | Bảng `refund_requests` phải viết mới |

---

## 4. Challenge — các giả định phải trả lời trước khi lập kế hoạch

| Giả định | Câu trả lời của SOURCE | Rủi ro nếu giữ nguyên cho target |
| --- | --- | --- |
| "Dùng Next.js trên Pages" | Không có Next.js. Toàn bộ script build/deploy gắn chặt Vite + `@cloudflare/vite-plugin` (deploy trỏ vào `apps/console/dist/.../wrangler.json` do plugin sinh, `package.json:32`) | Mất 100% pipeline tham chiếu; phải tự dựng OpenNext/adapter, thêm nhiều ngày và một lớp lỗi lạ |
| "Dùng Drizzle ORM" | Không có ORM; mọi pattern atomicity là chuỗi SQL thô trong `db.batch()` | Copy nửa vời → mất cơ chế chống race mà vẫn không có type-safety |
| "`packages/core` gộp một" | 3 package, biên giới cưỡng chế bằng `dependencies` từng workspace | Gộp 1 package thì logic refund/pricing có thể lọt vào bundle Storefront chạy trên máy khách |
| "Webhook PayFS an toàn" | Chỉ so sánh API key tĩnh `X-Client-API-Key`, không HMAC / timestamp / IP allowlist (`payfs-webhook-routes.ts:106-108`); plan của SOURCE tự nhận đây là "accepted high residual risk" | Lộ key = giả được lệnh credit = mất tiền thật |
| "Mất webhook thì tự phục hồi" | Không có reconciliation/polling PayFS | Khách chuyển tiền xong mà đơn kẹt `pending_payment`, không cơ chế nào chữa |
| "Đơn nổ real-time về Bếp" | `setInterval(..., 5_000)` ở client | Kỳ vọng sản phẩm lệch thực tế kỹ thuật; phải chốt polling hay SSE |
| "Đã có sẵn quy trình nhận webhook local" | Grep toàn repo: 0 kết quả `cloudflared`/`ngrok` | Phải tự dựng; tài liệu 04 mục 8.2 đánh dấu `[SUY LUẬN]` |

---

## 5. Ma trận quyết định

| # | Quyết định | Cách SOURCE | Cách PRD | Khuyến nghị | Rủi ro |
| --- | --- | --- | --- | --- | --- |
| D1 | Framework UI | Vite SPA + Worker `assets` | Next.js / Pages | **Theo SOURCE** — Vite + React SPA, một Worker phục vụ cả API lẫn asset | Cao nếu chọn Next.js: mất toàn bộ pipeline tham chiếu |
| D2 | Tầng dữ liệu | Raw SQL toàn bộ | Drizzle toàn bộ | **Hybrid**: Drizzle cho schema + CRUD + `drizzleAdapter` của better-auth; raw SQL trong `db.batch()` cho mutation cần commit assertion và cho migration có TRIGGER / CHECK đa cột / partial index | Trung bình — ranh giới phải viết thành rule, nếu không sẽ trộn hai kiểu tuỳ hứng |
| D3 | Bố cục package | 3 package | `packages/core` | **`packages/core` + gate import-graph cho cả 2 app**. 6 bảng, single-tenant, deadline 1–2 tuần → chưa đáng tách | Thấp, với điều kiện có gate |
| D4 | `store_id` | Có ở mọi bảng | Không nhắc | **Giữ `store_id`** ngay từ migration đầu, giá trị hằng cho MVP | Thêm sau = migrate lại toàn bộ khoá và index |
| D5 | Xác thực webhook | API key tĩnh | Không nêu | **Mạnh hơn SOURCE**: HMAC-SHA256 trên raw body + cửa sổ timestamp + so sánh constant-time; giữ API key làm lớp phụ | Cao nếu copy y nguyên |
| D6 | Đối soát khi mất webhook | Không có | Không nêu | **Thêm mới**: cron đã có sẵn (`*/5`), thêm job poll trạng thái đơn `pending_payment` quá N phút | Cao — đây là lỗ hổng mất tiền của SOURCE |
| D7 | Real-time bếp | Polling 5s | "real-time" | **Polling 3s cho MVP**, ghi rõ trong PRD; SSE/Durable Object là phase sau | Thấp |
| D8 | Auth khách tại bàn | Capability token bearer + digest SHA-256 | `table_token` trong QR | **Theo SOURCE**: lưu digest, không lưu token thô, mọi thất bại trả 404 đồng nhất | Thấp |
| D9 | Trạng thái đơn | 4 trạng thái | 6 trạng thái | **Mở rộng**: `pending_payment → paid → preparing → fulfilled`, nhánh `cancelled`/`refunded`; giữ nguyên kỹ thuật guard `UPDATE ... WHERE status = <from>` + assertion cuối batch | Thấp |
| D10 | Cache ảnh R2 | `no-store` | Không nêu | **Đổi**: key ảnh là UUID mới mỗi lần upload nên bất biến → `public, max-age=31536000, immutable` + xử lý `If-None-Match` | Thấp, nhưng ảnh hưởng trực tiếp tốc độ tải menu trên 3G |
| D11 | Email | Resend + outbox + cron | Resend | **Theo SOURCE nguyên vẹn** | Thấp |
| D12 | Cổng CI | typecheck + test workerd + 2 build | Không nêu | **Theo SOURCE + thêm 1 e2e luồng tiền** (quét QR → đặt món → bếp thấy đơn) chặn merge | Thấp |

---

## 6. Điểm rủi ro

7 hạng mục critical (sai → mất tiền, lộ bí mật, hoặc >2 ngày làm lại) → **mức CAO**.

| ID | Rủi ro | Bằng chứng | Hành động |
| --- | --- | --- | --- |
| R1 | Webhook chỉ có API key tĩnh | `apps/worker/src/payfs-webhook-routes.ts:106-108` | D5 — bắt buộc HMAC + timestamp trước khi lên production |
| R2 | Không có reconciliation khi webhook rơi | `plans/260915-1512-payfs-bank-transfer-payment/plan.md:31` | D6 — cron đối soát |
| R3 | Secret plaintext trong repo mẫu | `payment-intergration-prd.md:16-20` | Không copy file; toàn bộ secret đi qua `wrangler secret put` |
| R4 | Bất nhất độ dài payment reference: matcher cần `NP[0-9a-f]{18}`, code sinh 18 hex, nhưng DEFAULT cột sinh 32 hex | `order-commands.ts:375` vs `order-write.ts:30` vs `migrations/0006-order-brief-contract.sql:35` | Nếu mượn sơ đồ reference: chốt một độ dài duy nhất và test đối soát |
| R5 | HMAC của link email tái dùng `RESEND_API_KEY` | `apps/worker/src/storefront-order-routes.ts:182,233` | Tách secret riêng; xoay key Resend không được làm hỏng link cũ |
| R6 | Typo binding `PAYFS_FEFAULT_ACCOUNT` (webhook) vs `PAYFS_MERCHANT_ACCOUNT` (storefront) | `payfs-webhook-routes.ts:10,22` vs `storefront-order-routes.ts:44` | QR và đối soát có thể trỏ hai tài khoản khác nhau mà hệ thống vẫn "chạy" — đặt tên biến một lần, dùng chung |
| R7 | Lệch stack Next.js/Drizzle so với toàn bộ pipeline tham chiếu | `docs/PRD.md:35-37` | D1 + D2 phải chốt trước khi viết dòng code đầu tiên |

Rủi ro không critical đáng ghi nhận: gate import-graph của SOURCE chỉ phủ Console chứ không phủ Storefront; `Cache-Control: no-store` cho ảnh; D1 không có transaction tương tác nên mọi thao tác nhiều bước bắt buộc dùng guarded batch (`plans/260915-1046-secure-owner-bootstrap-and-invites/phase-02-identityadmission.md:53`).

---

## 7. Thứ tự triển khai đề xuất

Không phải kế hoạch thực thi — là thứ tự phụ thuộc rút ra từ SOURCE.

1. **Chốt D1 + D2 + D3** (stack, ORM, bố cục package). Mọi thứ khác phụ thuộc vào đây.
2. Dựng workspace + wrangler + binding `DB`/`FILES`/`ASSETS` + `applyD1Migrations` trong test env. Chưa có logic nào, nhưng test harness phải chạy được — SOURCE chứng minh đây là thứ khiến 50 file test có D1 khả thi.
3. Migration nền: `categories`, `products`, `tables`, `orders`, `order_items` với cột tiền dạng INTEGER minor units + `store_id`.
4. `money` + pricing + snapshot (server-authoritative) + test tổng tiền và test snapshot. Đây là contract rẻ nhất để làm đúng và đắt nhất để sửa sau.
5. Idempotency đặt đơn + state machine `pending_payment → paid`, kèm test chuyển trạng thái trái phép.
6. better-auth + Google + membership Owner/Staff cho Console.
7. R2 upload ảnh món (Drizzle CRUD + raw-SQL commit assertion).
8. PayFS: QR + webhook (**kèm D5 HMAC ngay từ đầu**, đừng để sau) + provider event log + D6 reconciliation.
9. Refund request/approve, email outbox, e2e luồng tiền.

---

## 8. Bàn giao

Chế độ `--compare`: **không sinh kế hoạch thực thi**, đúng như mức rủi ro CAO yêu cầu.

Sản phẩm bàn giao:
- `docs/reference/nexus/00-index.md` — chỉ mục + kiến trúc tổng quan
- `docs/reference/nexus/01-monorepo-and-build.md` (424 dòng)
- `docs/reference/nexus/02-d1-data-layer-and-r2.md` (986 dòng)
- `docs/reference/nexus/03-better-auth-google-oauth.md` (1101 dòng)
- `docs/reference/nexus/04-payfs-webhook-and-business-contracts.md` (1802 dòng)
- `docs/reference/nexus/05-testing-and-dev-workflow.md` (456 dòng)
- Báo cáo này

Bước tiếp theo khi bạn đã chốt D1/D2/D3: chạy `/ak:plan` với báo cáo này + PRD làm đầu vào, rồi `/ak:cook` theo kế hoạch sinh ra.
