# Việc cần làm để đưa QR Menu lên production (từ bước 3)

Trạng thái lúc viết (2026-09-26): code phase 1–10 đã xong trong repo, CI `verify` xanh đủ 5 cổng (typecheck → `npm test` → build console → build storefront → e2e luồng tiền). Còn lại là các việc cần **tài khoản của bạn**: Cloudflare, Google, Resend, PayFS, ngân hàng.

Làm theo thứ tự. Mỗi bước có mục **Xong khi** để tự kiểm tra.

Tài liệu chi tiết đi kèm:

- `docs/runbook-oauth.md` — tạo Google OAuth client
- `docs/runbook-cutover.md` — đổi origin / deploy / rollback
- `docs/runbook-smoke-test.md` — chuyển khoản thật lần đầu
- `.dev.vars.example` — danh sách tên biến môi trường
- `plans/260919-1418-qr-menu-mvp/` — plan, quyết định và "Ghi chú thi công" từng phase

Trong tài liệu này, `<SUBDOMAIN>` là subdomain `workers.dev` của tài khoản Cloudflare (xem ở Dashboard → Workers & Pages). Hai địa chỉ mặc định sau khi deploy:

- `<CONSOLE_ORIGIN>` = `https://qr-menu-app.<SUBDOMAIN>.workers.dev` (Console + API)
- `<STOREFRONT_ORIGIN>` = `https://qr-menu-storefront.<SUBDOMAIN>.workers.dev` (trang khách quét QR)

---

## Bước 0 — Chuẩn bị máy mới

```bash
git clone https://github.com/johnnybui1911/qr-menu-app.git
cd qr-menu-app
npm ci                           # repo có .npmrc trỏ npm công khai
npx playwright install chromium  # cho test giao diện và e2e
npm test                         # phải xanh: node, workerd, browser
```

Nếu dùng bộ công cụ AI (`/ak:cook`, agent `kongming`): chạy `ak kit init` (thư mục `.claude/` không nằm trong repo).

**Xong khi:** `npm test` xanh trên máy mới.

---

## Bước 3 — Cloudflare: đăng nhập, tạo D1 + R2, migrate

**Trạng thái 2026-09-26: xong.** Đã đăng nhập, D1 `qr-menu-app-db` đã tạo và migrate đủ 5 migration (23 bảng), `database_id` đã ghi trong `wrangler.jsonc`, R2 đã bật và bucket `qr-menu-app-files` đã tạo, `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` đã nạp vào GitHub. Token chỉ kiểm được khi job `deploy` chạy lần đầu.

1. Đăng nhập:

   ```bash
   npx wrangler login
   ```

2. Bật R2 cho tài khoản (Dashboard → R2 → **Enable / Purchase R2**; cần khai phương thức thanh toán, gói miễn phí 10 GB). Chưa bật thì mọi lệnh R2 báo lỗi `10042 Please enable R2 through the Cloudflare Dashboard`. Sau đó tạo bucket ảnh:

   ```bash
   npx wrangler r2 bucket create qr-menu-app-files
   ```

3. (Đã xong) `npx wrangler d1 create qr-menu-app-db` rồi ghi `database_id` vào khối `d1_databases` của `wrangler.jsonc`. Đừng để `d1 create` tự sửa config: nó viết lại cả file và mất chú thích.

4. (Đã xong) Chạy migration lên production:

   ```bash
   npm run db:migrate:remote
   ```

   **Lưu ý:** từ lúc này `0001`–`0005` đã chạy trên production nên không được sửa (C13); đổi schema thì thêm `0006-…`. Ai đã có DB local trước khi có `database_id` thì chạy lại `npm run db:migrate:local` (DB local giờ nằm dưới id mới).

5. Tạo API token cho GitHub Actions: Cloudflare Dashboard → My Profile → API Tokens → Create Token → mẫu **Edit Cloudflare Workers**, thêm quyền **D1: Edit** và **Workers R2 Storage: Edit**. Nạp vào GitHub:

   ```bash
   gh secret set CLOUDFLARE_API_TOKEN
   ```

   `CLOUDFLARE_ACCOUNT_ID` cũng nạp bằng `gh secret set` (giá trị = Account ID ở `npx wrangler whoami`).

**Xong khi:** `npx wrangler r2 bucket list` thấy `qr-menu-app-files` và `gh secret list` có `CLOUDFLARE_API_TOKEN`.

---

## Bước 4 — Google OAuth client

**Trạng thái 2026-09-26: xong.** Client đã tạo; production trả `redirect_uri` đúng `<CONSOLE_ORIGIN>/api/auth/callback/google`.

Chi tiết: `docs/runbook-oauth.md`.

1. Google Cloud Console → APIs & Services → Credentials → **Create OAuth client ID** → loại **Web application**.
2. Khai **hai** cặp origin + redirect URI:

   | Dùng cho | Authorized JavaScript origin | Authorized redirect URI |
   |---|---|---|
   | Dev trên máy | `http://127.0.0.1:5173` | `http://127.0.0.1:5173/api/auth/callback/google` |
   | Production | `<CONSOLE_ORIGIN>` | `<CONSOLE_ORIGIN>/api/auth/callback/google` |

3. Màn hình OAuth consent: nếu để chế độ **Testing**, thêm email chủ quán và nhân viên vào danh sách Test users.
4. Ghi lại **Client ID** và **Client Secret**.

**Xong khi:** có Client ID + Client Secret.

---

## Bước 5 — Chạy thử toàn bộ trên máy với tài khoản thật

1. Tạo file secret cục bộ (file này bị `.gitignore` chặn, không bao giờ commit):

   ```bash
   cp .dev.vars.example .dev.vars
   openssl rand -base64 32   # chạy 2 lần: một cho BETTER_AUTH_SECRET, một cho INVITATION_HMAC_SECRET
   ```

   Điền trong `.dev.vars`:

   | Biến | Giá trị |
   |---|---|
   | `BETTER_AUTH_SECRET` | chuỗi ngẫu nhiên ≥32 ký tự |
   | `INVITATION_HMAC_SECRET` | chuỗi ngẫu nhiên ≥32 ký tự, **khác** `BETTER_AUTH_SECRET` |
   | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | từ bước 4 |
   | `INITIAL_OWNER_EMAIL` | email Google của chủ quán (người đầu tiên đăng nhập bằng email này thành Owner) |
   | `PAYFS_MERCHANT_BANK_BIN` | mã BIN 6 số ngân hàng nhận tiền (MB `970422`, ACB `970416`, OCB `970448`) |
   | `PAYFS_MERCHANT_ACCOUNT` | số tài khoản nhận tiền |
   | `PAYFS_WEBHOOK_API_KEY`, `PAYFS_WEBHOOK_SECRET` | tạm đặt giá trị tự chọn để giả lập thanh toán (bước 8 thay bằng khoá PayFS thật) |
   | các biến còn lại | để trống |

2. Chạy hai server (hai terminal):

   ```bash
   npm run db:migrate:local
   npm run dev:console -- --host 127.0.0.1 --port 5173
   ```

   ```bash
   VITE_STOREFRONT_API_BASE_URL=http://127.0.0.1:5173 npm run dev:storefront -- --host 127.0.0.1 --port 5174
   ```

3. Mở `http://127.0.0.1:5173/console` → đăng nhập Google bằng `INITIAL_OWNER_EMAIL` → phải vào được với quyền Owner.
4. Đăng xuất, thử một tài khoản Google khác → phải bị từ chối.
5. Trong Console: tạo danh mục → món → bàn → **Xuất QR**. Mở link QR (dạng `http://127.0.0.1:5174/t#...`) ở tab khác, đặt thử một đơn, ghi lại **tổng tiền** và **mã tham chiếu `QM…`**.
6. Giả lập tiền về (không cần PayFS):

   ```bash
   echo '{"transfer_type":"credit","transaction_id":"test-1","amount":<TỔNG_TIỀN>,"content":"CT <MÃ_QM>"}' > /tmp/pay.json
   npx tsx scripts/dev/sign-payfs-payload.ts --payload /tmp/pay.json \
     --secret <PAYFS_WEBHOOK_SECRET> --api-key <PAYFS_WEBHOOK_API_KEY> \
     --post http://127.0.0.1:5173/api/payfs/webhook
   ```

**Xong khi:**
- script trả `200 {"outcome":"paid"}`
- màn khách chuyển "Đã thanh toán"
- màn bếp (`/console/kitchen`) hiện đơn trong vài giây
- bấm "Nhận đơn & Chế biến" rồi "Giao món" chạy được

---

## Bước 6 — Deploy lên Cloudflare

**Trạng thái 2026-09-26:** đã deploy tay (Cách B) cả storefront lẫn console lên `workers.dev`. Đã nạp 5/7 secret (5 secret đăng nhập Console); còn `PAYFS_MERCHANT_BANK_BIN` và `PAYFS_MERCHANT_ACCOUNT`, chờ mở tài khoản MB Bank. Cho tới lúc đó đặt đơn trả `503 payment_unavailable`, webhook trả `503 payfs_not_configured`. Đã kiểm trên production:
- preflight CORS từ storefront trả đúng `access-control-allow-origin`, origin lạ không được trả;
- `GET /api/console/session` trả 401 (không phải 503), nghĩa là secret đăng nhập đã đọc được;
- đăng nhập Google chuyển sang `accounts.google.com` với `redirect_uri` production;
- bundle storefront trỏ API production, không còn `127.0.0.1`.

Còn phải chạy job `deploy` trên GitHub Actions ít nhất một lần để kiểm `CLOUDFLARE_API_TOKEN`.

### 6.1 Origin production

Origin thật **không** ghi vào repo (D21). `wrangler.jsonc` giữ giá trị `127.0.0.1` cho dev, e2e và test. Lúc deploy, `npm run deploy:*` (`scripts/deploy-worker.ts`) đọc `CONSOLE_ORIGIN` và `STOREFRONT_ORIGIN` từ biến môi trường rồi:

- build storefront với `VITE_STOREFRONT_API_BASE_URL = CONSOLE_ORIGIN`;
- deploy Console với `wrangler deploy --var CONSOLE_ORIGIN:… --var STOREFRONT_ORIGIN:…`.

Script từ chối deploy nếu thiếu biến, không phải `https`, là địa chỉ loopback, có `/` ở cuối hoặc hai origin trùng nhau.

Trong CI, hai biến này là **repository variables** và đã được đặt sẵn là `<CONSOLE_ORIGIN>` / `<STOREFRONT_ORIGIN>` (kiểm bằng `gh variable list`). Không cần sửa `ci.yml`. Muốn deploy tự động mỗi lần push `main` thì sửa dòng `if:` của job `deploy` theo chú thích ngay trên nó.

### 6.2 Nạp secret production

```bash
./scripts/setup-secrets.sh                   # 5 secret đăng nhập Console (script tự kiểm độ dài, độ khác nhau, cắt khoảng trắng)
npx wrangler secret put PAYFS_MERCHANT_BANK_BIN
npx wrangler secret put PAYFS_MERCHANT_ACCOUNT
```

Lần `secret put` đầu tiên hỏi có tạo Worker `qr-menu-app` không → chọn **Yes** (wrangler tạo một Worker rỗng để giữ secret; `deploy:console` ở bước 6.3 thay code và giữ nguyên secret). Làm bước này ngay trước 6.3, vì trong lúc chờ URL `workers.dev` chỉ trả lỗi.

Kiểm tra: `npx wrangler secret list` thấy đủ tên; `gh secret list` có `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` (bước 3); `gh variable list` có `CONSOLE_ORIGIN` + `STOREFRONT_ORIGIN`.

### 6.3 Deploy

**Cách A — qua GitHub Actions:** tab Actions → workflow `ci` → **Run workflow** trên `main` (job `deploy` chạy migrate → storefront → console).

**Cách B — tay trên máy:**

```bash
export CONSOLE_ORIGIN=<CONSOLE_ORIGIN> STOREFRONT_ORIGIN=<STOREFRONT_ORIGIN>
npm run db:migrate:remote
npm run deploy:storefront
npm run deploy:console
```

Thứ tự **storefront trước console** là bắt buộc.

### 6.4 Sau khi deploy

1. Mở `<CONSOLE_ORIGIN>/console` → đăng nhập bằng email Owner.
2. Nhập menu thật, tạo bàn, **Xuất QR** từng bàn và in ra. QR chỉ hiện **một lần**; phát lại thì QR cũ vẫn dùng được thêm 15 phút.
3. Mời nhân viên: Console → Nhân viên. Link mời chỉ hiện một lần; khi có Resend (bước 7) thì link được gửi qua email.

**Xong khi:** đăng nhập production được, mở link QR của một bàn thấy menu.

---

## Bước 7 — Email thật qua Resend (O8)

1. Tạo tài khoản Resend → **Domains** → thêm domain gửi mail → cấu hình SPF + DKIM trong DNS → chờ trạng thái **Verified**.
2. Tạo API key rồi nạp:

   ```bash
   npx wrangler secret put RESEND_API_KEY
   npx wrangler secret put RESEND_FROM_ADDRESS    # ví dụ: QR Menu <no-reply@domain-cua-ban.vn>
   npx wrangler secret put OWNER_REPORT_EMAIL     # hộp thư nhận báo cáo doanh thu
   ```

3. Giờ gửi báo cáo cuối ngày hiện là **23:00 giờ Việt Nam**, là hằng `DAILY_REPORT_HOUR_ICT` trong `apps/worker/src/order-email-service.ts`. Muốn đổi thì sửa hằng này, commit, deploy lại.

Không cần sửa code: thiếu biến thì hệ thống giữ email trong hàng đợi, không mất.

**Xong khi:**
- mời một nhân viên và nhận được email mời
- duyệt một yêu cầu hoàn tiền và Owner nhận email xác nhận

---

## Bước 8 — PayFS (O7)

1. Chốt gói dịch vụ (O6). Gói miễn phí chỉ **30 giao dịch/tháng**, một quán thật có thể vượt ngay ngày đầu.
2. Đăng ký tài khoản, nối ngân hàng nhận tiền (MB / ACB / OCB). Phải trùng tài khoản đã khai ở `PAYFS_MERCHANT_ACCOUNT`.
3. Lấy **ba** khoá độc lập và nạp. Không dùng một khoá cho hai việc:

   ```bash
   npx wrangler secret put PAYFS_WEBHOOK_API_KEY
   npx wrangler secret put PAYFS_WEBHOOK_SECRET
   npx wrangler secret put PAYFS_API_TOKEN
   ```

4. PayFS Client Portal → khai webhook URL: `<CONSOLE_ORIGIN>/api/payfs/webhook`.
5. Gọi thử API đối soát một lần:

   ```bash
   curl -s https://api.payfs.vn/v1.1/transactions -H "Authorization: Bearer <PAYFS_API_TOKEN>" > /tmp/payfs-transactions.json
   ```

   **Ẩn danh** file (xoá số tài khoản, tên người chuyển; thay `content` bằng mã `QM…` giả), lưu thành `tests/fixtures/payfs/transactions-sample.json`, commit.
   - 2 test đang `skip` (chờ fixture thật) sẽ tự chạy.
   - Nếu cấu trúc response khác dự đoán, chỉ cần sửa hàm `parseTransactions` trong `apps/worker/src/payfs/query-transactions.ts`.
   - Test quét secret sẽ đỏ nếu fixture còn số tài khoản thật (chuỗi ≥8 chữ số).

**Xong khi:** có đủ 3 khoá, webhook URL đã khai, fixture đã commit và `npm test` xanh.

---

## Bước 9 — Chuyển khoản thật lần đầu + quét QR bằng app ngân hàng

Chi tiết: `docs/runbook-smoke-test.md`.

1. Trên storefront production, đặt một đơn nhỏ (ví dụ 10.000 ₫).
2. **Quét QR trên màn thanh toán bằng app ngân hàng thật.** App phải hiển thị:
   - đúng số tài khoản
   - đúng số tiền
   - nội dung chuyển khoản đúng mã `QM…`

   Đây là cách duy nhất chứng minh mã VietQR đúng với hệ thống ngân hàng thật.
3. Chuyển khoản.
4. Ghi kết quả + ảnh chụp vào mục "Kết quả" cuối `docs/runbook-smoke-test.md`, commit.

`cloudflared` chỉ cần khi muốn thử với Worker chạy trên máy; đã deploy thì PayFS gọi thẳng URL production.

**Xong khi:**
- màn khách chuyển "Đã thanh toán"
- màn bếp hiện đơn trong ≤3 giây
- giao dịch được ghi nhận: đăng nhập Console bằng Owner rồi mở `<CONSOLE_ORIGIN>/api/console/provider-events?orderId=<id đơn>` (hoặc `npx wrangler d1 execute DB --remote --command "SELECT outcome, order_id FROM provider_events ORDER BY created_at DESC LIMIT 5"`) thấy một dòng `outcome = paid`

---

## Bước 10 — Kiểm tra cuối trước ngày mở bán

- [ ] CI xanh trên `main`; job `deploy` đã chạy thành công ít nhất một lần.
- [ ] Owner đăng nhập được; tài khoản Google lạ bị từ chối.
- [ ] Nhân viên nhận lời mời và đăng nhập được; nhân viên **không** thấy Menu, Bàn, Hoàn tiền (duyệt), Doanh thu, Nhân viên.
- [ ] QR mọi bàn đã in và quét thử được.
- [ ] Đơn chưa thanh toán tự huỷ sau 30 phút. Cron `*/1` đang chạy: xem Dashboard → Workers → `qr-menu-app` → Logs, có dòng `reconcile_expiry`.
- [ ] Báo cáo doanh thu cuối ngày tới hộp thư Owner (sau 23:00).
- [ ] `npx wrangler secret list` có đủ 13 secret:
  - `BETTER_AUTH_SECRET`
  - `GOOGLE_CLIENT_ID`
  - `GOOGLE_CLIENT_SECRET`
  - `INITIAL_OWNER_EMAIL`
  - `INVITATION_HMAC_SECRET`
  - `PAYFS_MERCHANT_BANK_BIN`
  - `PAYFS_MERCHANT_ACCOUNT`
  - `PAYFS_WEBHOOK_API_KEY`
  - `PAYFS_WEBHOOK_SECRET`
  - `PAYFS_API_TOKEN`
  - `RESEND_API_KEY`
  - `RESEND_FROM_ADDRESS`
  - `OWNER_REPORT_EMAIL`
- [ ] Không commit `.dev.vars`: `git ls-files | grep dev.vars` chỉ ra `.dev.vars.example`.

---

## Bước 11 — Chuyển sang domain riêng (O9, làm sau)

Chi tiết: `docs/runbook-cutover.md`. Phải đổi **đồng bộ 3 chỗ**, thiếu một chỗ là lỗi:

1. Google OAuth: thêm origin + redirect URI mới (giữ URI cũ đến khi chạy ổn).
2. Repository variable `CONSOLE_ORIGIN` (`gh variable set CONSOLE_ORIGIN`).
3. Repository variable `STOREFRONT_ORIGIN` (`gh variable set STOREFRONT_ORIGIN`).

Sau đó chạy lại job `deploy`: storefront được build lại với `VITE_STOREFRONT_API_BASE_URL` mới rồi mới tới console.

Dấu hiệu thiếu:
- `redirect_uri_mismatch` → thiếu mục 1.
- Lỗi CORS trên trang khách → thiếu mục 2 hoặc 3, hoặc chưa deploy lại.

---

## Khi gặp lỗi

| Hiện tượng | Nguyên nhân thường gặp |
|---|---|
| Console báo "Đăng nhập chưa được cấu hình" (503 `auth_not_configured`) | Thiếu một trong 4 secret: `BETTER_AUTH_SECRET` (≥32 ký tự), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `INVITATION_HMAC_SECRET`; hoặc database chưa migrate — xem log Worker có dòng `console_session_failed` |
| Webhook PayFS trả 503 `payfs_not_configured` | Thiếu `PAYFS_WEBHOOK_API_KEY` hoặc `PAYFS_WEBHOOK_SECRET` |
| Webhook trả 401 | Sai API key / sai secret / đồng hồ lệch >5 phút; bản gốc được lưu với `outcome = signature_invalid` để debug |
| Đặt đơn trả 503 `payment_unavailable` | Thiếu hoặc sai `PAYFS_MERCHANT_BANK_BIN` / `PAYFS_MERCHANT_ACCOUNT` |
| Tiền về nhưng đơn không `paid` | Sai số tiền (`amount_mismatch`) hoặc nội dung không có mã `QM…` (`unmatched`). Đơn bị gắn cờ hiện badge trên màn bếp kèm link "Xem giao dịch"; tiền không khớp đơn nào xem qua API `<CONSOLE_ORIGIN>/api/console/provider-events?unmatched=1` (đăng nhập Owner) — **chưa có màn UI riêng** cho danh sách này |
| `npm run dev:console` báo thiếu bảng | Chưa chạy `npm run db:migrate:local` |
