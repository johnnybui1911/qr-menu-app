---
title: "Validate status plan QR Menu MVP so với code"
date: 2026-09-26
summary: "Plan ghi mọi phase Pending/todo dù phase 1-10 đã cài và CI xanh; đồng bộ status theo checkbox, sửa 2 ghi chú CI lỗi thời"
---

# Validate status plan QR Menu MVP so với code

> Historical work record — not durable authority. Nguồn sự thật: `plans/260919-1418-qr-menu-mvp/plan.md` (mục "Validation Log").

## Lệch tìm thấy
- `plan.md` ghi mọi phase `Pending`; 10 phase file ghi `status: todo` (giá trị không có trong schema); 11 success criteria chưa tick — trong khi commit `4cf5731` đã cài phase 1–10.
- Phase 10 mô tả CI cũ: deploy chạy trên `main` và `playwright install` đứng trước `test:e2e`; commit `56d0400` đã đổi cả hai.

## Bằng chứng
- Chạy lại cả 5 cổng trên máy: typecheck sạch · node 57 + 2 skip · workerd 294 · browser 27 · build console/storefront kèm gate import-graph · e2e 1 (bếp thấy đơn 2807 ms).
- Tầng browser cần tải Chromium trước khi chạy trên máy này — đúng nguyên nhân khiến CI đỏ lần đầu.

## Đã sửa (người dùng xác nhận)
- Phase 2, 3, 4, 6, 7, 8 → `completed`; phase 1, 5, 9, 10 → `in-progress` (chỉ còn việc cần tài khoản thật).
- Phase 5 đóng 2 mục đã có quyết định; phase 10 sửa sơ đồ và ghi chú CI.

## Còn mở
- Comment ở `wrangler.jsonc:15` ("Wrangler provisions the database on first deploy") mâu thuẫn với runbook; `docs/next-steps-go-live.md` bước 3 đã hướng dẫn xoá khi điền `database_id`.
