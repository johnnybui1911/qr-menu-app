# Phase 9 A2 — ảnh chụp luồng hai origin

Ảnh lấy từ screencast của trace Playwright khi chạy `npx playwright test --trace on` (2026-09-26) trên máy local: storefront `127.0.0.1:5174`, Console `127.0.0.1:5173`, D1 local trong thư mục tạm, webhook do `scripts/dev/sign-payfs-payload.ts --post` ký. Đây là cùng một luồng với lần kiểm tay A2 ghi trong "Ghi chú thi công" của phase 9. Kết quả lần chạy: `[T2] kitchen board showed the paid order 2590ms after the webhook's 200 response`, 1 passed.

| Ảnh | Màn |
|---|---|
| `1-khach-menu.jpeg` | Khách mở `/t#<token>` (viewport 390×844) — menu Bàn số 5 |
| `2-khach-thanh-toan-vietqr.jpeg` | Màn thanh toán: 85.000 ₫ do server tính, mã `QM…`, VietQR, Secret Link |
| `3-bep-don-da-thanh-toan.jpeg` | Bếp thấy đơn sau webhook `paid` |
| `4-bep-dang-che-bien.jpeg` | Sau "Nhận đơn & Chế biến" |
| `5-bep-da-giao.jpeg` | Sau "Giao món" — đơn rời bảng bếp |
| `6-khach-da-giao-mon.jpeg` | Màn khách: Đã thanh toán → Đang chuẩn bị → Đã giao món |

Token trong Secret Link ở ảnh 2 và 6 thuộc DB tạm của lần chạy này (đã xoá khi Playwright kết thúc), không dùng được ở đâu khác.
