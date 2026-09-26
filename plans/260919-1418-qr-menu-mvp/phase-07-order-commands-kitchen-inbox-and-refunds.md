---
title: "Phase 7: Lệnh Console, kitchen inbox & refund"
phase: 7
status: completed
priority: P1
effort: 8h
milestone: M3
dependencies: [4, 5, 6]
---

# Phase 7: Lệnh Console, kitchen inbox & refund

## Context

- [Decision Record](../../docs/decisions/260919-post-xia-decision-record.md) — D7, D9, D10 (tầng lệnh Console), D12, D15, O4
- [Scout 03 — hợp đồng tiền](./reports/scout-03-payfs-and-money-contracts.md) — idempotency tầng lệnh, assertion cuối batch, cạm bẫy `refunded`
- [Scout 04 — RBAC](./reports/scout-04-identity-auth-and-rbac.md) — `evaluatePermission`, context request
- [PRD §2.2, §2.3.4](../../docs/PRD.md)

## Goal

Bếp thấy đơn mới trong ≤3 giây và đẩy được `paid → preparing → fulfilled`; nhân viên xin hoàn tiền, Owner duyệt — mọi lệnh idempotent, sai trạng thái trả 409 và **không** để lại side effect.

## Overview

Priority P1 · M3 · phụ thuộc phase 4 (state machine, `needs_attention`) và phase 6 (session + RBAC). Đây là phase khép luồng vận hành tại quán.

`refunded` chỉ là trạng thái **ghi nhận** (O4): PayFS không có endpoint chi tiền, Owner chuyển khoản tay rồi bấm duyệt. Không có side effect chuyển tiền nào trong code.

## Key insights

- Repo mẫu **không** có transition nào đổi `orders.status` sang `refunded` (nó chỉ đổi `order_refund_requests.status`). Phải viết mới `UPDATE orders SET status='refunded' WHERE status IN ('paid','preparing','fulfilled')` cùng assertion tương ứng.
- Polling 3 giây (D7) là quyết định, nhưng chi phí read D1 là thật: endpoint bếp phải trả theo cursor `since` + `ETag`, không trả lại toàn bộ danh sách mỗi lần.
- Idempotency tầng lệnh Console: `UNIQUE(store_id, request_key)` + `payload_hash`. Khớp hash → replay **kết quả cũ** (không chạy lại transition); lệch → 409. Đây là tầng khác với tầng khách (phase 3) và tầng provider (phase 4) — ba bảng, ba cơ chế.
- Trigger `refund_requests_terminal_immutable` (phase 2) đã chặn sửa quyết định refund ở tầng DB — code không cần tin vào chính nó.
- Staff xin refund, Owner duyệt. `refund:decide` chỉ có trong tập action của Owner (phase 6) — test phân quyền ở đây kiểm qua HTTP, không chỉ kiểm hàm thuần.

## Quyết định thi công chốt tại phase này

| # | Vấn đề | Chốt |
|---|---|---|
| 1 | Kitchen inbox trả gì | `GET /api/console/orders?since=<updated_at>,<id>&status=…` — **keyset hai cột**: `WHERE (updated_at, id) > (?, ?)` `ORDER BY updated_at, id`; cursor mang **cả hai** giá trị, nếu chỉ mang `updated_at` thì hai đơn cùng mốc sẽ bị bỏ sót hoặc trả lặp. `ETag` = hash của cursor cuối + số lượng; client gửi `If-None-Match` → `304` khi không có gì mới |
| 2 | `refunded` có trừ doanh thu không | Có: `revenue-report` của phase 5 trừ đơn `refunded` ra khỏi tổng. Không tạo bảng sổ kế toán riêng ở MVP |
| 3 | Duyệt refund làm gì với đơn đang `preparing` | Vẫn cho `refunded` (D9 cho phép từ `paid`/`preparing`/`fulfilled`). Món đang làm là việc của con người, không phải của state machine |
| 4 | `needs_attention` và khoản tiền không khớp đơn hiện ở đâu | Badge trên danh sách đơn + `GET /api/console/provider-events` với `orderId` **tuỳ chọn** và cờ `unmatched=1` (lọc `order_id IS NULL`). Chỉ Owner (`report:read`). Lý do (red-team): tiền về mà `content` bị ngân hàng cắt/sai mã thì row `provider_events` **không có** `order_id` — nếu endpoint bắt buộc `orderId` thì khoản tiền đó vô hình trên Console và đơn tương ứng vẫn bị huỷ ở phút 30 |
| 5 | Báo cáo doanh thu lộ ra đâu (red-team) | Route `GET /api/console/revenue?date=YYYY-MM-DD` (quyền `report:read`) gọi `summarizeDailyRevenue` của phase 5. PRD §2.3.4 hứa Owner xem được báo cáo; phase 5 có SQL, phase 9 có UI, nhưng trước red-team **không phase nào** tạo route — nên nó nằm ở đây cùng các route Console khác |

## Requirements

- [x] `GET /api/console/orders` — cursor `since` + `ETag`/`304`, phân loại theo bàn và trạng thái; quyền `order:read`
- [x] `POST /api/console/orders/:id/prepare` — `paid → preparing`; quyền `order:prepare`
- [x] `POST /api/console/orders/:id/fulfill` — `preparing → fulfilled`; quyền `order:fulfill`
- [x] `POST /api/console/orders/:id/refund-requests` — staff tạo yêu cầu kèm `reason`; quyền `refund:request`
- [x] `POST /api/console/refund-requests/:id/decide` — Owner `approve`/`reject`; quyền `refund:decide`; `approve` → `orders.status='refunded'` + `enqueueEmailJobStatement(kind='refund_confirmed', dedupe_key='refund:<order_id>')` trong **cùng** batch
- [x] `GET /api/console/provider-events?orderId=&unmatched=` — Owner đọc sự kiện provider; `orderId` tuỳ chọn; `unmatched=1` trả row `order_id IS NULL`; quyền `report:read`
- [x] `GET /api/console/revenue?date=` — Owner đọc doanh thu ngày (gọi `summarizeDailyRevenue` phase 5); quyền `report:read`
- [x] Mọi lệnh POST yêu cầu header `Idempotency-Key`; ledger `order_commands` (`request_key` + `payload_hash` + `result_json`)
- [x] Mọi transition dùng `UPDATE … WHERE status = <from>` + assertion cuối `db.batch()`; 0 row → 409 **không** side effect
- [x] Mọi route đi qua `resolveConsoleRequestContext` + `evaluatePermission`, cookie forward trên cả nhánh lỗi (phase 6)

## Architecture

```
POST /api/console/orders/:id/prepare
  ├─ isKnownConsoleRequest → consoleOriginAllowed → session → resolveActiveMembership
  ├─ evaluatePermission(ctx, 'order:prepare', {storeId})           → 403
  ├─ requireIdempotencyKey(header)                                  → 400
  ├─ payloadHash = sha256(action + orderId + actorUserId + body)
  └─ db.batch([
       INSERT order_commands (request_key, payload_hash, action, order_id, result_json),
       UPDATE orders SET status='preparing', updated_at=?
         WHERE store_id=? AND id=? AND status='paid',
       assertion: CASE WHEN (SELECT status FROM orders WHERE id=?)='preparing'
                       AND EXISTS(SELECT 1 FROM order_commands WHERE request_key=?)
                  THEN <id> ELSE NULL END
     ])
     ├─ UNIQUE(store_id, request_key) vỡ → đọc ledger:
     │     payload_hash khớp → trả result_json cũ (200 replay)
     │     lệch                → 409 idempotency_conflict
     └─ assertion vỡ / 0 row  → 409 invalid_transition (không row nào bị ghi)

POST /api/console/refund-requests/:id/decide  (approve)
  └─ db.batch([
       INSERT order_commands …,
       UPDATE refund_requests SET status='approved', decided_at=?, decided_by_user_id=?
         WHERE store_id=? AND id=? AND status='pending',
       UPDATE orders SET status='refunded', updated_at=?
         WHERE store_id=? AND id=? AND status IN ('paid','preparing','fulfilled'),
       INSERT order_email_jobs (kind='refund_confirmed', order_id=?),
       assertion: refund đã approved AND order đã refunded AND job tồn tại
     ])
```

## Files to create / modify

- Create: `packages/orders/src/commands/order-commands.ts` — `prepareOrder`, `fulfillOrder` (dùng guard của phase 4)
- Create: `packages/orders/src/refunds.ts` — `requestRefund`, `decideRefund` (sở hữu SQL `refund_requests`)
- Create: `packages/orders/src/command-ledger.ts` — sở hữu SQL `order_commands`, `payloadHash`, replay/conflict
- Create: `packages/orders/src/kitchen-inbox.ts` — `readOrdersSince(db, storeId, cursor, filter)`
- Create: `apps/worker/src/console-order-routes.ts`, `apps/worker/src/console-refund-routes.ts`, `apps/worker/src/console-provider-event-routes.ts`, `apps/worker/src/console-report-routes.ts`
- Modify: `apps/worker/src/console-route-match.ts` — thêm 7 route vào allowlist (**file dùng chung với phase 8**: chỉ thêm dòng, không sửa dòng của người khác)
- Modify: `apps/worker/src/index.ts` — mount

## Tests Before (viết trước, phải đỏ)

| # | Test | Assert | Dữ liệu vào |
|---|---|---|---|
| T1 | `tests/unit/command-ledger.test.ts :: payloadHash ổn định và phân biệt` | Cùng action+order+actor+body → cùng hash; đổi một field → hash khác; thứ tự khóa JSON không ảnh hưởng | 4 case |
| T2 | `tests/integration/console-orders.test.ts :: paid → preparing` | Đơn `paid` + quyền đủ → 200, `status='preparing'`, `order_commands` +1 row | 1 đơn |
| T3 | `tests/integration/console-orders.test.ts :: replay cùng key + payload` | Gọi hai lần cùng `Idempotency-Key` → lần hai trả **cùng** body (từ `result_json`), `updated_at` của đơn không đổi lần hai | 2 request |
| T4 | `tests/integration/console-orders.test.ts :: key trùng payload khác → 409` | Cùng key, `orderId` khác → 409, không transition nào xảy ra | 2 request |
| T5 | `tests/integration/console-orders.test.ts :: transition sai → 409 không side effect` | Đơn `pending_payment` gọi `fulfill` → 409; kiểm `orders`, `order_commands`, `order_email_jobs`, `provider_events` **không** thay đổi (so snapshot) | 1 request |
| T6 | `tests/integration/console-orders.test.ts :: thiếu Idempotency-Key → 400` | POST không header → 400, không ghi gì | 1 request |
| T7 | `tests/integration/console-orders.test.ts :: staff prepare được` | Session staff (dùng `tests/support/console-session.ts` của phase 6): `prepare` → 200, `fulfill` → 200. Kiểm "staff không sửa menu" thuộc phase 8 T5 (route đó do phase 8 tạo) | 2 request |
| T8 | `tests/integration/console-orders.test.ts :: staff không duyệt refund` | Session staff gọi `decide` → 403, `refund_requests` không đổi | 1 request |
| T9 | `tests/integration/kitchen-inbox.test.ts :: cursor since chỉ trả đơn mới` | Gọi lần 1 lấy cursor; tạo 1 đơn `paid` mới; gọi lần 2 với `since` → chỉ trả đơn mới | 3 đơn |
| T10 | `tests/integration/kitchen-inbox.test.ts :: ETag trả 304 khi không có gì mới` | Gọi lại với `If-None-Match` của lần trước → 304, body rỗng | 2 request |
| T11 | `tests/integration/kitchen-inbox.test.ts :: keyset hai cột không bỏ sót` | Ba đơn cùng `updated_at` với `limit=2`: trang 1 trả 2 đơn, cursor `(updated_at, id)` của đơn thứ hai; trang 2 trả **đúng** đơn thứ ba, không lặp, không mất | 3 đơn |
| T12 | `tests/integration/refunds.test.ts :: staff xin refund` | `POST refund-requests` với `reason` → 201, `status='pending'`, `requested_by_staff_id` = staff | 1 request |
| T13 | `tests/integration/refunds.test.ts :: một đơn một yêu cầu` | Yêu cầu thứ hai cho cùng đơn → 409 (vi phạm `UNIQUE(store_id, order_id)`), không row thứ hai | 2 request |
| T14 | `tests/integration/refunds.test.ts :: Owner approve → đơn refunded + email job` | `approve` → `refund_requests.status='approved'`, `orders.status='refunded'`, đúng 1 job `kind='refund_confirmed'`, tất cả trong một batch | 1 request |
| T15 | `tests/integration/refunds.test.ts :: reject không đổi trạng thái đơn` | `reject` → refund `rejected`, `orders.status` **không** đổi, không email job | 1 request |
| T16 | `tests/integration/refunds.test.ts :: quyết định là cuối cùng` | Gọi `decide` lần hai trên refund đã `approved` → 409 (trigger DB chặn), không side effect | 1 request |
| T17 | `tests/integration/refunds.test.ts :: refund từ pending_payment bị chặn` | Đơn chưa `paid` → không tạo được yêu cầu refund (400/409), vì chưa có tiền để hoàn | 1 request |
| T18 | `tests/integration/refunds.test.ts :: approve khi đơn đang preparing vẫn được` | Đơn `preparing` → `refunded` thành công (D9) | 1 request |
| T19 | `tests/integration/console-provider-events.test.ts :: chỉ Owner đọc được` | Staff → 403; Owner → 200 với các row của đúng đơn đó, gồm `outcome` | 2 request |
| T20 | `tests/integration/console-orders.test.ts :: needs_attention hiện trong danh sách` | Đơn có `needs_attention=1` → field xuất hiện trong response để UI hiện badge | 1 đơn |
| T21 | `tests/integration/console-provider-events.test.ts :: đọc được khoản tiền không khớp đơn` | Row `provider_events` có `order_id IS NULL, outcome='unmatched'` → `GET …?unmatched=1` trả về nó; `GET …?orderId=<id>` không trả nó; staff → 403 | 3 request |
| T22 | `tests/integration/console-report.test.ts :: doanh thu ngày` | Owner `GET /api/console/revenue?date=` → tổng + số đơn + số refund khớp `summarizeDailyRevenue`; staff → 403; `date` sai định dạng → 400 | 3 request |

## Refactor / triển khai dưới lưới test

1. `command-ledger.ts`: `payloadHash(action, orderId, actorUserId, body)` = SHA-256 trên JSON canonical (dùng `sortKeysRecursive`… **không** — module đó thuộc `apps/worker/src/payfs`; `packages/orders` có bản riêng `canonicalJson` trong `command-ledger.ts` để không phụ thuộc app). `insertCommandStatement()` trả statement cho caller nhét vào batch; `recoverCommandConflict()` đọc ledger và quyết định replay/409.
2. `order-commands.ts`: `prepareOrder`, `fulfillOrder` — mỗi hàm kiểm guard thuần của phase 4 **trước** khi dựng batch (để trả 409 sớm, rẻ), rồi vẫn dựa vào `WHERE status = <from>` + assertion để chống race.
3. `refunds.ts`: `requestRefund` (chỉ khi `orders.status IN ('paid','preparing','fulfilled')`), `decideRefund` (approve → UPDATE refund + UPDATE order + `enqueueEmailJobStatement` (phase 2) + assertion, tất cả trong một batch; reject → 1 UPDATE + assertion).
4. `kitchen-inbox.ts`: `readOrdersSince(db, storeId, {cursor: {updatedAt, id}, statuses, limit})` — một câu SQL keyset `WHERE store_id = ? AND (updated_at > ? OR (updated_at = ? AND id > ?))` theo `orders_kitchen_idx` `(store_id, updated_at, id)`, `ORDER BY updated_at, id`, `limit` mặc định 100; trả `{orders, cursor: {updatedAt, id}, etag}`.
5. Bốn file route: parse + gọi domain + map lỗi; `403` khi `evaluatePermission` false; mọi response đi qua `withConsoleAuthHeaders`. `console-report-routes.ts` chỉ gọi `summarizeDailyRevenue`, không tự viết SQL doanh thu.
6. Thêm 7 route vào `console-route-match.ts` (allowlist chạy trước session — phase 6); chỉ **thêm dòng** vì phase 8 cũng sửa file này.

## Tests After

| # | Test | Assert |
|---|---|---|
| A1 | `tests/integration/kitchen-inbox.test.ts :: chi phí đọc có chặn trên` | Với 500 đơn trong bảng, một lần polling đọc ≤ `limit` row (kiểm bằng số row trả về và `EXPLAIN QUERY PLAN` dùng `orders_kitchen_idx`) |
| A2 | `tests/integration/console-orders.test.ts :: vòng đời đầy đủ` | `pending_payment → (webhook) paid → preparing → fulfilled`, mỗi bước có đúng một row `order_commands` hoặc `provider_events` |
| A3 | `tests/integration/refunds.test.ts :: refund không chuyển tiền` | Không có lời gọi mạng nào trong luồng `decide` (stub fetch đếm 0 lần ngoài Resend outbox) — `refunded` chỉ là ghi nhận (O4) |

## Todo

- [x] T1–T22 viết trước và đỏ
- [x] `command-ledger.ts`
- [x] `order-commands.ts`
- [x] `refunds.ts`
- [x] `kitchen-inbox.ts`
- [x] 4 file route + allowlist + mount
- [x] A1–A3 xanh

## Regression gate

```bash
npm run typecheck && npm test
```

## Success criteria

- [x] T1–T22, A1–A3 xanh
- [x] Mọi lệnh Console idempotent; replay trả kết quả cũ, không chạy lại transition
- [x] Chuyển trạng thái trái phép → 409 và snapshot DB không đổi (T5)
- [x] Staff không duyệt refund (T8); Owner duyệt được và đọc được doanh thu (T22)
- [x] Polling 3s không đọc lại toàn bảng (A1)
- [x] `refunded` không có side effect chuyển tiền (A3)

## Risks

| Rủi ro | Mitigation |
|---|---|
| Cursor `since` bỏ sót đơn khi hai đơn cùng `updated_at` | T11 cố định thứ tự `(updated_at, id)` và kiểm không bỏ sót khi phân trang |
| Replay trả kết quả cũ đã lỗi thời (đơn đã đổi trạng thái sau đó) | `result_json` là kết quả của **lệnh đó**, không phải trạng thái hiện tại; UI luôn đọc lại danh sách sau khi gửi lệnh (phase 9) |
| `decideRefund` chạy 3 UPDATE trong một batch → khó debug khi abort | Assertion cuối lô kiểm cả ba điều kiện; test T14/T16 phủ cả nhánh thành công và nhánh chặn |
| Bỏ quên `needs_attention` khỏi response làm cờ của phase 4/5 vô dụng | T20 kiểm field có mặt |

## Security

- Mọi route qua allowlist → origin check → session → membership → permission (phase 6). Không route nào đọc `role` từ cookie.
- `provider_events` chứa raw payload giao dịch: chỉ Owner (`report:read`) đọc được (T19).
- `Idempotency-Key` do client sinh nhưng chỉ dùng làm khoá ledger, không bao giờ nội suy vào SQL (C2).

## Ghi chú thi công (2026-09-26)

- **Assertion bằng `changes()`**: mỗi batch lệnh đặt `UPDATE orders SET order_code = CASE WHEN changes() = 1 …` **ngay sau** câu ghi có điều kiện (`command-ledger.ts` → `assertPreviousWriteChangedOneRow`). Đã kiểm D1 giữ `changes()` giữa các câu trong một batch. Khác kiểu "kiểm trạng thái cuối" của plan: bắt được cả trường hợp một lệnh khác (khoá khác) đã làm đúng transition đó — test hai lệnh `prepare` chạy song song → đúng một `done`, một `invalid_transition`, một row `order_commands`. Bỏ assertion (mutation) → 3 test đỏ.
- Assertion của refund nhắm vào `orders`, **không** vào `refund_requests`: trigger `refund_requests_terminal_immutable` chặn **mọi** UPDATE trên row đã quyết. Lần `decide` thứ hai bị chặn bởi guard `WHERE status = 'pending'` của app (409, snapshot DB không đổi), không phải nhờ trigger.
- Trigger `orders_touch_updated_at` (migration 0001, theo tư vấn kongming): đổi `status`/`needs_attention` mà quên `updated_at` thì DB tự bump — cursor bếp không thể bị bỏ sót vì một writer tương lai.
- Kitchen inbox: lần đầu (không `since`) chỉ trả đơn `paid`/`preparing`; các lần sau trả mọi thay đổi `paid`/`preparing`/`fulfilled`/`refunded` sau cursor để client gỡ đơn đã xong. Cursor là chuỗi `"<updated_at>,<id>"` trong field `since`; `ETag` + `If-None-Match` → 304. Tra item theo lô ≤90 id (D1 giới hạn 100 tham số bind/câu).
- Thêm route `GET /api/console/refund-requests?status=` (Owner, quyền `refund:decide`): không có hàng chờ thì Owner không tới được route `decide`; phase 9 cần nó cho màn duyệt refund.
- `refund:request` cũng đi qua ledger `order_commands` (action `refund:request`) cho đồng nhất "mọi POST có `Idempotency-Key`".
- Mã lỗi: `forbidden` (403), `idempotency_key_required`/`invalid_json`/`unknown_field`/`invalid_reason`/`invalid_decision`/`invalid_cursor`/`invalid_date`/`filter_required` (400), `not_found` (404), `idempotency_conflict`/`invalid_transition`/`refund_already_requested` (409).
- Mutation: bỏ kiểm `refund:decide` ở route → test "staff không duyệt refund" đỏ.
- Chưa có smoke `wrangler dev` riêng cho route Console (cần phiên Google thật); test integration chạy qua worker thật với cookie better-auth thật; e2e phase 10 chạy luồng này trên trình duyệt.

## Next

Phase 9 dựng màn bếp polling 3s và màn refund trên 6 route này. Phase 10 dùng chuỗi `paid → preparing → fulfilled` cho e2e chặn merge.
