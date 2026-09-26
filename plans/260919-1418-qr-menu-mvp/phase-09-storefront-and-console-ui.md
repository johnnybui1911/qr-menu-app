---
title: "Phase 9: UI Storefront & Console"
phase: 9
status: todo
priority: P1
effort: 12h
milestone: M3
dependencies: [3, 7, 8]
---

# Phase 9: UI Storefront & Console

## Context

- [Decision Record](../../docs/decisions/260919-post-xia-decision-record.md) — D1, D3, D7, D13, D17, D21
- [Scout 01 — build & test harness](./reports/scout-01-build-and-test-harness.md) — phân tầng test `browser`, dev hai origin
- [PRD §2.1, §2.2, §2.3](../../docs/PRD.md)

## Goal

Hai SPA dùng được thật: khách quét QR → chọn món → thấy mã VietQR → theo dõi món bằng Secret Link; nhân viên thấy đơn nổ trong ≤3 giây và đẩy trạng thái; Owner quản lý menu, bàn/QR, refund, xem doanh thu.

## Overview

Priority P1 · M3 · phụ thuộc phase 3 (route storefront), 7 (route lệnh Console), 8 (route menu/bàn). Phase này **không** thêm logic nghiệp vụ: mọi quy tắc đã nằm sau API. UI chỉ hiển thị, gom input, và gửi lệnh có `Idempotency-Key`.

## Key insights

- `apps/storefront` khai báo `dependencies` **rỗng** ngoài react (D3) → không import `@qr/*`, kể cả để format tiền. Format VND bằng `Intl.NumberFormat('vi-VN')` cục bộ trên số nguyên server trả về (quyết định #3 của phase 1).
- Token bàn nằm ở **fragment** `#<token>`: SPA đọc `location.hash`, cất vào memory, `history.replaceState` xoá khỏi URL hiển thị, rồi gửi qua header `X-Table-Token` mỗi request. Fragment không tới server nên không vào log (D8, D17).
- Polling 3 giây (D7) chỉ khả thi vì endpoint bếp có cursor `since` + `ETag` (phase 7). Client phải gửi `If-None-Match` và **không** render lại khi 304.
- `Idempotency-Key` do client sinh (`crypto.randomUUID()`), **giữ nguyên qua các lần bấm lại** của cùng một hành động — sinh key mới mỗi lần bấm làm mất hết tác dụng chống trùng.
- Console cùng origin với API nên `fetch(..., {credentials:'same-origin'})`; storefront khác origin nên **không** credentials (F10).

## Quyết định thi công chốt tại phase này

| # | Vấn đề | Chốt |
|---|---|---|
| 1 | Giỏ hàng lưu ở đâu | `sessionStorage` theo `table_token` digest ngắn (không lưu token thô). Mất tab là mất giỏ — đúng với bối cảnh ngồi tại bàn, và tránh giỏ cũ của bàn khác hồi sinh |
| 2 | Secret Link lưu ở đâu | Sau khi đặt đơn, `order_token` cất vào `sessionStorage` **và** hiện URL `…/o#<token>` để khách tự lưu. Đóng tab mà không lưu URL thì mất quyền tra cứu — nêu rõ trên UI |
| 3 | Xử lý đơn hết hạn (30 phút) | Màn chờ thanh toán đếm ngược từ `created_at + 30m`; hết giờ hiện "đơn đã huỷ, vui lòng đặt lại", không tự đặt lại hộ khách |
| 4 | Thư viện UI | Không thêm component library. CSS thuần + `qrcode` (render QR). Lý do: hai SPA nhỏ, thêm design system là thêm bundle và thêm thời gian học không đổi lấy gì ở MVP |
| 5 | Lỗi mạng khi bấm đặt món | Retry cùng `Idempotency-Key`, tối đa 3 lần, backoff 1s/2s/4s; sau đó hiện lỗi kèm nút thử lại **giữ nguyên key** |

## Requirements

**Storefront (`apps/storefront`)**
- [x] `/t#<token>`: đọc fragment → `replaceState` → `GET /api/storefront/menu` với header token
- [x] Danh sách món theo danh mục, ảnh từ `/api/storefront/product-images/:key`, món `is_available=0` hiện "hết món" và không chọn được
- [x] Giỏ: tăng/giảm số lượng, ghi `notes`, hiện tổng do **server** xác nhận lại trước khi thanh toán
- [x] Màn thanh toán: QR render từ `vietqrPayload`, hiện `paymentReference` + số tiền, đếm ngược 30 phút, poll `GET /api/storefront/orders/current` để bắt `paid`
- [x] Màn theo dõi: trạng thái `paid → preparing → fulfilled` với mốc thời gian
- [x] Không import `@qr/*`; không hostname literal; chỉ **một** biến build-time `VITE_STOREFRONT_API_BASE_URL` (storefront khác origin nên cần base URL tuyệt đối). Console **cùng origin** với API (F10) → gọi đường dẫn tương đối `/api/...`, không có biến `VITE_*` nào. Test node khẳng định bundle không chứa `VITE_` nào ngoài allowlist một phần tử (biến build-time bị nướng vào bundle client)

**Console (`apps/console`)**
- [x] Đăng nhập Google (better-auth), nhận lời mời qua `#invite=<token>`
- [x] Màn bếp: poll 3s với `since` + `If-None-Match`, nhóm theo bàn, badge `needs_attention`, nút "Nhận đơn & Chế biến" / "Giao món" / "Yêu cầu hoàn tiền"
- [x] Màn menu (Owner): CRUD danh mục/món, upload ảnh, bật/tắt hết món, hiện `revision` conflict rõ ràng
- [x] Màn bàn (Owner): CRUD bàn, "Xuất QR" hiện QR + URL **một lần** kèm cảnh báo không xem lại được
- [x] Màn refund (Owner): danh sách `pending`, duyệt/từ chối kèm lý do
- [x] Màn doanh thu (Owner): gọi `GET /api/console/revenue?date=` (phase 7), hiện tổng hôm nay, số đơn, số refund; Staff không thấy menu này
- [x] Màn nhân viên (Owner): `staff-admin.tsx` — nhập email + chọn `role`, gọi `POST /api/console/invitations`, hiện link mời **một lần**; danh sách lời mời đang chờ + nút thu hồi; nút thu hồi membership. Không có màn này thì Owner phải `curl` kèm cookie để mời nhân viên (D20)
- [x] UI đọc `allowedActions` từ `GET /api/console/session` để ẩn nút không có quyền (server vẫn là chốt)

## Architecture

```
apps/storefront/src/
├── main.tsx              đọc #token → replaceState → provider giữ token trong memory
├── api-client.ts         fetch không credentials, header X-Table-Token / X-Order-Token
├── menu-screen.tsx       danh mục + món + ảnh
├── cart.tsx              sessionStorage theo bàn, Idempotency-Key ổn định mỗi lần đặt
├── payment-screen.tsx    QR (qrcode) + đếm ngược + poll trạng thái
└── tracking-screen.tsx   paid → preparing → fulfilled

apps/console/src/
├── main.tsx              router + session provider (credentials: same-origin)
├── invite-accept.tsx     đọc #invite= → replaceState → sign-in social
├── kitchen-board.tsx     poll 3s: since + If-None-Match, 304 → không render lại
├── menu-admin.tsx        CRUD + upload ảnh + revision conflict
├── tables-admin.tsx      CRUD bàn + "Xuất QR" một lần
├── refunds-admin.tsx     duyệt/từ chối
├── staff-admin.tsx       mời nhân viên (link một lần) + thu hồi
└── revenue-panel.tsx     doanh thu ngày (GET /api/console/revenue)
```

## Files to create / modify

- Create: 6 file trong `apps/storefront/src/`, 8 file trong `apps/console/src/` (gồm `staff-admin.tsx`)
- Create: `apps/storefront/src/format-money.ts` (Intl, không import `@qr/catalog`)
- Modify: `apps/console/package.json`, `apps/storefront/package.json` — thêm `qrcode` (storefront + console)
- Modify: `package.json` (root) — thêm script `test:browser` vào `npm test` để tầng browser thật sự nằm trong cổng CI
- Modify: `.github/workflows/ci.yml` — không thêm bước mới (bước `npm test` của phase 1 đã gọi `test:browser` sau khi script được nối)
- Create: `vitest.browser.config.ts` nếu phase 1 chưa tạo; `tests/browser/**`

## Tests Before (viết trước, phải đỏ)

Tầng `browser` (React + fetch stub, không D1) trừ khi ghi rõ integration.

| # | Test | Assert | Dữ liệu vào |
|---|---|---|---|
| T1 | `tests/browser/storefront-token.test.tsx :: token rời khỏi URL` | Sau mount với `#abc…`, `location.hash` rỗng, token **không** ở `location.search`, và request đầu tiên có header `X-Table-Token` | hash giả |
| T2 | `tests/browser/storefront-token.test.tsx :: thiếu token → màn lỗi` | Không hash → hiện "Vui lòng quét lại mã QR", không gọi API | — |
| T3 | `tests/browser/storefront-menu.test.tsx :: món hết không chọn được` | Món `isAvailable:false` render disabled + nhãn "hết món"; click không thêm vào giỏ | 2 món |
| T4 | `tests/browser/storefront-cart.test.tsx :: giỏ không gửi giá` | Body request tạo đơn chỉ có `items[{productId,quantity,notes}]` — không `price`, không `total` (kiểm object gửi đi) | giỏ 2 món |
| T5 | `tests/browser/storefront-cart.test.tsx :: Idempotency-Key giữ nguyên khi thử lại` | Request lần 1 fail mạng → retry: **cùng** `Idempotency-Key`; bấm "đặt đơn mới" sau khi thành công → key khác | 3 request |
| T6 | `tests/browser/storefront-cart.test.tsx :: giỏ theo bàn, không rò sang bàn khác` | `sessionStorage` của token A không được đọc khi mount với token B | 2 mount |
| T7 | `tests/browser/storefront-payment.test.tsx :: QR render từ payload server` | Component nhận `vietqrPayload` → gọi `qrcode` với **đúng** chuỗi đó; không tự dựng payload | 1 payload |
| T8 | `tests/browser/storefront-payment.test.tsx :: chuyển màn khi paid` | Poll trả `status:'paid'` → hiện màn theo dõi + Secret Link; không còn QR | 2 poll |
| T9 | `tests/browser/storefront-payment.test.tsx :: hết 30 phút` | `created_at` cách đây 31 phút → hiện "đơn đã huỷ", không hiện QR, không tự tạo đơn mới | 1 đơn |
| T10 | `tests/browser/format-money.test.ts :: format VND từ số nguyên` | `45000` → `"45.000\u00a0₫"` (Intl `vi-VN` chèn **NBSP** trước `₫` — assert bằng `\u00a0`, đừng gõ space thường); không chia 100; không `toFixed` | 3 giá trị |
| T11 | `tests/browser/kitchen-board.test.tsx :: poll 3 giây có cursor` | Sau 3s gọi lại với `since` = cursor lần trước và `If-None-Match` = ETag lần trước | timer giả |
| T12 | `tests/browser/kitchen-board.test.tsx :: 304 không render lại` | Phản hồi 304 → danh sách DOM không đổi (so snapshot node), không nhảy scroll | 2 poll |
| T13 | `tests/browser/kitchen-board.test.tsx :: đơn mới nổi lên trong ≤3s` | Poll thứ hai trả đơn mới → xuất hiện trong DOM, nhóm đúng số bàn | 2 poll |
| T14 | `tests/browser/kitchen-board.test.tsx :: badge needs_attention` | Đơn `needsAttention:true` → có badge; Owner thấy link xem `provider-events`, Staff không | 2 session |
| T15 | `tests/browser/kitchen-board.test.tsx :: nút theo allowedActions` | Session staff không có `refund:decide` → không render nút duyệt refund | 2 session |
| T16 | `tests/browser/menu-admin.test.tsx :: revision conflict hiện rõ` | API trả 409 `revision_conflict` → hiện "món đã được sửa ở nơi khác, tải lại", **không** ghi đè im lặng | 1 request |
| T17 | `tests/browser/tables-admin.test.tsx :: QR chỉ hiện một lần` | Sau khi đóng hộp thoại "Xuất QR", không có đường mở lại token cũ; reload → không còn token trong DOM/state | 1 luồng |
| T18 | `tests/browser/refunds-admin.test.tsx :: duyệt refund cần lý do khi từ chối` | `reject` không có lý do → nút disabled; `approve` gửi `Idempotency-Key` | 2 tương tác |
| T19 | `tests/browser/invite-accept.test.tsx :: token mời rời khỏi URL` | `#invite=…` được đọc rồi `replaceState`; token không còn trong `location` | 1 mount |
| T20 | `tests/node/storefront-bundle.test.ts :: bundle storefront không chứa packages/**` | Chạy assert import-graph cho storefront trên bundle thật → pass; thêm import `@qr/catalog` → fail | build thật |
| T21 | `tests/browser/staff-admin.test.tsx :: Owner mời nhân viên` | Nhập email + `role='staff'` → gọi `POST /api/console/invitations` với body chuẩn hoá; link mời hiện **một lần**, đóng hộp thoại là mất; session staff không render màn này | 3 tương tác |
| T22 | `tests/browser/revenue-panel.test.tsx :: doanh thu đọc từ API` | Panel gọi `GET /api/console/revenue?date=` và render tổng/số đơn/số refund từ response; **không** tự cộng từ danh sách đơn | 1 request |
| T23 | `tests/node/vite-env-allowlist.test.ts :: chỉ một biến VITE_ được phép` | Grep bundle production của hai app: mọi token `VITE_` khớp allowlist `{VITE_STOREFRONT_API_BASE_URL}`; bundle Console không chứa `VITE_` nào; thêm `VITE_SECRET_X` vào source → test đỏ | 2 bundle |

## Refactor / triển khai dưới lưới test

1. `api-client.ts` (mỗi app một bản, không chia sẻ code giữa hai app — D3): storefront lấy base URL từ `import.meta.env.VITE_STOREFRONT_API_BASE_URL` (C10) và **không** credentials; console dùng đường dẫn tương đối `/api/...` + `credentials: 'same-origin'`; một hàm `request()` gắn header token/idempotency và map lỗi HTTP sang object lỗi có `code`.
2. Storefront: provider giữ token trong memory (không `localStorage`); `cart.ts` giữ `Idempotency-Key` trong state của "lần đặt hiện tại", chỉ sinh mới sau khi đơn tạo thành công.
3. `payment-screen.tsx`: render QR bằng `qrcode` từ chuỗi server trả; poll `orders/current` mỗi 3s; đếm ngược tính từ `createdAt`.
4. Console: `kitchen-board.tsx` giữ `{cursor, etag}` trong state, `setInterval(3000)`, bỏ qua 304; nhóm theo `tableNumber`; nút gửi lệnh với `Idempotency-Key` ổn định cho mỗi (đơn, hành động).
5. `menu-admin.tsx`: form gửi `expectedRevision` lấy từ bản đọc gần nhất; upload ảnh bằng `PUT` body nhị phân; hiện tiến trình và lỗi 413/415 rõ ràng.
6. `tables-admin.tsx`: "Xuất QR" mở hộp thoại hiện QR + URL + nút tải ảnh QR (render client), kèm cảnh báo "chỉ hiện một lần"; đóng là mất.
7. `revenue-panel.tsx`: chỉ render khi `allowedActions` có `report:read`.
8. CSS thuần trong mỗi app; không thêm component library (quyết định #4).

## Tests After

| # | Test | Assert |
|---|---|---|
| A1 | `tests/browser/storefront-menu.test.tsx :: ảnh dùng route storefront` | `src` của ảnh trỏ `/api/storefront/product-images/…`, không trỏ R2 URL trực tiếp |
| A2 | Kiểm tay bằng trình duyệt (bắt buộc, ghi lại bằng ảnh chụp) | Hai origin dev chạy song song: quét QR (mở `…/t#<token>` thật) → đặt món → thấy QR → chạy script dev-sign → màn khách đổi sang `paid` **và** đơn hiện trên màn bếp trong ≤3 giây |
| A3 | `tests/browser/kitchen-board.test.tsx :: không rò rỉ timer` | Unmount component → không còn `setInterval` chạy (kiểm bằng fake timer) |

## Todo

- [x] T1–T23 viết trước và đỏ
- [x] `api-client.ts` + `format-money.ts` (storefront)
- [x] Storefront: menu → giỏ → thanh toán → theo dõi
- [x] Console: session + invite-accept
- [x] Console: kitchen board (cursor + ETag + 3s)
- [x] Console: menu admin + upload ảnh
- [x] Console: tables admin + xuất QR
- [x] Console: refunds + revenue panel + staff admin (mời/thu hồi)
- [x] A1–A3 xanh, gồm **A2 kiểm tay trên trình duyệt**

## Regression gate

```bash
npm run typecheck && npm run test:workerd && npm run test:browser && npm run build:console && npm run build:storefront
```

Build phải xanh vì gate import-graph chạy trong `build:*` — đây là chỗ bắt storefront import lậu `@qr/*`.

## Success criteria

- [ ] T1–T23, A1–A3 xanh (A2 có ảnh chụp trong PR)
- [x] Đơn mới xuất hiện trên màn bếp trong ≤3 giây (D7)
- [x] Token bàn/đơn/mời không bao giờ nằm trong URL hiển thị, `localStorage`, hay log
- [x] Bấm đặt món nhiều lần / mất mạng rồi thử lại → đúng một đơn
- [x] Staff không thấy nút Owner; server vẫn từ chối nếu gọi trực tiếp (phase 7/8 đã kiểm)
- [x] Bundle storefront không chứa module `packages/**`

## Risks

| Rủi ro | Mitigation |
|---|---|
| Polling 3s làm màn bếp nhảy/scroll giật | T12 khẳng định 304 không render lại; danh sách dùng `key` theo `order.id` để không remount |
| Client sinh `Idempotency-Key` mới mỗi lần bấm → mất chống trùng | T5 cố định hành vi giữ key khi thử lại |
| Khách mất Secret Link khi đóng tab | UI hiện URL và khuyến nghị lưu; đây là hệ quả đã chấp nhận của D8 (không có tài khoản khách) |
| UI tự tính tiền để hiện nhanh rồi lệch với server | T4 chặn gửi giá; màn xác nhận luôn hiện **tổng do server trả**, không tổng tự tính |
| Thêm component library giữa phase làm phình bundle | Quyết định #4 khoá lại; muốn đổi thì sửa quyết định trước |

## Security

- Token chỉ ở memory/`sessionStorage`, không `localStorage`, không URL hiển thị (D8, D17).
- Console `credentials: same-origin`; storefront **không** credentials → cookie session không bao giờ đi tới origin storefront (F10).
- UI ẩn nút theo `allowedActions` nhưng **không** coi đó là bảo mật: server đã là chốt (phase 6–8).
- Không hostname literal trong hai app (C10, test T6 của phase 1 phủ).

## Ghi chú thi công (2026-09-26)

- Hai agent làm song song (storefront / console, file tách rời); tầng browser dùng Vitest browser mode + Playwright Chromium (`vitest.browser.config.ts`, `vitest-browser-react`), `npm test` = node → workerd → browser. Kết quả: browser 27/27, build hai app + gate import-graph xanh (console không cần `@qr/catalog` — tự format tiền).
- Token đơn (Secret Link) do **client** sinh cùng `Idempotency-Key` cho mỗi lần đặt (phase 3 quyết định #5), giữ nguyên qua các lần thử lại; `/o#<token>` mở lại đơn.
- T23: Vite thay `import.meta.env.VITE_*` bằng giá trị lúc build nên grep bundle không bao giờ thấy tên biến → T23 quét `apps/*/src` theo allowlist (storefront `{VITE_STOREFRONT_API_BASE_URL}`, console rỗng) + fixture chứng minh scanner bắt được tên lạ.
- T18: API `decide` không lưu lý do quyết định (schema không có cột) → màn refund hiện **lý do của nhân viên**, "từ chối" cần bước xác nhận riêng. Màn nhân viên chỉ hiện với `role === 'owner'` (route lời mời không đi qua `evaluatePermission`, nên `allowedActions` không diễn đạt được).
- Storefront agent chạy dev thật và bắt hai bug test không thấy: response không phải JSON (SPA fallback) bị coi là thành công; effect đọc fragment không idempotent dưới StrictMode (lần chạy thứ hai ghi đè màn hình). Cả hai đã sửa.
- **A2 (kiểm tay, 2026-09-26)**: `dev:console` :5173 + `dev:storefront` :5174, D1 local đã migrate + seed, phiên Owner mint bằng `testUtils` của better-auth. Khách (viewport 390×844) mở `/t#<token>` → URL còn `/t` (token đã rời địa chỉ) → thêm 2 cà phê + 1 trà → đặt → màn thanh toán: 85.000 ₫ do server tính, mã `QMEF1KEEBY`, đếm ngược 29:57, 1 ảnh QR, Secret Link. `scripts/dev/sign-payfs-payload.ts --post` → `200 {"outcome":"paid"}`; màn bếp hiện "Bàn 5 · 2× Cà phê sữa đá · 1× Trà đào cam sả" 3,5 s sau khi **khởi động** script (≈0,9 s là tsx + webhook → trong một chu kỳ poll 3 s); màn khách chuyển "Đã thanh toán", QR biến mất. Bếp bấm "Nhận đơn & Chế biến" → "Giao món" → đơn rời màn bếp; màn khách dừng ở bước "Đã giao món"; DB: `fulfilled`, 2 `order_commands`, 1 `provider_payments`. Bằng chứng là văn bản DOM + đo thời gian; **chưa có ảnh chụp** (công cụ screenshot timeout trong phiên headless) → mục "A2 có ảnh chụp trong PR" còn mở.
- A2 lộ hai lỗi thật, đã sửa: (1) `@cloudflare/vite-plugin` đặt state D1 dưới `apps/console/.wrangler` nên `npm run dev:console` chạy trên DB **chưa migrate** — `persistState` giờ trỏ về `.wrangler/state` ở gốc, cùng chỗ `db:migrate:local` ghi; (2) `resolveConsoleSession` nuốt exception thành `auth_not_configured` không log — giờ log `console_session_failed` kèm `incidentId`.

## Next

Phase 10 lấy chính luồng A2 làm e2e chặn merge, bật email thật, và chạy smoke test tiền thật.
