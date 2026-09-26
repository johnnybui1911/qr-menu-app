# Runbook: smoke test tiền thật qua `cloudflared` (một lần, tay — O7)

Mục đích: chứng minh một chuyển khoản **thật** đi hết đường ống — ngân hàng → PayFS → webhook đã ký → đơn `paid`
→ email Owner — trước ngày mở bán. `cloudflared` chỉ dùng **một lần** cho việc này, không phải công cụ vòng lặp
dev (D22/O2); CI dùng script dev-sign (`scripts/dev/sign-payfs-payload.ts`), không dùng `cloudflared`.

Không lặp lại thao tác này định kỳ: đây là một cổng chứng minh, không phải quy trình vận hành.

## Điều kiện tiên quyết

- O7 xong: đã đăng ký PayFS + nối ngân hàng (MB/ACB/OCB) thật.
- `wrangler dev` chạy local với 4 secret PayFS thật (`PAYFS_MERCHANT_BANK_BIN`, `PAYFS_MERCHANT_ACCOUNT`,
  `PAYFS_WEBHOOK_API_KEY`, `PAYFS_WEBHOOK_SECRET`) nạp qua `.dev.vars` (không commit).
- Đã đăng nhập PayFS Client Portal, có quyền thêm/xoá webhook URL tạm.
- `RESEND_API_KEY`/`RESEND_FROM_ADDRESS`/`OWNER_REPORT_EMAIL` đã cấu hình để bước cuối (email) kiểm được.

## Quy trình

1. **Khởi động worker local** trỏ D1 local đã migrate + seed một đơn thật (đặt qua storefront local như luồng
   thường): `npm run dev:console -- --host 127.0.0.1 --port 5173` (đã `db:migrate:local` trước đó).
2. **Mở tunnel tạm**: `cloudflared tunnel --url http://127.0.0.1:5173` — ghi lại URL `https://<random>.trycloudflare.com`
   in ra. URL này chỉ sống trong phiên `cloudflared` đang chạy.
3. **Đăng ký URL webhook tạm** trong PayFS Client Portal: `<URL tunnel>/api/payfs/webhook`.
4. **Đặt một đơn thật** trên storefront (local, qua tunnel storefront nếu cần test cả hai chiều, hoặc storefront
   local bình thường — chỉ webhook cần đi qua tunnel). Ghi lại `paymentReference` (`QM…`) hiện trên màn thanh
   toán.
5. **Chuyển khoản thật** số tiền **nhỏ** (vài nghìn đồng, đủ để PayFS ghi nhận) từ app ngân hàng, nội dung chuyển
   khoản **đúng bằng** `paymentReference` ở bước 4. Đây cũng là bước quét QR bằng app ngân hàng thật (mục Todo
   "Quét QR bằng app ngân hàng thật" của phase 10) nếu làm cùng lúc: quét mã QR trên màn thanh toán, xác nhận app
   hiển thị đúng số tài khoản, đúng số tiền, đúng nội dung trước khi bấm xác nhận chuyển.
6. **Chờ webhook thật** từ PayFS gọi vào tunnel (vài giây tới vài phút tuỳ ngân hàng).
7. **Xác nhận theo đúng ba tiêu chí A2** (`plan.md` phase-10):
   - `provider_events` có row mới với `verified = 1` và chữ ký hợp lệ (query D1 local hoặc xem log worker).
   - Đơn chuyển `status = 'paid'` (màn khách tự chuyển màn "Đã thanh toán", hoặc query D1).
   - Email đã tới hộp `OWNER_REPORT_EMAIL` (job outbox `sent`, hoặc nhận thư thật nếu báo cáo ngày trùng giờ chốt).
8. **Chụp ảnh màn hình / lưu log** ba bằng chứng ở bước 7 — dán kết quả vào bảng "Kết quả" bên dưới, kèm ngày giờ
   thực hiện.
9. **Gỡ URL webhook tạm khỏi PayFS Client Portal ngay lập tức** (bước bắt buộc, không được bỏ qua — URL tunnel là
   endpoint công khai không xác thực nguồn ngoài chữ ký PayFS).
10. Đóng phiên `cloudflared` (`Ctrl+C`).

## Rollback / nếu lỗi giữa chừng

- Webhook không tới trong 15 phút: kiểm tra URL đã đăng ký đúng ở bước 3 (không có khoảng trắng/ký tự thừa),
  kiểm `cloudflared` còn sống (log tunnel), kiểm nội dung chuyển khoản đúng `paymentReference`.
- Chữ ký không hợp lệ (`provider_events.verified = 0`): secret PayFS trong `.dev.vars` không khớp secret PayFS
  đăng ký trên Client Portal — không phải lỗi code (test vector chữ ký đã xanh từ phase 4).
- Dù kết quả thế nào, **luôn** làm bước 9 (gỡ URL tạm) trước khi kết thúc phiên.

## Kết quả (điền sau khi chạy)

| Ngày giờ | `transaction_id` | `provider_events.verified` | `orders.status` | Email tới Owner | Ghi chú |
|---|---|---|---|---|---|
| _(chưa chạy — cần O7)_ | | | | | |
