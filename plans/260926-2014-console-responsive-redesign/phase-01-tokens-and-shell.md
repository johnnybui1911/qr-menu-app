---
phase: 1
title: "Cài Tailwind + token + shell responsive"
status: completed
effort: 7m
owns: [package.json, package-lock.json, apps/console/vite.config.ts, apps/console/src/app.css, apps/console/src/main.tsx, apps/console/src/invite-accept.tsx, apps/console/src/sign-out-button.tsx]
---

# Phase 1 — Cài Tailwind + token + shell responsive

## Context

- `apps/console/vite.config.ts` — plugins `react()`, `cloudflare(...)`, `productionImportGraph('console')`.
- `apps/console/src/app.css` (173 dòng) — sẽ thay toàn bộ.
- `apps/console/src/main.tsx:81-111` `SignInScreen`, `:113-141` `ConsoleRouter`, `:143-168` `ConsoleApp` (màn "không có quyền").
- `invite-accept.tsx:48`, `sign-out-button.tsx:31`.
- `scripts/assert-production-import-graph.ts` bỏ qua `node_modules/` nên Tailwind không vi phạm D3.

## Steps

1. **Cài**: `npm i -D tailwindcss@^4.3.3 @tailwindcss/vite@^4.3.3` (ở gốc repo).
2. **Vite** (`apps/console/vite.config.ts`): `import tailwindcss from '@tailwindcss/vite';` rồi thêm `tailwindcss()` vào `plugins`, ngay sau `react()`. Không sửa `apps/storefront`.
3. **`app.css`**, viết lại toàn bộ:
   ```css
   @import "tailwindcss" source("./");

   @theme {
     --font-sans: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
     --color-brand-50: #eff4ff;  --color-brand-600: #2563eb;  --color-brand-700: #1d4ed8;
   }

   @layer base {
     html { @apply bg-slate-50 text-slate-900 antialiased; }
     button, input, select, textarea { @apply min-h-11; }
     :where(button, a, input, select, textarea):focus-visible { @apply outline-2 outline-offset-2 outline-brand-600; }
     button:disabled { @apply cursor-not-allowed opacity-50; }
     button { @apply cursor-pointer; }
   }

   @layer components {
     .btn { @apply inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-700 shadow-xs hover:bg-slate-50; }
     .btn-primary { @apply border-brand-600 bg-brand-600 text-white hover:bg-brand-700; }
     .btn-danger { @apply border-red-200 text-red-600 hover:bg-red-50; }
     .field { @apply block w-full min-h-11 rounded-lg border border-slate-300 bg-white px-3 text-sm focus:border-brand-600 focus:ring-2 focus:ring-brand-600/20; }
     .card { @apply rounded-xl border border-slate-200 bg-white p-4 shadow-xs; }
   }
   ```
   Label dùng utility tại chỗ: `mt-3 mb-1 block text-sm font-medium text-slate-600`. Khối lỗi `role="alert"` dùng: `rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700`. Giữ nguyên các tên class cũ trong JSX nếu tiện (vô hại), không bắt buộc.
4. **Shell** (`ConsoleRouter`) — thêm brand và phần bọc link; không đổi `href`, `aria-current`, `onClick`, `aria-label`:
   - `div.console-shell` → `min-h-dvh lg:grid lg:grid-cols-[240px_1fr]`.
   - `nav` → `sticky top-0 z-10 grid grid-cols-[1fr_auto] items-center gap-x-3 border-b border-slate-200 bg-white/90 px-4 pt-3 backdrop-blur lg:flex lg:h-dvh lg:flex-col lg:items-stretch lg:border-r lg:border-b-0 lg:p-4`.
   - Brand mới `<div>`: `text-base font-bold text-slate-900 lg:mb-4 lg:px-3` với text "QR Menu".
   - Bọc link: `<div className="col-span-2 row-start-2 -mx-4 flex gap-1 overflow-x-auto px-4 py-2 [scrollbar-width:none] lg:mx-0 lg:flex-col lg:overflow-visible lg:p-0">`.
   - Link: `shrink-0 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 aria-[current=page]:bg-brand-50 aria-[current=page]:text-brand-700`.
   - `console-account` → `flex items-center gap-2 lg:mt-auto lg:flex-col lg:items-stretch lg:border-t lg:border-slate-200 lg:pt-4`; email `max-w-[40vw] truncate text-xs text-slate-500 lg:max-w-none`.
   - `main` → `mx-auto w-full max-w-6xl p-4 sm:p-6 lg:p-8`.
5. **Màn đứng riêng** (`SignInScreen`, màn không có quyền trong `ConsoleApp`, `invite-accept.tsx`): `<main>` → `mx-auto mt-[12vh] w-[min(420px,92vw)] rounded-2xl border border-slate-200 bg-white p-8 shadow-sm`; `h1` → `text-xl font-bold`; `p` → `mt-2 text-sm text-slate-600`; nút đăng nhập → `btn btn-primary mt-6 w-full`.
6. **Sign-out** (`sign-out-button.tsx`): nút → `btn`, trong shell là `min-h-11 px-3`; khối lỗi dùng class alert ở bước 3.

## Acceptance

- `npm run dev:console` khởi động được, CSS Tailwind có hiệu lực (thấy font/màu mới).
- 375px: nav thành header 2 hàng, tab cuộn ngang, trang không cuộn ngang.
- 1280px: sidebar trái sticky, link xếp dọc, phần tài khoản nằm đáy sidebar.
- Không đổi text/aria/href nào.
