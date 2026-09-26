# Brainstorm — Cách build QR Menu App

Ngày: 2026-09-19 · Chế độ: `/ak:brainstorm` (định hình hợp đồng + so sánh phương án, **không sinh code**)
Đầu vào: [`docs/PRD.md`](../../docs/PRD.md) · [Decision Record](../../docs/decisions/260919-post-xia-decision-record.md) · [Xia report](./260919-xia-nexus-handson-reference.md) · [`docs/reference/nexus/`](../../docs/reference/nexus/00-index.md) · tài liệu PayFS thật (`docs.payfs.vn`)

---

## 1. Hợp đồng bàn giao

Bốn trường dưới đây **tái sử dụng** Decision Record đang có; chỉ ghi lại phần đã thay đổi sau phiên này.

**Outcome.** Một quán đơn lẻ chạy được trọn vòng tiền trên production: khách quét QR tại bàn → xem menu → đặt món → nhận mã VietQR → chuyển khoản → webhook PayFS xác thực chữ ký → đơn `paid` → bếp thấy đơn trong ≤3 giây → `preparing` → `fulfilled`. Owner quản lý menu/bàn/refund, nhận email chốt ngày.

**Constraints.** D1–D19 trong Decision Record là ràng buộc cứng. Tóm tắt phần chi phối nhất: Vite + React SPA (không Next.js) · SQL viết tay, không ORM · 3 package `identity → catalog → orders` · tiền là INTEGER VND · mọi mutation nhiều bước đi qua một `db.batch()` có assertion tự huỷ · secret qua `wrangler secret put`.

**Non-goals.** Ghép bàn, tích điểm, voucher, cổng thẻ quốc tế, CSV import, variant matrix, WebSocket/Durable Object, package `shared`, ORM, bộ `scripts/verification` của repo mẫu.

**Acceptance.** CI chặn merge: `typecheck` → `test:workerd` → `build:console` → `build:storefront` → 1 e2e luồng tiền. Năm test bắt buộc theo D14, cộng hai test mới sinh ra từ phiên này:
6. Chữ ký webhook — test vector công bố của PayFS phải cho ra đúng `86f02cef…c5e`.
7. Mã tham chiếu — regex đối soát chạy trên **giá trị thật do code sinh**, và `content` có rác của ngân hàng bao quanh vẫn khớp.

---

## 2. Cái đã thay đổi trong phiên này

Bốn mục `OPEN` đã đóng bằng **nguồn sơ cấp**, không phải suy đoán. Một quyết định cũ **sai kỹ thuật** và đã được sửa.

| Việc | Trước phiên | Sau phiên |
| --- | --- | --- |
| D5 chữ ký webhook | "HMAC-SHA256 trên **raw body**" | **Sai.** PayFS ký `timestamp + "." + JSON.stringify(payload đã sort khóa đệ quy)`. Đã chạy lại test vector của PayFS: bản canonical khớp, bản raw-order ra digest hoàn toàn khác → code theo bản chốt cũ sẽ **từ chối 100% webhook hợp lệ** |
| O1 API đối soát | "Không biết PayFS có không" | Có: `GET https://api.payfs.vn/v1.1/transactions`, Bearer API Token — **khóa khác** webhook key |
| O2 webhook local | "Chưa xác minh" | PayFS không có nút gửi thử. Vòng lặp dev = script tự ký payload; `cloudflared` chỉ dùng cho **một** smoke test chuyển khoản thật |
| O4 refund | "Thủ công hay qua API?" | Thủ công. PayFS là dịch vụ *ghi nhận biến động số dư*; tài liệu phát triển không có endpoint chi tiền. `refunded` là trạng thái ghi nhận |
| O5 biến thể món | "Chặn migration đầu tiên" | **Không chặn.** Thêm biến thể sau là migration thuần cộng thêm (bảng mới + cột nullable), khác hẳn `store_id`. Xem D19 |
| Xuất QR bàn | Mâu thuẫn chưa ai thấy | PRD hứa in lại QR bất cứ lúc nào; D8 chỉ lưu digest → **không thể in lại**. Giải bằng D17: xoay token + ân hạn 15 phút |

Điểm đắt nhất trong bảng này là dòng đầu. Nếu build theo thứ tự "webhook làm sau cùng" như đề xuất cũ, lỗi canonicalization sẽ lộ ra vào ngày 10–12 của một dự án 14 ngày.

---

## 3. Ba phương án tổ chức công việc

Đây là chỗ còn lựa chọn thật. Kiến trúc đã khoá; thứ tự làm thì chưa.

### Phương án A — Walking skeleton luồng tiền trước

Ngày 1–3 dựng một lát cắt dọc mỏng nhất chạy thật đầu-cuối: 1 bàn seed, 2 món seed, không auth, không UI đẹp — nhưng **đi qua đủ**: storefront (origin riêng) → API → D1 → mã VietQR → webhook đã ký → `paid` → console thấy đơn. Sau đó mới đắp thịt.

- Giả định phụ thuộc nhất: ba tích hợp lạ (assets binding hai origin, canonicalization chữ ký PayFS, `applyD1Migrations` trong vitest workerd) **đều có thể chạy được cùng nhau**.
- Hỏng đầu tiên khi: giả định đó sai — và đó chính là lý do làm nó trước. Chi phí bỏ đi: vài trăm dòng seed/scaffold.

### Phương án B — Theo lớp, đúng thứ tự Xia report §7

Workspace → migrations → money/pricing → idempotency → auth → R2 → PayFS → refund/email.

- Giả định phụ thuộc nhất: mọi tích hợp bên ngoài sẽ hành xử đúng như tài liệu khi ráp vào bước 8.
- Hỏng đầu tiên khi: PayFS hoặc cấu hình hai origin không như mong đợi. Lúc đó đã hết 2/3 thời gian và hợp đồng nghiệp vụ đã đông cứng quanh giả định sai. Đây đúng là kịch bản mà dòng D5 sai ở trên suýt gây ra.
- Ưu điểm thật: mỗi lớp gọn, dễ review, ít code vứt đi.

### Phương án C — Hai nhánh song song ngay từ đầu

Nhánh tiền (`orders` + webhook) và nhánh quản trị (`identity` + `catalog` + Console CRUD) chạy song song, gặp nhau ở hợp đồng API thống nhất trước.

- Giả định phụ thuộc nhất: hợp đồng API và schema chốt được **trước** khi hai nhánh tách ra.
- Hỏng đầu tiên khi: hai nhánh cùng sửa `migrations/` — file đánh số append-only là điểm xung đột không thể merge tự động, và biên giới package chưa có gì để cưỡng chế lúc repo còn rỗng.

### Khuyến nghị: **A, rồi C**

Làm skeleton (A) tới khi một đồng VND giả chạy hết đường ống, **và** migration nền + `money` + `resolveLineItemPrice` đã ổn định. Đó là thời điểm `migrations/` hết là điểm nóng tranh chấp — chuyển sang hai nhánh song song (C) cho phần còn lại.

Lý do chọn theo trường hợp xấu nhất, không phải trường hợp đẹp: B tối ưu cho "mọi thứ đúng như tài liệu", nhưng phiên này vừa chứng minh tài liệu nội bộ sai một chỗ chết người. A rẻ nhất để vứt bỏ khi giả định sai, vì thứ bị vứt là seed chứ không phải hợp đồng nghiệp vụ.

---

## 4. Lộ trình đề xuất

| Mốc | Nội dung | Bằng chứng hoàn thành |
| --- | --- | --- |
| M0 · Skeleton | npm workspaces, 3 package rỗng + `exports: {"./*": …}`, `wrangler.jsonc` (DB/FILES/ASSETS/cron), wrangler riêng cho storefront, `applyD1Migrations` trong vitest workerd, gate import-graph cho **cả hai** app. Hai origin `workers.dev`, **hostname đọc từ biến môi trường, không hard-code** (D21) | `npm test` xanh với 1 test chạm D1 thật; hai `build:*` ra bundle; không còn hostname literal nào trong source |
| M1 · Lát cắt dọc | migration 0001 (`store_id`, tiền INTEGER, `categories/products/tables/table_secrets/orders/order_items`), `money`, `resolveLineItemPrice`, đặt đơn server-authoritative, sinh `payment_reference` (D18), webhook đã xác thực đủ 6 bước D5 | Script tự ký bắn payload → đơn chuyển `paid`; test vector PayFS khớp |
| M2 · Bền vững tiền | Idempotency 3 tầng (D10), state machine + guard `UPDATE … WHERE status = <from>` (D9), `provider_events`/`provider_payments`, cron đối soát `*/1` (D6), **bảng `order_email_jobs` + enqueue trong cùng batch + cron `*/5` + backoff** (D23 — phải làm ở đây, không lùi được) | Test 1–5 của D14 + test 6–7 mới; job email chạy đủ vòng enqueue → claim → retire |
| M3 · Console | better-auth + Google (D15), bootstrap Owner bằng `INITIAL_OWNER_EMAIL` + `store_bootstrap_claims` một-lần, **hệ thống invitation đầy đủ cho staff** (D20), CRUD menu, ảnh R2 (D13), quản lý bàn + xuất QR theo D17, màn bếp polling 3s | Staff không sửa được menu; bootstrap lần hai bị từ chối; token mời hết hạn/dùng lại bị từ chối với thông báo giống hệt; QR cũ còn sống 15 phút sau khi xoay |
| M4 · Khép vòng | Refund request → Owner duyệt (ghi nhận, không chuyển tiền), **bật gửi Resend thật** (D23), e2e luồng tiền chặn merge. Điều kiện ngoài: PayFS đã đăng ký + nối ngân hàng (O7), domain email đã verify (O8) | CI đủ 5 cổng; 1 lần smoke chuyển khoản thật qua `cloudflared` |

Song song từ M3 (phương án C): nhánh tiền làm M2→M4-refund, nhánh quản trị làm M3. Hai nhánh chỉ gặp nhau ở `apps/worker` route table và `migrations/` — quy ước: **một người sở hữu số migration kế tiếp tại một thời điểm**.

---

## 5. Rủi ro còn lại

| Rủi ro | Vì sao thật | Chặn bằng |
| --- | --- | --- |
| Canonicalization JSON lệch kiểu JS (escape Unicode, định dạng số) khi `content` có dấu tiếng Việt | Chữ ký ký trên JSON dựng lại, không phải byte gốc | Test vector PayFS trong CI; chữ ký lệch thì ghi raw body vào `provider_events` rồi 401, không nuốt lỗi |
| Khớp đơn chỉ dựa vào `content` + `amount` | Webhook không có trường nào trỏ về đơn (F13) | `UNIQUE(store_id, payment_reference)`, sinh mã ở đúng một hàm, cấm `DEFAULT` ở tầng SQL, bắt buộc `amount` khớp tuyệt đối |
| Preflight CORS mỗi request storefront (token đi trong header) | Storefront khác origin, custom header | `Access-Control-Max-Age` |
| Chi phí read D1 khi polling 3s | D7 chấp nhận cho MVP | Endpoint bếp trả theo cursor `since` + ETag; ngưỡng nâng cấp ~30 bàn hoạt động |
| Hạn mức PayFS 30 giao dịch/tháng ở gói OpenBanking miễn phí | Một quán thật vượt trong ngày đầu | O6 — chốt gói trước ngày mở bán |

---

## 6. Còn mở

1. **O6** — gói dịch vụ PayFS. Không chặn code, chặn ngày mở bán.
2. **Xác nhận D19** — chấp nhận MVP không có biến thể, cỡ ly khai báo thành món riêng. Nếu quán đích bán >15 món phải nhân đôi theo cỡ, nói ngay để đưa `product_variants` vào M1 thay vì phase sau.
3. **Tài khoản nhận tiền** — một số tài khoản duy nhất, một tên biến duy nhất dùng chung cho cả sinh QR lẫn đối soát (bài học R6 của repo mẫu).

---

## 7. Bàn giao

Bước kế: `/ak:plan` với đầu vào `docs/PRD.md` + Decision Record (đã cập nhật D5, D6, D17, D18, D19, F11–F13) + Xia report + file này. Sau đó `/ak:cook` theo M0→M4.
