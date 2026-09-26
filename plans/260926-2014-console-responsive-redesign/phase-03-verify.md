---
phase: 3
title: "Kiểm chứng: build + test + ảnh 3 viewport"
status: completed
effort: 5m
owns: [scripts/tmp-console-shots.ts]
dependsOn: [2]
---

# Phase 3 — Kiểm chứng

## Steps

1. `npm run typecheck` → pass.
2. `npm run test:browser` → pass, **không sửa test**. Test truy vấn role/label/text, và K3 giữ nguyên các giá trị đó. Nếu test fail nghĩa là markup bị đổi sai: sửa component, không sửa test. Screenshot test của storefront phải giữ nguyên (storefront không dùng Tailwind).
3. `npm run build:console` → pass (gồm `assert:production-import-graph:console`); CSS trong `apps/console/dist/assets/*.css` có utility (ví dụ `.lg\:grid-cols-`).
4. `npm run build:storefront` → pass; CSS trong output không chứa `tailwindcss` (xác nhận plugin chỉ gắn vào console).
5. **Chụp ảnh thật** bằng script tạm `scripts/tmp-console-shots.ts` (Playwright, chạy bằng `npx tsx`):
   - Dựng server và phiên đăng nhập giống `tests/e2e/money-flow.spec.ts` / `tests/e2e/support/harness.ts`: state tách riêng qua `QR_LOCAL_STATE_DIR`, cookie lấy từ `mintConsoleSession` (`tests/e2e/support/console-session.ts`), role `owner` để thấy đủ 6 route.
   - Seed tối thiểu nếu harness có sẵn (1 danh mục, 2 món, 2 bàn, 1 đơn `paid`) để các màn không trống.
   - Viewport `375x812`, `768x1024`, `1280x800` × route `/console/kitchen|menu|tables|refunds|revenue|staff` → ảnh `fullPage` lưu tại `test-results/console-shots/<route>-<w>.png`.
   - Assert với mọi ảnh: `document.documentElement.scrollWidth <= innerWidth`.
   - Chụp thêm 1 ảnh QR dialog ở `/console/tables` 375px.
6. Xem ảnh (đọc file PNG); phần tử nào mất style do preflight thì thêm class và chụp lại.
7. Xoá `scripts/tmp-console-shots.ts`; không commit ảnh.

## Fallback nếu dựng harness mất hơn 3 phút

Chạy `npm run dev:console`, đăng nhập bằng Google thật trên máy local, chụp tay ở 3 viewport bằng DevTools device mode. Ghi rõ trong báo cáo đây là kiểm tra thủ công.

## Acceptance

- Các lệnh ở bước 1–4 đều pass.
- Có 18 ảnh + 1 ảnh dialog; assert không cuộn ngang pass ở cả 18 ảnh.
- Không còn file tạm trong `scripts/`.
