---
title: "Console — thiết kế lại UI bằng Tailwind, responsive cho demo"
description: "Làm lại giao diện trang quản lý (apps/console) bằng Tailwind CSS v4 (@tailwindcss/vite); mobile/tablet/desktop dùng tốt; không đổi logic, text, a11y."
status: completed
priority: P1
effort: 20m
branch: main
tags: [frontend, ui, responsive, tailwind, demo]
blockedBy: []
blocks: []
created: 2026-09-26
---

# Console — thiết kế lại UI bằng Tailwind, responsive cho demo

## Overview

Trang quản lý `apps/console` hiện chỉ có `app.css` 173 dòng CSS tự viết: sidebar đen cố định trong `.console-shell` (`display: flex` theo hàng ngang), **không có media query nào**, danh sách/form dùng style mặc định của trình duyệt. Trên điện thoại, sidebar chiếm nửa màn hình và nội dung bị ép lại.

Mục tiêu: trong **15–20 phút** có giao diện sạch, hiện đại bằng **Tailwind CSS v4**, dùng tốt ở 375px / 768px / 1280px để demo.

Chế độ: `--fast`. Skill thi công: `ak:frontend-development` (giữ stack React 19 + Vite 8; control dùng thẻ semantic, dễ tiếp cận; có trạng thái loading/lỗi/rỗng; kiểm tra trong router thật).

## Quyết định khoá (không mở lại khi cook)

| # | Quyết định | Lý do |
|---|---|---|
| K1 | Tailwind v4: `tailwindcss` + `@tailwindcss/vite` `^4.3.3` ở `devDependencies` gốc (cùng chỗ các build dep khác). Plugin chỉ gắn vào `apps/console/vite.config.ts`, **không** gắn storefront | Người dùng chỉ định Tailwind; peer `vite ^8` hợp lệ; storefront có screenshot test, không được đụng |
| K2 | `app.css` thay toàn bộ bằng `@import "tailwindcss" source("./");` + `@theme` (token màu/font) + `@layer base` (nền control) + `@layer components` gồm đúng 5 lớp lặp nhiều: `.btn`, `.btn-primary`, `.btn-danger`, `.field` (input/select/textarea), `.card`. Còn lại viết utility ngay trong JSX | `source("./")` giới hạn quét class trong `apps/console/src`; 5 lớp component giúp không phải lặp chuỗi utility dài ở 7 file |
| K3 | Không đổi logic, state, API call, text hiển thị, `role`, `aria-*`, `id`/`htmlFor`, `data-testid`, `data-status` | `tests/browser/*.test.tsx` truy vấn bằng role/label/text; đã grep, không test nào dùng className |
| K4 | Chỉ thay `className` và bọc thêm phần tử layout. Không thêm thư viện UI/icon, không tách component mới | Không thêm MUI/shadcn khi stack chưa có (theo skill); diff nhỏ, kịp giờ |
| K5 | Shell: `lg:` (≥1024px) là sidebar trái 240px, sticky. Dưới `lg`, header sticky phía trên + thanh tab cuộn ngang; không dùng hamburger, không thêm JS | Không thêm state thì không thêm bug; mọi mục nav luôn nhìn thấy |
| K6 | Preflight của Tailwind reset `h1/ul/button`, nên **mọi** phần tử hiển thị phải có class. `@layer base` đặt mặc định cho `button`/`input`/`select`/`textarea` (min-h 44px, focus ring) để nút nào sót class vẫn dùng được | Đây là rủi ro lớn nhất khi chuyển sang Tailwind |
| K7 | Dialog QR/lời mời: markup giữ nguyên, chỉ đổi class thành `fixed` + backdrop `shadow-[0_0_0_100vmax_rgb(0_0_0/.45)]`; trên mobile là bottom sheet, `sm:` căn giữa | Không đổi logic đóng/mở |

## Phases

| # | Phase | Files | Thời gian | Status |
|---|---|---|---|---|
| 1 | [Cài Tailwind + token + shell responsive](phase-01-tokens-and-shell.md) | `package.json`, `package-lock.json`, `apps/console/vite.config.ts`, `app.css`, `main.tsx`, `invite-accept.tsx`, `sign-out-button.tsx` | ~7m | completed |
| 2 | [Tailwind cho từng màn hình](phase-02-screens.md) | 6 file màn hình `*.tsx` | ~9m | completed |
| 3 | [Kiểm chứng: build + test + ảnh 3 viewport](phase-03-verify.md) | script tạm (xoá sau) | ~5m | completed |

Chạy tuần tự: phase 2 cần lớp component và token từ phase 1.

## Ngoài phạm vi

Dark mode, icon, đổi thứ tự nav, tính năng mới, refactor/tách component, storefront (`apps/storefront`), i18n.

## Tiêu chí hoàn thành

1. 375px: trang không cuộn ngang; nav là thanh tab cuộn ngang được; mọi nút cao ≥44px; form xếp dọc, full-width.
2. 768px: lưới thẻ 2 cột (bếp, bàn). 1280px: sidebar trái + lưới 3 cột.
3. `npm run typecheck` và `npm run test:browser` đều pass, không sửa test.
4. `npm run build:console` pass (gồm assert import graph); `npm run build:storefront` vẫn pass và không có utility Tailwind trong output.
5. Có ảnh chụp 6 route × 3 viewport làm bằng chứng (không commit ảnh).

## Rủi ro

| Rủi ro | Giảm thiểu |
|---|---|
| Preflight làm mất style ở phần tử sót class | K6 base layer; phase 3 soi ảnh từng route |
| Đổi markup làm vỡ test role/label | K3/K4; chạy `test:browser` ở phase 3 |
| Không đăng nhập được để chụp ảnh (Google OAuth) | Dùng `mintConsoleSession` (`tests/e2e/support/console-session.ts`) giống `tests/e2e/money-flow.spec.ts` |
| Hết giờ | Riêng phase 1 đã sửa lỗi responsive lớn nhất (shell). Phase 2 làm theo thứ tự ưu tiên demo: Bếp → Menu → Bàn → phần còn lại |

## Tiếp theo

`/ak:cook /Users/johnnybui/orca/qr-menu-app/plans/260926-2014-console-responsive-redesign/plan.md`
