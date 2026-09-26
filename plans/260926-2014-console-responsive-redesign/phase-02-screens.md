---
phase: 2
title: "Tailwind cho từng màn hình"
status: completed
effort: 9m
owns: [apps/console/src/kitchen-board.tsx, apps/console/src/menu-admin.tsx, apps/console/src/tables-admin.tsx, apps/console/src/refunds-admin.tsx, apps/console/src/revenue-panel.tsx, apps/console/src/staff-admin.tsx]
dependsOn: [1]
---

# Phase 2 — Tailwind cho từng màn hình

Thứ tự theo ưu tiên demo. Nếu hết giờ, dừng sau bất kỳ màn nào thì giao diện vẫn nhất quán, vì base layer của phase 1 đã giữ cho phần còn lại dùng được.

## Quy tắc

- Chỉ thay `className` và bọc thêm phần tử layout. **Không** đổi text, `role`, `aria-*`, `id`, `htmlFor`, `data-testid`, `data-status`, handler, state.
- Mọi `<button>` → `btn`, thêm `btn-primary` (hành động chính) hoặc `btn-danger` (từ chối/xoá/tắt). Mọi `input/select/textarea` → `field`. Mọi `label` → `mt-3 mb-1 block text-sm font-medium text-slate-600`. Mọi alert lỗi → class alert của phase 1.
- Tiêu đề màn `h1` → `mb-4 text-2xl font-bold tracking-tight`; `h2` trong nhóm → `text-sm font-semibold uppercase tracking-wide text-slate-500`.
- Trạng thái rỗng (text có sẵn, ví dụ "Không có yêu cầu nào đang chờ.") → `card text-center text-sm text-slate-500`. Trạng thái đang tải có sẵn → `text-sm text-slate-500`.
- Lưới thẻ: `grid list-none gap-4 p-0 sm:grid-cols-2 xl:grid-cols-3`.
- Hàng form: `flex flex-col gap-2 sm:flex-row sm:items-end` (con input `sm:flex-1`).
- Hàng nút: `flex flex-wrap gap-2 [&>button]:flex-1 sm:[&>button]:flex-none`.

## Màn hình

1. **Bếp** `kitchen-board.tsx:153-232`
   - Nhóm bàn `mb-6`; danh sách ticket → lưới thẻ.
   - Ticket `li` → `card flex flex-col gap-3 border-l-4` + màu viền theo `data-status` có sẵn: `data-[status=paid]:border-l-brand-600 data-[status=preparing]:border-l-amber-500 data-[status=fulfilled]:border-l-emerald-500`.
   - Header `flex items-center justify-between`; mã đơn `font-mono font-semibold`; badge "Cần chú ý" `rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800`.
   - Danh sách món `space-y-1 text-sm`; ghi chú `text-slate-500 italic`; tổng tiền `text-right text-lg font-bold tabular-nums`.
   - Actions → hàng nút; "Nhận đơn & Chế biến" và nút hoàn tất → `btn-primary`.
   - Khối hoàn tiền và khối giao dịch → `border-t border-dashed border-slate-200 pt-3`.
2. **Menu** `menu-admin.tsx:176-305`
   - `article` danh mục → `card mb-4`; `header` → `flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3`.
   - `li` món → `border-b border-slate-100 py-3 last:border-0`; phần xem → `flex flex-wrap items-center gap-x-3 gap-y-2`, tên `min-w-0 flex-1 font-medium`, giá `font-semibold tabular-nums`, badge "Hết món"/"Đã ẩn" `rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600`, nhóm nút `flex w-full gap-2 sm:w-auto`.
   - Form sửa món, thêm món, thêm danh mục → `grid gap-x-4 sm:grid-cols-2` (nút lưu chiếm `sm:col-span-2`); nút lưu/thêm → `btn-primary`. Khối thêm danh mục → `card`.
   - Thông báo xung đột ("Món đã được sửa ở nơi khác") dùng class alert, nút "Tải lại" `btn`.
3. **Bàn** `tables-admin.tsx:81-128`
   - Danh sách → lưới thẻ; `li` → `card flex flex-col gap-2`; "Bàn N" `text-lg font-semibold`; span trạng thái → pill (`Đang dùng` xanh `bg-emerald-50 text-emerald-700`, `Đã tắt` xám). Chọn màu bằng biểu thức theo `table.isActive` (có sẵn), text giữ nguyên; số QR `text-sm text-slate-500`.
   - Form bàn mới → `card` + hàng form; nút tạo `btn-primary`.
   - Dialog QR → K7: `fixed inset-x-0 bottom-0 z-50 max-h-[90dvh] overflow-auto rounded-t-2xl bg-white p-6 shadow-[0_0_0_100vmax_rgb(0_0_0/.45)] sm:inset-auto sm:top-1/2 sm:left-1/2 sm:w-[min(480px,92vw)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl`; ảnh QR `mx-auto size-56`; URL `break-all rounded-lg bg-slate-50 p-3 font-mono text-xs`; cảnh báo `role="alert"` → `rounded-lg bg-amber-50 p-3 text-sm text-amber-800`; nút đóng `btn w-full mt-4`.
4. **Hoàn tiền** `refunds-admin.tsx:57-107`: danh sách `space-y-3`; `li` → `card`; dòng mã đơn `font-medium`; duyệt `btn-primary`, từ chối `btn-danger`; khối xác nhận từ chối `mt-3 rounded-lg bg-red-50 p-3`.
5. **Doanh thu** `revenue-panel.tsx:41-64`: bọc label + input ngày trong `<div className="max-w-60">`. `dl` → `mt-4 grid gap-4 sm:grid-cols-2`; bọc mỗi cặp `dt/dd` trong `<div className="card">` (hợp lệ HTML trong `<dl>`); `dt` `text-sm text-slate-500`; `dd` `mt-1 text-3xl font-bold tabular-nums`.
6. **Nhân viên** `staff-admin.tsx:71-114`: form mời → `card` + hàng form, nút mời `btn-primary`. Dialog lời mời → cùng class dialog ở mục 3. Danh sách lời mời → `card divide-y divide-slate-100 p-0`, mỗi `li` `px-4 py-3 text-sm [overflow-wrap:anywhere]`.

## Acceptance

- Ở 375px, không màn nào có phần tử tràn ngang; input full-width; mọi nút cao ≥44px.
- Lưới thẻ: 1 cột ở 375px, 2 cột ở 768px, 3 cột ở 1280px (bếp, bàn).
- Dialog QR/lời mời hiển thị đè lên nội dung và đóng được bằng nút "Đóng" hiện có.
- `git diff apps/console/src/*.tsx` chỉ có thay đổi `className` và thẻ bọc layout.
