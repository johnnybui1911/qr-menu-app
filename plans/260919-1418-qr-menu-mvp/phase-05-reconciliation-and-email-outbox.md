---
title: "Phase 5: Đối soát & email outbox"
phase: 5
status: todo
priority: P1
effort: 6h
milestone: M2
dependencies: [4]
---

# Phase 5: Đối soát & email outbox

## Context

- [Decision Record](../../docs/decisions/260919-post-xia-decision-record.md) — D6, D12, D23, F12, F13, O7, O8
- [Scout 03 — PayFS & hợp đồng tiền](./reports/scout-03-payfs-and-money-contracts.md) — ngưỡng 2/15/30 phút, claim/backoff/retire, cạm bẫy lịch email của repo mẫu

## Goal

Webhook rơi thì tiền vẫn được ghi nhận: cron `*/1` đối soát đơn `pending_payment` bằng `GET /v1.1/transactions`, và cron `*/5` chạy đủ vòng đời email job enqueue → claim → gửi → retire với backoff mũ.

## Overview

Priority P1 · M2 · phụ thuộc phase 4. Không có đường ghi nhận tiền mới nào được viết ở đây: cron gọi **chính** `settleCredit` của phase 4.

Hết phase này, M2 xong: luồng tiền bền vững với webhook rơi, worker chết giữa chừng, và job email trùng.

## Key insights

- PayFS tự retry tới ~2.8 giờ (F13) — khách ngồi tại bàn không chờ được, và retry không cứu được trường hợp worker trả 200 rồi chết giữa chừng. Đó là lý do đối soát tồn tại dù đã có retry.
- Tiền về sau khi đơn đã `cancelled` → **không tự hồi sinh đơn** (D6). Ghi `provider_events` cờ `unmatched_payment` cho Owner xử lý tay. Tự chuyển trạng thái ngược từ `cancelled` là đường ngắn nhất tới ghi nhận tiền hai lần.
- Repo mẫu gửi email cho **khách** theo lịch 6 nhắc trong nhiều ngày. Bối cảnh ở đây ngược hoàn toàn: gửi cho **Owner**, đơn hết hạn trong 15–30 phút. Copy lịch đó là sai bối cảnh.
- `order_email_jobs.order_id` nullable (phase 2) vì báo cáo chốt ngày không gắn một đơn cụ thể.
- Claim job bằng conditional `UPDATE … WHERE delivered_at IS NULL AND attempts < N AND available_at <= now` rồi đọc `meta.changes` — hai worker cron chồng nhau thì chỉ một cái nhận được job.

## Quyết định thi công chốt tại phase này

| # | Vấn đề | Chốt |
|---|---|---|
| 1 | Shape response `/v1.1/transactions` không có tài liệu (câu hỏi mở của scout-03) | Parser phòng thủ: nhận `unknown`, chấp nhận mảng ở gốc **hoặc** dưới một trong `data`/`transactions`/`items`, lấy đúng 4 field cần (`transaction_id`, `amount`, `content`, `transfer_type`), bỏ qua phần tử thiếu field. Field lạ → bỏ qua, không throw. Có test trên 4 shape giả. Xác nhận shape thật ở phase 10 khi có tài khoản (O7); nếu lệch, chỉ một hàm parser phải sửa |
| 2 | Gọi API khi chưa có token (M2 chưa có tài khoản PayFS) | `PAYFS_API_TOKEN` rỗng → cron **bỏ qua bước gọi API**, vẫn chạy đủ nhánh 15/30 phút, ghi log một dòng `reconcile_skipped_no_token`. Không throw, không spam |
| 3 | Lịch email của MVP | Ba `kind` (CHECK đã có ở 0002 — phase 2): `refund_confirmed` (phase 7 enqueue khi Owner duyệt), `invitation` (phase 6 enqueue khi Owner mời), `daily_revenue_report` (cron `*/5` enqueue khi bước sang giờ chốt ngày). Giờ chốt ngày là **hằng** `DAILY_REPORT_HOUR_ICT = 23` trong `scheduled.ts`, múi giờ `Asia/Ho_Chi_Minh` — không thêm biến môi trường ngoài C11; O8 chốt giờ khác thì sửa hằng. **Không** email khi đơn `paid`, không email cho khách (PRD §3 chỉ hứa email cho Owner) |
| 4 | Gửi thật hay không ở phase này | Code gửi hoàn chỉnh, gọi Resend thật với `Idempotency-Key: job.id`. Ở M2 dùng địa chỉ test của Resend (chỉ gửi tới email chủ tài khoản) nên vòng đời job được kiểm thật; bật domain đã verify là việc phase 10 (chỉ đổi biến môi trường — D23) |

## Requirements

- [x] `apps/worker/src/scheduled.ts` phân nhánh bằng `controller.cron`: `*/1` → đối soát; `*/5` → email outbox. Pattern lạ → throw (không im lặng bỏ job)
- [x] Thứ tự **trong một lần chạy** cron `*/1`: (1) gọi API + khớp + settle cho mọi đơn >2 phút · (2) gắn `needs_attention` cho đơn >15 phút · (3) `cancelled` cho đơn >30 phút. Huỷ **sau cùng**: tiền về ở phút 29 phải được cứu trong cùng lần chạy chứ không bị huỷ trước rồi mới khớp
- [x] Khớp được → gọi **`settleCredit`** của phase 4 (cùng batch, cùng idempotency, cùng `fingerprintFacts`), không viết đường ghi nhận tiền thứ hai
- [x] Tiền về cho đơn đã `cancelled` → `provider_events` row `outcome='unmatched_payment'`, đơn **không** đổi trạng thái
- [x] `order_email_jobs`: claim conditional UPDATE (`attempts+1`, `available_at = now + backoff`), backoff `min(1h, 5m × 2^(attempts-1))`, retire khi `attempts >= 8`, gửi Resend kèm `Idempotency-Key: job.id`
- [ ] Secret HMAC của link trong email là biến **riêng** `EMAIL_LINK_HMAC_SECRET`, không dùng `RESEND_API_KEY` (R5, C11)
- [x] Cron `*/1` và `*/5` không bao giờ chạy chồng job của nhau

## Architecture

```
scheduled(controller, env)
├── "*/1 * * * *" → reconcilePendingOrders(db, env)
│     SELECT id, payment_reference, total_amount_minor, created_at, table_id
│       FROM orders WHERE store_id=? AND status='pending_payment'
│     ├─ bước 1 · age >  2m → queryPayfsTransactions(env) → parseTransactions(unknown)
│     │        → matchPaymentReference(content) + amount khớp tuyệt đối
│     │        → settleCredit(..., {source:'reconciliation'})   ← CHÍNH hàm của phase 4
│     ├─ bước 2 · age > 15m → UPDATE … SET needs_attention=1 WHERE needs_attention=0
│     └─ bước 3 · age > 30m → db.batch([UPDATE … SET status='cancelled'
│                              WHERE status='pending_payment', assertion])
│              (bàn tự do: không có khoá bàn ở schema)
└── "*/5 * * * *" → runEmailOutbox(db, env)
      ├─ nếu giờ hiện tại (ICT) == DAILY_REPORT_HOUR_ICT:
      │     → INSERT order_email_jobs(kind='daily_revenue_report', order_id=NULL,
      │        dedupe_key='daily:<YYYY-MM-DD>')  — đụng UNIQUE thì bỏ qua, KHÔNG SELECT trước
      ├─ claim: UPDATE … SET attempts=attempts+1, available_at=? 
      │          WHERE id=? AND delivered_at IS NULL AND attempts<8 AND available_at<=?
      │          → meta.changes===1 mới được gửi
      ├─ gửi Resend (Idempotency-Key: job.id)
      │     thành công → UPDATE … SET delivered_at=?, status='sent'
      │     lỗi        → last_error, available_at đã đẩy sẵn lúc claim
      └─ attempts>=8 → status='retired' (không gửi nữa, hiện lên Console phase 7)
```

Đơn `cancelled` không cần "giải phóng bàn" bằng thao tác ghi riêng: bàn không bị khoá ở schema, trạng thái đơn là nguồn sự thật duy nhất. Ghi chú này để không ai thêm cột `tables.locked_by_order` về sau.

## Files to create / modify

- Create: `apps/worker/src/scheduled.ts`
- Create: `apps/worker/src/payfs/query-transactions.ts` — `queryPayfsTransactions`, `parseTransactions`
- Create: `apps/worker/src/payfs/reconcile-pending-orders.ts`
- Create: `apps/worker/src/order-email-service.ts` — gọi Resend, dựng nội dung
- Modify (append-only): `packages/orders/src/email-outbox.ts` — phase 2 sở hữu file; phase này **chỉ thêm** `claimDueJobs`, `completeJob`, `retireJob`, `nextAvailableAt`. `completeJob`/`retireJob` **null hoá `payload_json`** để token lời mời không nằm lại trong DB sau khi gửi (xem phase 6 quyết định #9)
- Create: `packages/orders/src/revenue-report.ts` — tổng hợp doanh thu theo ngày (SQL thuần)
- Modify: `apps/worker/src/index.ts` — export `scheduled`
- Modify: `packages/orders/src/commands/payment-settlement.ts` — cho phép `settleCredit` nhận nguồn `'webhook' | 'reconciliation'` (chỉ để ghi `provider_events.source`, không đổi logic)

## Tests Before (viết trước, phải đỏ)

| # | Test | Assert | Dữ liệu vào |
|---|---|---|---|
| T1 | `tests/unit/payfs-transactions.test.ts :: parser chịu 4 shape` | Mảng ở gốc / dưới `data` / `transactions` / `items` đều parse ra cùng danh sách; phần tử thiếu field bị bỏ qua; field lạ không gây throw | 4 JSON giả |
| T2 | `tests/unit/payfs-transactions.test.ts :: parser từ chối rác` | `null`, `{}`, `"text"`, mảng số → trả `[]`, không throw | 4 case |
| T3 | `tests/unit/email-backoff.test.ts :: backoff mũ có trần` | `attempts` 1..10 → `5m,10m,20m,40m,1h,1h,1h,…` (trần 1h) | 10 case |
| T4 | `tests/integration/reconcile.test.ts :: đơn 3 phút được cứu` | Đơn `pending_payment` 3 phút, API trả giao dịch khớp mã + amount → đơn `paid`, `provider_payments` +1, `provider_events` +1 row `outcome='paid'`, `source='reconciliation'`; **không** job email mới | API stub |
| T5 | `tests/integration/reconcile.test.ts :: dùng chung settleCredit` | Sau khi cron cứu đơn, gửi webhook **cùng** `transaction_id` → `already_processed`, không ghi nhận lần hai | cron rồi webhook |
| T6 | `tests/integration/reconcile.test.ts :: đơn 16 phút gắn cờ` | Đơn 16 phút không có giao dịch khớp → `needs_attention=1`, vẫn `pending_payment` | API trả rỗng |
| T7 | `tests/integration/reconcile.test.ts :: đơn 31 phút bị huỷ` | Đơn 31 phút → `cancelled`; chạy cron lần hai → không đổi gì thêm (idempotent) | 2 lần cron |
| T7b | `tests/integration/reconcile.test.ts :: tiền về ở phút 31 vẫn được cứu trong cùng lần chạy` | Đơn 31 phút **và** API trả giao dịch khớp trong cùng lần chạy → đơn `paid`, **không** `cancelled` (bước settle chạy trước bước huỷ) | 1 lần cron |
| T8 | `tests/integration/reconcile.test.ts :: không hồi sinh đơn đã huỷ` | Đơn `cancelled`, API trả giao dịch khớp mã + amount → đơn **vẫn** `cancelled`, `provider_events.outcome='unmatched_payment'`, `provider_payments` rỗng | 1 giao dịch |
| T9 | `tests/integration/reconcile.test.ts :: amount lệch không cứu đơn` | Giao dịch khớp mã, amount lệch → không `paid`, ghi `provider_events` + `needs_attention` | 1 giao dịch |
| T10 | `tests/integration/reconcile.test.ts :: thiếu PAYFS_API_TOKEN thì bỏ qua gọi API` | Token rỗng → không gọi fetch (stub đếm 0 lần), nhánh 15/30 phút **vẫn** chạy | env rỗng |
| T11 | `tests/integration/email-outbox.test.ts :: claim chỉ một worker thắng` | Hai lần claim liên tiếp cùng job → đúng một lần `meta.changes === 1` | 1 job |
| T12 | `tests/integration/email-outbox.test.ts :: gửi lỗi thì thử lại sau backoff` | Resend stub trả 500 → job còn `pending`, `attempts=1`, `available_at` đã đẩy ≥5 phút; chạy cron ngay lập tức → không claim lại | 2 lần cron |
| T13 | `tests/integration/email-outbox.test.ts :: retire sau 8 lần` | `attempts=8` → `status='retired'`, không gọi Resend nữa | 1 job |
| T14 | `tests/integration/email-outbox.test.ts :: Idempotency-Key là job.id` | Resend stub nhận header `Idempotency-Key` = `job.id` ở **mọi** lần thử lại | 2 lần gửi |
| T15 | `tests/integration/email-outbox.test.ts :: báo cáo ngày enqueue đúng một lần` | Chạy cron 3 lần trong cùng giờ chốt ngày → đúng 1 job `daily_revenue_report` (INSERT thứ hai đụng `UNIQUE(store_id, dedupe_key)` và bị bỏ qua, không throw); sang ngày sau → job thứ hai | 4 lần cron |
| T16 | `tests/integration/revenue-report.test.ts :: chỉ tính đơn đã thu tiền` | Doanh thu ngày = Σ `total_amount_minor` của đơn `paid`/`preparing`/`fulfilled`; đơn `pending_payment`/`cancelled` không tính; `refunded` bị trừ ra | 6 đơn seed |
| T17 | `tests/integration/scheduled.test.ts :: phân nhánh cron` | `*/1` chỉ chạy đối soát (email job không bị chạm); `*/5` chỉ chạy outbox; pattern lạ → throw | 3 lần gọi |
| T18 | `tests/node/email-secret.test.ts :: secret link là biến riêng` | Grep source: không chỗ nào dùng `RESEND_API_KEY` để HMAC; link email chỉ ký bằng `EMAIL_LINK_HMAC_SECRET` | cây source |

## Refactor / triển khai dưới lưới test

1. `query-transactions.ts`: `queryPayfsTransactions(env, {since})` gọi `GET ${env.PAYFS_API_BASE}/v1.1/transactions` với `Authorization: Bearer ${env.PAYFS_API_TOKEN}` — base URL đọc từ `vars` (`PAYFS_API_BASE`, mặc định nạp lúc deploy), **không** literal trong source (T6 phase 1) và nhờ vậy test stub được server; timeout 10s, lỗi mạng → trả `[]` và log; `parseTransactions(unknown): PayfsTransaction[]` theo quyết định #1. Ghi chú `// shape xác nhận ở phase 10 (O7)` ngay tại parser, không rải TODO khắp nơi.
2. `reconcile-pending-orders.ts`: một truy vấn lấy đơn `pending_payment` kèm tuổi tính bằng SQL; phân nhánh 2/15/30 phút; nhánh huỷ dùng `db.batch` có assertion (`status='cancelled'`), nhánh cờ dùng `UPDATE … WHERE needs_attention=0` để idempotent; nhánh khớp gọi `settleCredit(..., source:'reconciliation')`.
3. `email-outbox.ts`: thêm `claimDueJobs(db, now, limit)`, `completeJob`, `retireJob` vào module phase 2 đã tạo; backoff là hàm thuần `nextAvailableAt(attempts, now)`. `enqueueEmailJobStatement` giữ nguyên chữ ký của phase 2 (caller nhét vào batch của mình — D23).
4. `revenue-report.ts`: `summarizeDailyRevenue(db, storeId, dateIct)` — một câu SQL `GROUP BY` trên khoảng thời gian đã chuyển về UTC, trả tổng + số đơn + số refund. Phase 7 dùng lại cho route `GET /api/console/revenue`.
5. `order-email-service.ts`: dựng subject/body cho **ba** `kind` (đọc token lời mời từ `payload_json` của job, dựng link `#invite=` rồi để `completeJob` xoá payload) (`daily_revenue_report`, `refund_confirmed`, `invitation` — template mời thuộc phase này để phase 6 chỉ cần enqueue); link trong email ký HMAC bằng `EMAIL_LINK_HMAC_SECRET`; gọi Resend `POST ${env.RESEND_API_BASE}/emails` với `Idempotency-Key: job.id` (base URL từ `vars`, cùng lý do như `PAYFS_API_BASE`); `RESEND_FROM_ADDRESS` từ env (ở M2 là địa chỉ test); thiếu `RESEND_FROM_ADDRESS`/`OWNER_REPORT_EMAIL` → log `email_not_configured`, **không** gửi và **không** retire (giữ job lại).
6. `scheduled.ts`: `switch (controller.cron)` hai nhánh, `default: throw new Error('unknown_cron')`; mỗi nhánh bọc `try/catch` ghi log có `incidentId` nhưng **không** nuốt lỗi cron (throw lại sau khi log để Cloudflare ghi nhận thất bại).
7. `index.ts`: export `scheduled` từ module trên.

## Tests After

| # | Test | Assert |
|---|---|---|
| A1 | `tests/integration/reconcile.test.ts :: đối soát không đụng đơn ngoài pending_payment` | Đơn `paid`/`preparing`/`fulfilled`/`refunded` không bị cron chạm (so snapshot toàn bảng trước/sau) |
| A2 | `tests/integration/email-outbox.test.ts :: job không gắn đơn chạy được` | `daily_revenue_report` với `order_id = NULL` gửi và `delivered_at` được set |
| A3 | `tests/integration/reconcile.test.ts :: 200 đơn pending không vượt ngân sách subrequest` | Cron xử lý 200 đơn trong một lần chạy: số lần gọi API ≤ 1 (gọi theo lô, không mỗi đơn một request), tổng thời gian < 10s |

## Todo

- [ ] T1–T18 (gồm T7b) viết trước và đỏ
- [x] `query-transactions.ts` (parser trước, fetch sau)
- [x] `email-outbox.ts` + `nextAvailableAt`
- [x] `revenue-report.ts`
- [x] `reconcile-pending-orders.ts`
- [x] `order-email-service.ts`
- [x] `scheduled.ts` + export trong `index.ts`
- [x] A1–A3 xanh

## Regression gate

```bash
npm run typecheck && npm test
```

## Success criteria

- [x] T1–T18 (gồm T7b), A1–A3 xanh
- [x] Không có hàm nào khác `settleCredit` ghi `provider_payments` (grep)
- [x] Đơn `cancelled` không bao giờ quay lại `paid` bằng đường tự động
- [ ] Email job chạy đủ vòng enqueue → claim → gửi → retire với Resend ở chế độ test
- [x] Cron `*/1` gọi API tối đa một lần mỗi lần chạy (A3)

## Risks

| Rủi ro | Mitigation |
|---|---|
| Shape `/v1.1/transactions` khác dự đoán (O7 chưa đóng) | Parser phòng thủ + 4 shape test; chỉ **một** hàm phải sửa khi biết shape thật; phase 10 xác nhận bằng smoke test tiền thật |
| Ngưỡng 30 phút huỷ oan đơn khách vừa chuyển tiền chậm | Nhánh huỷ chỉ chạy sau khi nhánh đối soát đã gọi API ở cùng lần chạy; tiền về sau khi huỷ vẫn được ghi `unmatched_payment` để Owner xử lý tay (D6) |
| Cron chạy chồng nhau (Cloudflare gọi lại khi lần trước chưa xong) | Claim bằng conditional UPDATE (T11); đối soát dùng `UPDATE … WHERE <điều kiện hiện tại>` nên chạy hai lần không đổi kết quả (T7) |
| Resend ở chế độ test làm ta tưởng email hoạt động | Phase 10 có acceptance riêng: gửi thật tới hộp thư Owner sau khi verify domain (O8) |

## Security

- Ba secret PayFS ba tên, thêm `RESEND_API_KEY` và `EMAIL_LINK_HMAC_SECRET` **riêng biệt** (C11, R5).
- Link trong email ký HMAC riêng → xoay `RESEND_API_KEY` không làm chết link cũ.
- Báo cáo doanh thu chỉ gửi tới địa chỉ Owner cấu hình bằng env, không nhận địa chỉ từ request.

## Ghi chú thi công (2026-09-26)

Theo tư vấn kongming (checkpoint sau phase 4):

- Cron **duyệt giao dịch, không duyệt đơn**: mọi giao dịch parse được đi thẳng vào `settleCredit` (`source='reconciliation'`, `raw_payload` = JSON của đúng giao dịch đó), không lọc trước theo mã — lọc trước là bản sao thứ hai của logic khớp D18. Giao dịch không liên quan bị ghi `unmatched` **một lần** như webhook vẫn làm, các lần sau là `already_processed`.
- `settleCredit` trả `retry` (đơn đổi trạng thái giữa lúc đọc và batch, chưa commit gì) → cron gọi lại **một lần** ngay: webhook có PayFS retry hộ, cron thì không, và đơn đã `cancelled` sẽ rời khỏi mọi lần quét sau. Race hủy-vs-settle không dựng lại được trong một batch D1 nên chưa có test riêng; logic retry là hai dòng.
- Chỉ gọi API khi có đơn `pending_payment` > 2 phút **hoặc** đơn `cancelled` tạo trong 3 giờ gần nhất (cửa sổ tiền về muộn, bằng horizon retry ~2.8 giờ của PayFS — F13). Không gửi tham số lọc thời gian: tên tham số chưa xác nhận (O7). Ngưỡng 2/15/30 phút + cửa sổ 3 giờ nằm ở `packages/orders/src/commands/pending-order-expiry.ts` (quy tắc nghiệp vụ không ở worker); gắn cờ và huỷ là **một** conditional UPDATE mỗi bước, không cần assertion batch.
- Outbox: claim = `UPDATE … RETURNING` có điều kiện `attempts = <đã đọc>` và đẩy `available_at` **trước** khi gửi; `completeJob`/`failJob`/`retireExhaustedJobs` null hoá `payload_json` trong **cùng** câu UPDATE với đổi trạng thái; lần thử thứ 8 thất bại → `retired`. Thiếu `RESEND_API_KEY`/`RESEND_FROM_ADDRESS`/`OWNER_REPORT_EMAIL` → không claim job nào (job giữ nguyên `attempts`), báo cáo ngày vẫn được enqueue.
- Báo cáo ngày: `summarizeDailyRevenue` trả `{date, paidOrderCount, revenueMinor, refundedOrderCount, refundedMinor}` theo ngày ICT của `created_at`; doanh thu = đơn `paid`/`preparing`/`fulfilled`, đơn `refunded` báo riêng (không tính vào doanh thu).
- `EMAIL_LINK_HMAC_SECRET` (mục Requirements còn mở): **không** email nào có link cần ký — link Console đã có auth, link mời mang token riêng trong fragment. Không thêm chữ ký thừa; T18 thành cổng "`RESEND_API_KEY` chỉ được đọc ở `order-email-service.ts`". Tên biến vẫn giữ trong C11 cho khi cần.
- Mục "T1–T18 viết trước và đỏ" còn mở: test outbox/báo cáo/parser đã chạy đỏ; test đối soát được viết trước module nhưng không chạy đỏ — bù bằng mutation (huỷ trước settle → T7b đỏ; bỏ cửa sổ tiền về muộn → T8 đỏ; claim không đẩy `available_at` → T11/T12 đỏ).
- Mục "Resend ở chế độ test" còn mở: cần `RESEND_API_KEY` thật. Đã kiểm vòng đời bằng stub cùng hợp đồng HTTP.
- Bằng chứng chạy thật: `wrangler dev --test-scheduled` với `PAYFS_API_BASE`/`RESEND_API_BASE` trỏ vào stub cục bộ; `/cdn-cgi/handler/scheduled?cron=*/1…` → đơn 31 phút có tiền thành `paid` (không bị huỷ), đơn 16 phút gắn cờ, đơn 45 phút `cancelled`, chạy lại không đổi gì; `*/5` → job `sent`, `payload_json` NULL, Resend nhận `Idempotency-Key: job-1`; cron lạ → 500. Mỗi lần `*/1` gọi API đúng một lần.

## Next

M2 xong. Nhánh quản trị (phase 6 → 8) có thể đã chạy song song từ sau phase 2; phase 7 cần cả phase 4 (state machine) và phase 6 (auth).
