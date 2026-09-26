# Báo cáo — Các vấn đề đã chốt trong phiên brainstorm

Ngày: 2026-09-19
Phiên: `/ak:brainstorm` trên `docs/PRD.md` + [Decision Record](../../docs/decisions/260919-post-xia-decision-record.md) + [Xia report](./260919-xia-nexus-handson-reference.md)
Phương án và lộ trình thi công: [`260919-brainstorm-build-approach.md`](./260919-brainstorm-build-approach.md)

Phạm vi file này: **chỉ liệt kê những gì đã chốt**, kèm bằng chứng và hệ quả thi công. Mọi mục dưới đây đã được ghi vào Decision Record và `docs/PRD.md`; file này là bản tra cứu nhanh, không phải nguồn sự thật.

Tổng kết: **1 quyết định cũ bị sửa vì sai kỹ thuật** · **4 mục OPEN đóng bằng nguồn sơ cấp** · **7 quyết định mới (D17–D23)** · **2 lỗ hổng hợp đồng được giải** (xuất QR vs digest-only; Owner đầu tiên vào membership bằng cách nào) · **5 mục chủ dự án đã xác nhận** · **4 mục mở còn lại, không mục nào chặn `/ak:plan`**.

---

## 1. Quyết định cũ bị sửa

### D5 — Chữ ký webhook PayFS: ký JSON chuẩn hóa, KHÔNG phải raw body

| | |
| --- | --- |
| **Trước** | "HMAC-SHA256 trên **raw body** (đọc trước khi parse JSON)" |
| **Sau** | `data = timestamp + "." + JSON.stringify(sortKeysRecursive(JSON.parse(body)))`, rồi `HMAC_SHA256(data, PAYFS_WEBHOOK_SECRET)` |
| **Bằng chứng** | `docs.payfs.vn/vi/developers/webhook-signature`; test vector của PayFS chạy lại tại chỗ |
| **Mức độ** | Chặn production. Bản cũ **từ chối 100% webhook hợp lệ** |

Kết quả chạy lại test vector (`secret whsec_example_secret_do_not_use_in_production`, `timestamp 1758173916`):

```
expected   86f02cefae56d51f72a00e04bf9d5a96b40cfe6902d54e495234c447ec706c5e
canonical  86f02cef…706c5e   MATCH
webcrypto  86f02cef…706c5e   MATCH    ← crypto.subtle, chạy được trong workerd
raw-order  9505bca4…1f7b8    DIFFER   ← ký raw body với thứ tự khóa khác: hỏng
```

Hợp đồng xác minh đã chốt, **đúng thứ tự**:

| # | Bước | Thất bại → |
| --- | --- | --- |
| 1 | Chặn body > 16 KB trước khi đọc | 413 |
| 2 | `X-Client-API-Key` so sánh constant-time | 401 |
| 3 | `X-PayFS-Timestamp` lệch > 300 giây | 401 |
| 4 | Parse JSON | 400 |
| 5 | Dựng lại chuỗi ký, HMAC, so sánh constant-time với `X-PayFS-Signature` | 401 |
| 6 | `transfer_type !== "credit"` → ghi `provider_events`, 200, không đụng đơn | 200 |

Ràng buộc kèm theo:
- Dùng **WebCrypto**, không `node:crypto`.
- Chữ ký **không có tiền tố** `sha256=`.
- Chữ ký lệch → ghi raw body vào `provider_events` rồi 401. Không nuốt lỗi im lặng.
- Endpoint phải trả lời trong 30 giây, nếu không PayFS tính là thất bại và gửi lại.

---

## 2. Bốn mục OPEN đã đóng

| Mục | Câu hỏi | Kết luận đã chốt | Nguồn |
| --- | --- | --- | --- |
| **O1** | PayFS có ký HMAC không, header tên gì, có API đối soát không | Có ký (xem D5). Có API: `GET https://api.payfs.vn/v1.1/transactions`, `Authorization: Bearer <API Token>`. API Token **khác** Webhook API Key **khác** Webhook Secret — ba secret, ba tên | `docs.payfs.vn/vi/developers/api-token`, `/webhooks`, `/webhook-signature` |
| **O2** | Nhận webhook khi dev local thế nào | PayFS không có nút gửi thử. Hai lớp: (1) vòng lặp dev hằng ngày dùng **script tự ký payload** bắn thẳng vào worker local — deterministic, chạy được trong CI; (2) `cloudflared tunnel` + đăng ký URL trong Client Portal **chỉ cho một lần** smoke test chuyển khoản thật trước production | Tài liệu PayFS không có môi trường sandbox |
| **O3** | Ngưỡng N phút cho job đối soát | 2 phút → gọi API đối soát · 15 phút → gắn cờ `needs_attention` cho Owner · 30 phút → `cancelled`, giải phóng bàn. Cron `*/1`, tách khỏi cron `*/5` của email outbox | Suy ra từ retry policy của PayFS (tối đa 10 lần, chờ đầu 10s, hệ số 2 ≈ 2.8 giờ) — quá chậm cho khách ngồi tại bàn |
| **O4** | Refund qua API PayFS hay thủ công | **Thủ công**. PayFS là dịch vụ ghi nhận biến động số dư; tài liệu phát triển không có endpoint chi tiền nào. `refunded` là trạng thái **ghi nhận**, không có side effect chuyển tiền. Owner chuyển khoản tay rồi bấm duyệt | `docs.payfs.vn/llms.txt` — mục Phát triển chỉ có quickstart, api-token, webhooks, webhook-signature |

---

## 3. Ba quyết định mới

### D17 — Token bàn xoay được, có cửa sổ ân hạn

Giải mâu thuẫn giữa `docs/PRD.md:27` (Owner "xuất mã QR" bất cứ lúc nào) và D8 (chỉ lưu SHA-256 digest → không thể in lại). Nhượng bộ D8 là tự bỏ lợi ích bảo mật chính, nên nhượng bộ ở phía quy trình.

- Bảng riêng `table_secrets(id, store_id, table_id, token_digest, created_at, revoked_at)`.
- "Xuất QR" = **sinh token mới**, hiển thị **đúng một lần**. Không có đường đọc lại.
- Token cũ sống thêm **15 phút** để khách đang ngồi không bị 404 giữa bữa.
- Một bàn có thể có nhiều digest sống cùng lúc; JOIN trên `token_digest` kèm `revoked_at IS NULL OR revoked_at > now`.
- Token đi trong **URL fragment** (`https://<storefront>/t#<token>`), SPA đọc rồi gửi qua header — fragment không tới server, không vào log.
- Hệ quả đã biết: request storefront là cross-origin có custom header → có preflight. Đặt `Access-Control-Max-Age`.

### D18 — Mã tham chiếu thanh toán: một định dạng, sinh ở một chỗ

Webhook **không có trường nào trỏ về đơn hàng**. Khớp đơn chỉ dựa vào `content` + `amount`.

- Định dạng `QM` + 8 ký tự `[0-9A-Z]`, sinh bằng CSPRNG **trong code ứng dụng**, một hàm duy nhất.
- **Cấm** `DEFAULT` sinh mã ở tầng cột SQL — đây đúng là lỗi R4 của repo mẫu (matcher cần 18 hex, `DEFAULT` sinh 32 hex → row nào dùng DEFAULT là không bao giờ khớp).
- `UNIQUE(store_id, payment_reference)`.
- Khớp = tìm **chuỗi con** trên `content` đã `upper()`, không so cả chuỗi: ngân hàng chèn rác vào nội dung.
- `amount` phải khớp **tuyệt đối** với `total_amount`. Lệch → không `paid`, ghi `provider_events` + cờ cho Owner.

### D19 — Biến thể món: không làm ở MVP, và không chặn migration đầu

Bản chốt cũ nói O5 chặn migration 0001. Kiểm lại thì không đúng: khác `store_id` (thêm sau = migrate lại khoá và index), thêm biến thể là **migration thuần cộng thêm** — một bảng `product_variants` + một cột `order_items.variant_id` nullable. Đơn cũ không cần chạm vì đã có `unit_price_snapshot`.

- MVP: `products.price` phẳng. Cỡ ly giá khác nhau → khai báo thành **món riêng** cùng category.
- Tuỳ chọn không ảnh hưởng giá (ít đá, ít đường) → `order_items.notes` đã có sẵn.
- Điều kiện duy nhất giữ đường lùi rẻ: **toàn bộ việc giải giá nằm trong một hàm** `resolveLineItemPrice` của `catalog`.
- Ngưỡng xét lại: quá ~15 món phải nhân bản theo cỡ, hoặc xuất hiện topping có tính tiền.

---

## 4. Sự thật mới đưa vào ràng buộc

| # | Sự thật | Hệ quả |
| --- | --- | --- |
| F11 | PayFS ký `timestamp + "." + JSON.stringify(payload sort khóa đệ quy)`; header `X-PayFS-Signature` (hex 64, không tiền tố), `X-PayFS-Timestamp`, hạn 5 phút | D5 |
| F12 | `GET https://api.payfs.vn/v1.1/transactions`, Bearer API Token; API Token và Webhook API Key độc lập | D6, D16 |
| F13 | Payload `transaction.credit` chỉ có `transaction_id`, `amount`, `content`, `bank`, `bank_account_number`, `transaction_date`, `transfer_type` — không có gì trỏ về đơn. Retry tối đa 10 lần, chờ đầu 10s, hệ số 2 | D18, D6 |

---

## 5. Cổng chất lượng được bổ sung

Ngoài 5 test bắt buộc của D14, phiên này thêm hai test **chặn merge**:

6. **Chữ ký webhook** — test vector công bố của PayFS phải cho ra đúng `86f02cef…706c5e`. Đây là bài test rẻ nhất chặn được toàn bộ lỗi canonicalization.
7. **Mã tham chiếu** — regex đối soát chạy trên **giá trị thật do code sinh**, với `content` có rác của ngân hàng bao quanh. Không test trên hằng viết tay.

---

## 5b. Năm mục chủ dự án đã xác nhận (2026-09-19)

| Câu hỏi | Chốt | Ghi vào |
| --- | --- | --- |
| Biến thể món ở MVP? | **Không.** Cỡ ly khác giá → món riêng; tuỳ chọn không tính tiền → `notes` | D19 |
| Nhân viên vào Console bằng cách nào? | **Port hệ thống invitation đầy đủ** của repo mẫu: `owner_invitations`, token digest + HMAC context, TTL 7 ngày, one-time, nới `role CHECK` cho `staff`. Không dùng bản rút gọn "Owner nhập thẳng email" | D20 |
| Tài khoản PayFS? | **Chưa có.** M0–M2 chạy hoàn toàn bằng script tự ký payload; đăng ký + nối ngân hàng trước M4 | D22, O7 |
| Tên miền? | **`workers.dev` cho MVP.** Không hard-code hostname; mọi origin đọc từ biến môi trường | D21, O9 |
| Email? | **Outbox code từ M2, bật gửi thật ở M4.** Bảng + cron + backoff phải có sớm vì enqueue nằm chung batch với chuyển trạng thái; gửi thật chỉ chờ domain verify | D23, O8 |

Phát sinh từ vòng xác nhận này: **D20 lấp một lỗ hổng thật** — D15 nói membership là nguồn sự thật phân quyền nhưng không nói Owner **đầu tiên** vào bảng đó bằng cách nào. Giải bằng `INITIAL_OWNER_EMAIL` (Worker secret) + `store_bootstrap_claims` có `store_id` là PRIMARY KEY, bê nguyên từ repo mẫu.

---

## 6. File đã cập nhật

| File | Thay đổi |
| --- | --- |
| `docs/decisions/260919-post-xia-decision-record.md` | Thêm F11–F13; viết lại D5 và D6; thêm D17, D18, D19; đóng O1–O5 trong bảng "Còn mở", thêm O6; cập nhật "Bước tiếp" |
| `docs/PRD.md` | §2.3.3 (xuất QR theo D17) · §3 (PayFS ký HMAC, cloudflared chỉ dùng một lần) · §5 (`table_secrets`, `payment_reference`, biến thể) · §7 (thêm Webhook Contract Testing) |
| `plans/reports/260919-brainstorm-build-approach.md` | Hợp đồng bàn giao, so sánh 3 phương án thi công, lộ trình M0–M4, bảng rủi ro |

---

## 7. Còn mở sau phiên này

| # | Vấn đề | Chặn cái gì |
| --- | --- | --- |
| O6 | Gói dịch vụ PayFS — OpenBanking miễn phí chỉ 30 giao dịch/tháng, một quán thật vượt trong ngày đầu | Ngày mở bán |
| O7 | Đăng ký PayFS + nối ngân hàng (MB / ACB / OCB) | Smoke test tiền thật ở M4 |
| O8 | Domain gửi email verify trên Resend + email nhận báo cáo + giờ chốt ngày | Bật gửi thật ở M4 |
| O9 | Cutover `workers.dev` → domain thật: sửa đồng bộ OAuth `redirect_uri`, CORS allowlist, cookie domain | Ngày mở bán |
| — | Số tài khoản nhận tiền: một giá trị, **một tên biến duy nhất** dùng chung cho cả sinh QR lẫn đối soát (bài học R6) | Code webhook + storefront |

Không còn mục nào chặn `/ak:plan`.
