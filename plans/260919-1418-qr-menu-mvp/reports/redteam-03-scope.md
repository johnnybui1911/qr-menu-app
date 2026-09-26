# Red-team — Scope

## Blocker (phải sửa trước khi cook)

|#|Phase:dòng|Vấn đề|Vì sao chặn|Sửa thế nào|
|---|---|---|---|---|
|1|phase-04:51,79,117,118,122,123 ↔ phase-05:42 ↔ phase-02:57,121|Phase 4 bắt buộc `INSERT order_email_jobs` trong batch chuyển `paid` (T13 "+1 job", T14/T18/T19 xoay quanh job đó) nhưng không phase nào định nghĩa `kind` cho email "đơn đã trả". Phase 5 chốt chỉ 2 kind (`refund_confirmed`, `daily_revenue_report`) và "không nhắc đơn, không email cho khách"; 0002 CHECK `kind` đúng 2 giá trị.|Hoặc INSERT kind lạ → CHECK abort → **toàn batch `paid` rollback, tiền không được ghi nhận** (webhook 500 → PayFS retry 2,8h vô ích); hoặc dùng `daily_revenue_report` gắn `order_id` → mỗi đơn trả tiền sinh một "báo cáo ngày", phase-05 T15 ("đúng 1 job/ngày") không thể xanh. PRD §3 chỉ hứa email chốt ngày + xác nhận refund → email khi `paid` là scope tự mở.|Bỏ `INSERT order_email_jobs` khỏi batch `paid` (phase-04:51,79); T13/T14/T19 bỏ mệnh đề `order_email_jobs`; T18 đổi thành "assertion fail → transition lẫn `provider_payments` cùng rollback". Bằng chứng D12/D23 "enqueue cùng batch" đã có ở phase-07:53,119 (refund) và phase-06 A2 (invitation).|
|2|phase-06:8,25,63,140,150 ↔ plan.md:64,70 ↔ phase-05:42,88,122|Phase 6 khai `dependencies: [2]`, "không phụ thuộc 3–5, chạy song song", nhưng bước 11 enqueue email mời qua `packages/orders/src/email-outbox.ts` (phase 5 tạo) và cần template `kind='invitation'` trong `apps/worker/src/order-email-service.ts` (phase 5 sở hữu, chỉ dựng 2 kind). Không phase nào sở hữu template mời → job `invitation` bị claim rồi fail tới `retired`. Thêm 0007 copy-drop-recreate cả bảng ledger chỉ để nới CHECK mà phase 2 đã biết trước (D20 ghi rõ email mời qua outbox).|Nhánh quản trị khởi động song song sẽ import module chưa tồn tại; phase-06 A2 không thể xanh; email mời không bao giờ gửi → Owner không mời được staff (D20). 0007 sửa bảng đã có dữ liệu ở prod là rủi ro thừa.|(a) Phase 2: `kind CHECK IN ('daily_revenue_report','refund_confirmed','invitation')` ngay trong 0002; xoá 0007 (phase-06:98,140,164; plan.md:83; phase-10:123 "đủ 7 migration" → 6). (b) Chuyển `enqueueEmailJob()` (chỉ statement builder cho bảng phase 2 sở hữu) vào phase 2 `packages/orders/src/email-outbox.ts`; phase 5 giữ claim/send/retire. (c) phase-05:42 liệt 3 kind và sở hữu template mời. Khi đó phase 6 thật sự chỉ cần phase 2.|
|3|phase-09:61,82,127 ↔ phase-06:56,111 ↔ phase-07:49-54 ↔ phase-05:89,121|PRD §2.3.4 "Xem báo cáo doanh thu": phase 9 dựng `revenue-panel.tsx`, phase 6 cấp `report:read`, phase 5 viết `summarizeDailyRevenue` — nhưng **không phase nào tạo route** kiểu `GET /api/console/revenue`; `report:read` chỉ dùng cho `provider-events`.|Phase 9 không thi công được màn doanh thu; không chủ sở hữu file route → mọi phase tưởng người khác làm.|Thêm vào phase 7: `apps/worker/src/console-report-routes.ts`, `GET /api/console/revenue?date=` (quyền `report:read`, gọi `summarizeDailyRevenue`) + 1 test "staff 403 / owner tổng·số đơn·số refund"; phase 7 `dependencies: [4,5,6]`; thêm file vào plan.md:84 và allowlist.|
|4|phase-01:52,55,68,92-95,110,115 ↔ scout-01:65-69,175-185 ↔ phase-09:153 ↔ phase-10:49,98,112|~15 file test `tests/node/**` (import-graph, no-hardcoded-hostname, sql-hygiene, payfs-gate, dev-sign-script, identity-purity, secret-hygiene, email-secret, log-hygiene, image-cache-policy, storefront-bundle, ci-config, **secret-scan**) và 20 test `tests/browser/**` không có runner: `vitest.config.ts` (scout-01) chỉ include `tests/unit` + `tests/integration`, CI 5 bước chỉ chạy `test:workerd`, không script `test:node`. Phase 9 gọi `test:browser` ở gate cục bộ nhưng phase-10 T3 khoá CI "đúng 5 bước". Phase-10:112 tự hỏi rồi bỏ lửng.|Cổng D3 (import-graph), D21 (hostname), D16 (**quét secret**) và toàn bộ test UI không bao giờ chặn merge — Success Criteria plan.md:103-105 thành hình thức. Test đọc fs/grep cũng không chạy được trong pool workerd.|Phase 1: `vitest.node.config.ts` (`environment: node`, include `tests/node/**`), script `test:node`; `npm test` = `test:node && test:workerd && test:browser`; CI bước 2 = `npm test`. Phase-10 T3 khẳng định bước 2 là `npm test` (vẫn đúng 5 cổng D14, chỉ mở rộng nội dung bước 2). Xoá câu bỏ lửng phase-10:112.|
|5|phase-10:41,121|Chứng minh e2e "có tác dụng" bằng biến `E2E_MUTATE=1` khiến **worker production bỏ bước chuyển `paid`**.|Đưa một nhánh code "không ghi nhận tiền" vào chính đường webhook, chỉ chờ một biến môi trường bị set nhầm ở prod. Trái tinh thần D22 (cổng hẹp) và là scope tự mở vào code sản phẩm.|Test âm không chạm worker: chạy spec với dev-sign `--secret` sai (worker 401 → màn khách không `paid` → spec phải đỏ). Hoặc ghi vào runbook một lần mutation tay kèm ảnh chụp. Bỏ mọi nhắc tới `E2E_MUTATE`.|

## Nên sửa (không chặn)

|#|Phase:dòng|Vấn đề|Đề xuất|
|---|---|---|---|
|1|phase-02:109,167 (scout-02:95,152,165,194-198)|Cột `currency` trên `products`/`orders`/`order_items` + FK composite `(order_id, store_id, currency)`: đa tiền tệ không có trong PRD; D11.6/F9 chốt VND. Plan tự nhận "làm INSERT phức tạp".|Bỏ cột `currency` (hoặc một CHECK `currency='VND'`, không FK composite); xoá vế currency của T13.|
|2|phase-02:120 (scout-02:154)|`payment_method CHECK IN ('vietqr','cash')` — `cash` ngoài scope (PRD §6: chỉ VietQR).|CHECK `IN ('vietqr')`.|
|3|phase-02:120 ↔ phase-07:42,132,140 (scout-02:167)|`orders_kitchen_idx` của scout là `(store_id, status, created_at, id)`; phase 7 cursor `WHERE updated_at > ? ORDER BY updated_at, id` và A1 đòi EXPLAIN dùng đúng index đó.|Phase 2 ghi rõ index `(store_id, updated_at ASC, id ASC)`.|
|4|phase-05:91 ↔ phase-07:45,54 (scout-02:261-272)|`provider_events.source` (phase 5) và `provider_events.order_id` (phase 7 lọc `?orderId=`) không có trong 0002; phase 5/7 không sở hữu migration và không còn số trống (0003 P4, 0004–0007 P6) → đụng C13.|Thêm `order_id TEXT NULL` + `source TEXT NOT NULL CHECK IN ('webhook','reconciliation')` vào 0002 (phase 2).|
|5|phase-06:25,120 ↔ plan.md:64 ↔ DR D20|D20 hứa "thu hồi nhân viên không phải sửa DB tay"; T12/T21 test membership `revoked` nhưng **không route nào** set `status='revoked'`.|Thêm `POST /api/console/memberships/:id/revoke` (Owner, không tự revoke) vào phase 6 + 1 test; hoặc ghi rõ MVP revoke bằng `wrangler d1 execute`.|
|6|phase-09:55-62 ↔ phase-06:62|Console không có màn Owner **tạo** lời mời (`POST /api/console/invitations`) — chỉ có màn nhận. Owner phải curl với cookie để mời staff.|Thêm `staff-admin.tsx` (email + role → hiện link mời một lần) vào phase 9 Requirements/Architecture + 1 test browser.|
|7|phase-07:112 ↔ phase-08:104|T7 phase 7 gọi `PATCH /api/console/products/:id` → 403 nhưng route do phase 8 (song song) tạo; chưa có phase 8 thì allowlist trả 404, T7 không xanh được. Phase 8 T5 đã phủ.|Cắt vế "không sửa menu" khỏi phase-07 T7.|
|8|phase-06:103 ↔ plan.md:86 ↔ phase-09:116|Phase 6 "Modify `apps/console/src/**`" trong khi phase 9 sở hữu độc quyền và T19/`invite-accept.tsx` của phase 9 làm lại đúng việc đó.|Xoá phase-06:103; bằng chứng tay của phase 6 dùng `GET /api/console/session`.|
|9|plan.md:74 ↔ plan.md:83 ↔ phase-07:99 ↔ phase-08:93|`console-route-match.ts` thuộc phase 6 độc quyền nhưng phase 7 và 8 (song song) đều sửa; plan.md chỉ khai 2 file dùng chung.|Khai `console-route-match.ts` là file dùng chung "chỉ thêm dòng" thứ ba tại plan.md:74, hoặc mỗi module route export bảng route riêng để allowlist gộp tự động.|
|10|phase-01:110 ↔ phase-02:63,89,126,160 ↔ phase-04:135 ↔ phase-06 (không có dòng nào)|`BUSINESS_TABLES` viết tay trong `tests/support/test-env.ts` (phase 1 sở hữu `tests/support/**`); phase 6 thêm 8 bảng (`user`,`session`,`account`,`verification`,`rateLimit`,`store_memberships`,`store_bootstrap_claims`,`owner_invitations`) nhưng không todo cập nhật → `resetDb()` apply lại 0004 vỡ "table already exists" cho mọi test integration sau phase 6; phase 4 và 6 song song cùng sửa một hằng.|`resetDb` liệt kê bảng từ `sqlite_master` (loại `sqlite_%`, `_cf_%`) rồi DROP — bỏ hẳn `BUSINESS_TABLES` và các todo phase-02:63,160.|
|11|phase-05:42 ↔ phase-10:42 ↔ plan.md:47 (C11)|`DAILY_REPORT_HOUR_ICT` là var mới ngoài C11 ("chỉ CONSOLE_ORIGIN/STOREFRONT_ORIGIN là vars").|MVP dùng hằng `23` trong `scheduled.ts` (O8 chốt giờ khác → sửa hằng), hoặc bổ sung vào C11.|
|12|phase-08:49,56,105,111 ↔ phase-09:58,115|`expectedRevision` optimistic concurrency + 3 test + UI "món đã sửa ở nơi khác": MVP một Owner, tình huống không xảy ra. Cột `revision` giữ được (DDL scout), API/UI/tests là chi phí thêm.|Cân nhắc bỏ `expectedRevision` khỏi PATCH và T6/T16; T11 ép batch fail bằng `product_id` không tồn tại. Không chặn nếu giữ.|
|13|phase-03:129; phase-08 A3|A3 "hàm log của worker redact token" — không phase nào tạo module log; assert lên hàm không tồn tại.|Thêm `apps/worker/src/log.ts` (redact `orderToken`/`tableToken`/`tokenUrl`) vào phase 3 Files + sở hữu, hoặc bỏ A3.|
|14|plan.md:76-87|Không dòng sở hữu cho `tests/{unit,integration,node}/**`, `tests/fixtures/payfs/**` (phase-04 tạo `test-vector.json`, phase-10 tạo `transactions-sample.json`), `.dev.vars.example` (phase-06:101). Nhiều phase nối vào cùng file test (`no-hardcoded-hostname.test.ts` P1+P10; `payfs-transactions.test.ts` P5+P10).|Quy ước: phase tạo file test là chủ, phase sau chỉ thêm `describe` mới. Liệt `tests/fixtures/payfs/**` cho phase 4, `.dev.vars.example` cho phase 6.|

## Đã kiểm và thấy ổn

- **Thứ tự thi công**: 1→2→(3→4→5)∥(6→8)→7→9→10 khớp "A rồi C" (brainstorm §3-4) và M0..M4. Lệch vô hại: (i) tầng idempotency lệnh Console (brainstorm M2) lùi sang phase 7/M3 — bảng đã có từ 0002 nên không retrofit; (ii) refund (brainstorm M4) lên sớm ở phase 7/M3. Lệch cần biết: lát cắt dọc M1 (phase-04:145 A3) dừng ở `paid` trong D1; "console thấy đơn" và fetch cross-origin có custom header từ SPA chỉ được kiểm ở phase-09:130 A2 — rủi ro "assets binding hai origin" (plan.md:110 ghi "phase 1–4") thực tế chỉ kiểm phía server (phase-03 T15/T16); chấp nhận được nếu phase 9 A2 làm sớm. Song song 6∥3-5 chỉ hợp lệ sau khi sửa Blocker #2.
- **Không mở scope kiểu mục C**: không voucher/ghép bàn/biến thể/cổng thẻ/ORM/package thứ tư/WebSocket; D19 tuân đúng (phase-08 "không thêm đường tính giá"); C9 cổng hẹp PayFS (phase-04:54, A2); `rateLimit` DB + option better-auth theo scout-04:3 là bắt buộc của D15, không phải mở scope. `order_access`, `stores`, `needs_attention`, `table_secrets` đều truy được về D4/D6/D8/D17.
- **Số migration** 0001–0002 (P2), 0003 (P4), 0004–0006 (P6) không đụng nhau; 0007 nên xoá (Blocker #2). Effort 84h ≈ 2 tuần một người, khớp PRD §6.
- **Bảng đối chiếu PRD → phase**

|PRD|Phase (dòng / test)|
|---|---|
|§2.1.1 quét QR bằng `table_token`|P3:47 + T10/T11 (:103-104); P8:54 T16-T18; P9:48 T1|
|§2.1.2 xem menu, chọn/sửa số lượng, xem lại đơn|P3:47, A1; P9:49-50 T3/T4|
|§2.1.3 đặt món → VietQR|P3:48, T1-T5 (:94-98), `vietqr.ts`; P9:51 T7|
|§2.1.4 webhook → `paid` + Secret Link|P4:48-51 T13 (:117); P3:49,52 T12/T13 (:105-106); P9:51-52 T8|
|§2.2.1 bếp thấy đơn ≤3s theo bàn|P7:49 T9-T11; P9:57 T11-T13; P10:97 T2|
|§2.2.2 preparing → fulfilled|P7:50-51 T2; P9:57|
|§2.2.3 yêu cầu refund kèm lý do|P7:52 T12/T13/T17; P9:57|
|§2.3.1 đăng nhập Google|P6:48-55 T7-T13; P9:56|
|§2.3.2 CRUD món, ảnh R2, out_of_stock|P8:48-52 T4-T15; P9:58|
|§2.3.3 bàn + xuất QR một lần, ân hạn 15'|P8:53-54 T16-T18; P9:59 T17|
|§2.3.4a báo cáo doanh thu|P5:89,112 (SQL); P9:61 (UI) — **route API: KHÔNG CÓ** → Blocker #3|
|§2.3.4b duyệt/từ chối refund|P7:53 T14-T16; P9:60 T18|
|§4.1.1 server pricing|P2 T14 (:110); P3 T4/T5 (:97-98)|
|§4.1.2 snapshot|P3 T6 (:99)|
|§4.1.3 idempotency|P3 T7/T8 (:100-101); P4 T14 (:118); P7 T3/T4 (:108-109)|
|§4.1.4 secret link|P3:49,52 T12/T13 (:105-106)|
|§4.2 vòng đời|P4 T6 (:110); P7 A2 (:141); P5:48 `cancelled`|
|§5 categories/products/tables/table_secrets/orders/order_items/refund_requests|P2:49 (0001) + T6-T13; `payment_method` có trong DDL scout-02:154 nhưng phase 2 không gọi tên (xem Nên sửa #2)|
|§5 order_idempotency/provider_events/provider_payments/order_email_jobs|P2:50 (0002) T10/T12|
|§5 store_id, INTEGER VND, digest token, `resolveLineItemPrice`|P2:51-54,58-59 T1-T3, T11, T18|
|§6 happy path|P3→P4→P7→P9; P10:46 e2e|
|§6 RBAC Staff/Owner|P6:56 T1-T6; P7 T7/T8; P8 T5/T19|
|§6 webhook PayFS / R2 / better-auth / Resend|P4 / P8:50 / P6:51 / P5:51 + P10:132|
|§7 unit/integration tổng tiền, snapshot, transition|P2 T14, P3 T5/T6, P7 T5|
|§7 webhook contract (vector + regex)|P4 T1 (:105), T4 (:108)|
|§7 e2e UI|P10:46,129 T1|
|§7 security audit|P10:55 T7/T8; P6 A3 — (chỉ có hiệu lực sau Blocker #4)|

- **Bảng 7 test bắt buộc** — đủ cả 7:

|#|Test bắt buộc|Phase · test|
|---|---|---|
|1|Tổng tiền server-authoritative, client gửi giá bị từ chối|P3 T4 `order-validation :: từ chối field lạ` (:97) + T5 `storefront-order :: tổng tiền do server tính` (:98); P2 T14 (:110)|
|2|Snapshot giá|P3 T6 `storefront-order :: snapshot giá bất biến` (:99)|
|3|Idempotency: retry không nhân bản · rebind → 409 · webhook replay no-op|P3 T7 (:100), T8 (:101); P4 T14 `payfs-webhook :: replay cùng transaction_id → no-op` (:118)|
|4|Transition trái phép → 409, không side effect|P7 T5 `console-orders :: transition sai → 409 không side effect` (:110, so snapshot 4 bảng); P4 T19 (:123)|
|5|Phân quyền Staff|P6 T1/T2 (:109-110) thuần; P7 T8 (:113), P8 T5 (:104) + T19 qua HTTP|
|6|Test vector chữ ký `86f02cef…c5e`|P4 T1 `payfs-signature :: khớp test vector công bố` (:105)|
|7|Regex trên mã do code sinh, `content` có rác|P4 T4 `payfs-matching :: matcher chạy trên mã do code sinh` (:108); P2 T4 (:100)|