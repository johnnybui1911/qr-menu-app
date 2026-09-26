# Runbook: đăng ký Google OAuth client cho Console

Việc này làm thủ công trên [Google Cloud Console](https://console.cloud.google.com/apis/credentials), không có
API để tự động hoá, và phải làm lại (thêm redirect URI) mỗi lần cutover origin (D21, xem
`docs/runbook-cutover.md` ở phase 10).

## 1. Tạo OAuth client

1. Chọn hoặc tạo project trên Google Cloud Console.
2. **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
3. Application type: **Web application**.
4. Đặt tên gợi nhớ, ví dụ `qr-menu-console`.

## 2. Khai đúng hai cặp origin + redirect URI

Callback path cố định là `/api/auth/callback/google` (đây là endpoint GET duy nhất được mở trong `/api/auth/*`).

| Môi trường | Authorized JavaScript origin | Authorized redirect URI |
|---|---|---|
| Local dev | `http://127.0.0.1:5173` (khớp `CONSOLE_ORIGIN` trong `wrangler.jsonc`, mục `vars` gốc) | `http://127.0.0.1:5173/api/auth/callback/google` |
| Production | `${CONSOLE_ORIGIN}` — repository variable `CONSOLE_ORIGIN` (`gh variable list`) | `${CONSOLE_ORIGIN}/api/auth/callback/google` |

**Không gõ tay hostname vào code hay tài liệu này ngoài bảng trên** (C10, D21): giá trị thật của `CONSOLE_ORIGIN`
production là repository variable của GitHub, được `scripts/deploy-worker.ts` tiêm vào lúc deploy; không lặp lại ở đây, vì domain sẽ đổi khi cutover khỏi `workers.dev`.
Khi cutover, quay lại bước 2 và **thêm** (không thay) origin/redirect URI mới trước khi deploy, để URL cũ vẫn còn
hiệu lực cho tới khi xác nhận URL mới hoạt động.

## 3. Lấy Client ID / Client Secret

Sau khi tạo client, Google hiện đúng một lần: **Client ID** và **Client Secret**. Copy cả hai ngay, không có cách
xem lại Client Secret sau khi đóng dialog (chỉ có thể "Reset secret" để sinh cái mới).

## 4. Nạp vào Worker

Chạy `scripts/setup-secrets.sh` (script không chứa giá trị nào, chỉ hỏi và `wrangler secret put`):

```bash
./scripts/setup-secrets.sh
```

Script sẽ hỏi lần lượt `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `INITIAL_OWNER_EMAIL`,
`INVITATION_HMAC_SECRET` — dán giá trị copy ở bước 3 vào đúng hai dòng `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`.

Cho `wrangler dev` local: copy `.dev.vars.example` thành `.dev.vars` (đã bị `.gitignore` chặn commit) rồi điền
giá trị thật vào 5 dòng Console auth.

## 5. Dấu hiệu lỗi thường gặp

- `redirect_uri_mismatch` từ Google: origin/redirect URI ở bước 2 không khớp tuyệt đối với `CONSOLE_ORIGIN` đang
  chạy — kiểm tra scheme (`http`/`https`), host, và port.
- `503 auth_not_configured` khi bấm đăng nhập: thiếu một trong bốn secret (`BETTER_AUTH_SECRET`,
  `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `INVITATION_HMAC_SECRET`) hoặc `BETTER_AUTH_SECRET` ngắn hơn 32 ký
  tự — chạy lại `scripts/setup-secrets.sh`.
- Đăng nhập thành công nhưng vẫn bị từ chối (`access_denied`): tài khoản Google đó không khớp
  `INITIAL_OWNER_EMAIL` (sau `trim().toLowerCase()`) và không có lời mời hợp lệ đang chờ — không phải lỗi cấu
  hình OAuth.

## 6. Bằng chứng bắt buộc trước khi báo "ready"

Test tự động stub toàn bộ luồng Google (`getUserInfo` không gọi mạng thật). Trước khi báo triển khai xong, phải có
**một** lần đăng nhập Google thật: `INITIAL_OWNER_EMAIL` bootstrap thành công thấy `role: owner`; một tài khoản
Google khác bị từ chối với đúng một thông báo `access_denied`.
