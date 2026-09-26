---
title: "Cook QR Menu MVP: phần go-live làm được không cần tài khoản mới"
date: 2026-09-26
summary: "Tạo D1 production + migrate (A3), ảnh A2, sửa lỗi doc go-live bằng cơ chế tiêm origin lúc deploy; còn R2 và các tài khoản ngoài"
---

# Cook QR Menu MVP: phần go-live làm được không cần tài khoản mới

> Historical work record — not durable authority. Nguồn sự thật: `plans/260919-1418-qr-menu-mvp/plan.md` (mục "Cook 2026-09-26").

`/ak:cook --advice`. Kongming chạy same-model (host không pin được Fable), tư vấn 2 lần: trước khi chọn thiết kế origin và sau khi làm xong.

## Làm được
- `wrangler` đã đăng nhập sẵn → tạo D1 `qr-menu-app-db`, ghi `database_id`, `db:migrate:remote` 5/5, 23 bảng (A3). Từ giờ 0001–0005 không được sửa (C13).
- Ảnh A2 phase 9: lấy từ screencast trong trace Playwright của lần chạy e2e thật, không dựng lại cảnh.
- Đặt GitHub secret `CLOUDFLARE_ACCOUNT_ID` và repo variables `CONSOLE_ORIGIN`/`STOREFRONT_ORIGIN`.

## Lỗi thật bắt được
- Go-live 6.1 và runbook cutover bảo sửa `vars` origin trong `wrangler.jsonc`. Harness e2e và dev local chạy trên chính các `vars` đó nên cổng e2e sẽ đỏ, và hostname sẽ lọt vào repo công khai. Đổi sang `scripts/deploy-worker.ts`: đọc origin từ env, guard `https`/bare/không loopback, tiêm bằng `wrangler deploy --var`. `--dry-run` cho thấy mỗi biến chỉ còn một binding.
- `wrangler d1 create --update-config` viết lại cả `wrangler.jsonc` và mất chú thích → đã hoàn tác và sửa tay.
- Runbook đếm 20 bảng, thực tế 23: thiếu 3 bảng của 0004–0005.
- `runbook-oauth.md` nhắc tới `env.production`, một block không hề tồn tại.

## Còn mở (cần chủ tài khoản)
Bật R2 + tạo bucket · `CLOUDFLARE_API_TOKEN` · Google OAuth client · email Owner + tài khoản ngân hàng nhận tiền · Resend + domain (O8) · PayFS (O6/O7) · chuyển khoản thật + quét QR · xác nhận `.npmrc`. Thay đổi trong repo chưa commit.

## Cập nhật: R2 và API token
- Chủ tài khoản đã bật R2 và nạp `CLOUDFLARE_API_TOKEN` → tạo bucket `qr-menu-app-files`, phase 1 xong.
- A3: migrate vào D1 local trắng cho ra đúng 23 bảng như remote (22 `CREATE TABLE` + `d1_migrations`), không drift.
- Lần kiểm guard trước in `exit=0` là exit code của pipe. Chạy lại không pipe thì cả `tsx` lẫn `npm run deploy:*` đều exit 1 và không build gì.
