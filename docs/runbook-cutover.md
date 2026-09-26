# Runbook: cutover từ `workers.dev` sang domain thật (O9)

Đây là việc **tay**, làm đúng một lần khi đã sẵn sàng mở bán. Kiến trúc khoá cứng "không hostname literal"
(C10, D21): mọi origin đọc từ biến môi trường, nên cutover chỉ là đổi giá trị biến — không đụng code. Bỏ sót
**bất kỳ** ô nào trong 4 ô dưới đây là nguồn gốc duy nhất của lỗi `redirect_uri_mismatch` hoặc CORS bị chặn sau khi
đã live (xem "Rủi ro" của `plan.md`).

## Bốn chỗ phải đổi đồng bộ

| # | Chỗ | Giá trị cũ | Giá trị mới | Nạp bằng |
|---|---|---|---|---|
| 1 | Google OAuth **Authorized redirect URI** | `http://127.0.0.1:5173/api/auth/callback/google` (dev) | `<CONSOLE_ORIGIN>/api/auth/callback/google` | Google Cloud Console (tay) — **thêm**, không xoá URI cũ cho tới khi xác nhận URI mới chạy (xem `docs/runbook-oauth.md`) |
| 2 | CORS allowlist storefront | `STOREFRONT_ORIGIN` cũ | `<STOREFRONT_ORIGIN>` mới | repository variable `STOREFRONT_ORIGIN` (`gh variable set`) — `scripts/deploy-worker.ts` tiêm vào Worker bằng `wrangler deploy --var` (không phải secret — C11) |
| 3 | Cookie / trusted origin Console | `CONSOLE_ORIGIN` cũ | `<CONSOLE_ORIGIN>` mới | repository variable `CONSOLE_ORIGIN` — tiêm như ô 2 (better-auth `trustedOrigins`/`baseURL` đọc thẳng biến này — `apps/worker/src/auth.ts`) |
| 4 | **Build lại storefront** với `VITE_STOREFRONT_API_BASE_URL` mới | trỏ origin API cũ | trỏ `<CONSOLE_ORIGIN>` mới | tự động: `npm run deploy:storefront` build lại với `VITE_STOREFRONT_API_BASE_URL = CONSOLE_ORIGIN` mỗi lần deploy. Biến nằm trong bundle client nên đổi biến server **không đủ** — phải deploy lại storefront. Console cùng origin với Worker nên **không** cần build lại. |

**Không gõ tay hostname thật vào tài liệu này hay vào code** — `wrangler.jsonc` giữ giá trị `127.0.0.1` cho dev/e2e/test;
origin thật chỉ nằm ở hai repository variable (ô 2, 3), ô 4 suy ra từ ô 3; ô 1 là thao tác tay trên Google Cloud Console.

## Thứ tự thao tác

1. **Google Cloud Console**: thêm origin/redirect URI mới (ô 1) — theo bước 2 của `docs/runbook-oauth.md`. Giữ
   URI cũ sống cho tới khi xong bước 6.
2. **Tiền điều kiện hạ tầng** (nếu chưa có): bật R2 trên Dashboard, `wrangler d1 create qr-menu-app-db` (ghi
   `database_id` vào `wrangler.jsonc`) và `wrangler r2 bucket create qr-menu-app-files` — một lần.
3. **Nạp secret production**: `./scripts/setup-secrets.sh` cho 5 secret Console auth (C11); các secret PayFS/Resend
   nạp riêng bằng `wrangler secret put <TÊN_BIẾN>` — không có script chung vì mỗi secret một mục đích, tránh
   tái dùng chéo (R5/R6).
4. **Migration production**: `npm run db:migrate:remote` — D1 production trắng nhận đủ 5 migration (0001–0005),
   đối chiếu A3: **23 bảng** = 14 bảng nghiệp vụ (0001–0002) + 5 bảng better-auth (0003) + 3 bảng
   membership/bootstrap/lời mời (0004–0005) + `d1_migrations` (đã chạy thật 2026-09-26).
5. **Đổi repository variables** `CONSOLE_ORIGIN`, `STOREFRONT_ORIGIN` sang domain thật (ô 2, 3):
   `gh variable set CONSOLE_ORIGIN --body <CONSOLE_ORIGIN>` (bare origin `https://…`, không `/` cuối — script từ chối nếu sai).
6. **Deploy đúng thứ tự storefront-trước-console** (Console cần `STOREFRONT_ORIGIN` sống để dựng CORS allowlist và
   link QR): chạy job `deploy` trên GitHub Actions (Run workflow trên `main`), hoặc tay:
   ```bash
   export CONSOLE_ORIGIN=<CONSOLE_ORIGIN> STOREFRONT_ORIGIN=<STOREFRONT_ORIGIN>
   npm run deploy:storefront   # ô 4: build lại với VITE_STOREFRONT_API_BASE_URL = CONSOLE_ORIGIN
   npm run deploy:console
   ```
7. **Xác nhận**: đăng nhập Google thật vào Console mới → không `redirect_uri_mismatch`; mở storefront mới →
   `GET /api/storefront/menu` không bị CORS chặn (kiểm DevTools Network, không có lỗi preflight).
8. **Gỡ URI cũ** khỏi Google Cloud Console sau khi bước 7 xanh ổn định (không gỡ ngay — giữ đường lùi).

## Dấu hiệu lỗi thường gặp

- `redirect_uri_mismatch` khi đăng nhập Google: ô 1 chưa khớp tuyệt đối `CONSOLE_ORIGIN` (scheme/host/port) —
  xem mục 5 của `docs/runbook-oauth.md`.
- Storefront gọi API bị chặn CORS (`Access-Control-Allow-Origin` không khớp): ô 2 (`STOREFRONT_ORIGIN`) chưa đổi,
  hoặc đổi rồi nhưng Worker chưa deploy lại.
- Console đăng nhập được nhưng cookie không giữ phiên (mất session sau reload): ô 3 (`CONSOLE_ORIGIN`) lệch với
  origin đang chạy — better-auth `baseURL`/`trustedOrigins` đọc thẳng biến này, không có giá trị fallback.
- Storefront gọi nhầm origin API cũ sau khi đã đổi biến: storefront chưa được deploy lại — biến
  `VITE_STOREFRONT_API_BASE_URL` đã đóng băng trong bundle cũ, phải chạy lại `npm run deploy:storefront`.

## Rollback

Mỗi ô ở trên rollback độc lập bằng cách trả repository variable về giá trị cũ rồi deploy lại theo đúng thứ tự
storefront-trước-console (hoặc `wrangler rollback` cho từng Worker); ô 1 (Google) giữ cả hai URI song song nên
rollback không cần thao tác gì ở đó.
