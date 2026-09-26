---
title: "Phase 10: Cổng ship, email thật & e2e"
phase: 10
status: in-progress
priority: P1
effort: 8h
milestone: M4
dependencies: [5, 9]
---

# Phase 10: Cổng ship, email thật & e2e

## Context

- [Decision Record](../../docs/decisions/260919-post-xia-decision-record.md) — D14, D16, D21, D22, D23, O7, O8, O9
- [Scout 01 — build & test harness](./reports/scout-01-build-and-test-harness.md) — khung CI, khác biệt so với repo mẫu
- [Scout 03 — hợp đồng tiền](./reports/scout-03-payfs-and-money-contracts.md) — shape `/v1.1/transactions` còn mở

## Goal

Khép vòng: CI chặn merge bằng đủ 5 cổng trong đó có **1 e2e luồng tiền**, email gửi thật từ domain đã verify, và một lần chuyển khoản thật đi hết đường ống qua `cloudflared`.

## Overview

Priority P1 · M4 · phụ thuộc phase 5 (đối soát + outbox) và phase 9 (UI). Phase này có **phụ thuộc ngoài repo**: O7 (tài khoản PayFS + nối ngân hàng), O8 (domain Resend đã verify), O9 (quyết định cutover origin). Không phase nào trước đó bị chặn bởi ba mục này.

## Key insights

- Repo mẫu **cố tình** loại `test:e2e` khỏi CI gate vì cần hai server + D1 local. D14 đảo ngược: luồng tiền phải chặn merge. Nếu bước e2e của phase 1 vẫn là placeholder tới đây thì cửa hậu đã mở suốt 9 phase — phase này đóng nó.
- Bật email thật là **đổi biến môi trường**, không sửa logic (D23). Nếu phải sửa code ở bước này thì phase 5 đã làm sai.
- Shape `/v1.1/transactions` mới được xác nhận ở đây (O7). Parser phòng thủ của phase 5 nghĩa là chỉ **một** hàm phải sửa nếu lệch — và test parser phải được cập nhật bằng response **thật** ghi lại, không phải giả định.
- Cutover origin (O9) hỏng ở đúng ba chỗ: Google `redirect_uri`, CORS allowlist, cookie domain. Dấu hiệu là `redirect_uri_mismatch`. Đây là lý do C10 tồn tại từ phase 1.
- `cloudflared` chỉ dùng **một lần** cho smoke test tiền thật, không phải công cụ vòng lặp dev (D22/O2).

## Quyết định thi công chốt tại phase này

| # | Vấn đề | Chốt |
|---|---|---|
| 1 | e2e chạy PayFS thật hay giả | **Giả, deterministic**: e2e trong CI dùng script dev-sign (D22) — không mạng, không phụ thuộc tài khoản. Tiền thật chỉ xuất hiện trong smoke test tay một lần (mục Todo), không trong CI |
| 2 | e2e chạy trên gì | Playwright, hai server local (`dev:console` + `dev:storefront`) + D1 local đã migrate + seed cố định. Một spec duy nhất là cổng chặn merge; spec khác (menu admin, refund) là tuỳ chọn không chặn |
| 3 | Bằng chứng e2e thật sự có tác dụng | Test âm **không chạm code sản phẩm**: chạy spec với dev-sign dùng `--secret` sai → worker trả 401 → màn khách không bao giờ `paid` → spec phải **đỏ**. Tuyệt đối **không** thêm biến kiểu `E2E_MUTATE` làm worker bỏ bước chuyển `paid`: đó là một nhánh "không ghi nhận tiền" nằm sẵn trong đường webhook, chỉ chờ một biến môi trường bị set nhầm ở production |
| 4 | Ai gửi báo cáo doanh thu, giờ nào | `OWNER_REPORT_EMAIL` là secret (C11); giờ chốt ngày là **hằng** `DAILY_REPORT_HOUR_ICT` trong `scheduled.ts` (phase 5), không phải biến môi trường. Chốt giá trị thật khi trả lời O8; không hard-code địa chỉ nhận |
| 5 | Seed e2e không được có Owner/session trong repo (red-team) | `scripts/e2e-seed.ts` **chỉ** insert store/bàn/danh mục/món và một `table_secrets` với digest của token **sinh ngẫu nhiên lúc chạy** (in token thô ra stdout) — không commit token, không commit row `session`, không commit membership Owner. Session Console cho e2e lấy từ `tests/support/console-session.ts` (phase 6) rồi `addCookies`. Script từ chối chạy nếu thiếu `--local` hoặc nếu thấy `CLOUDFLARE_API_TOKEN` trong env (chặn đường gõ thiếu `--local` làm bẩn D1 production) |

## Requirements

- [x] `tests/e2e/money-flow.spec.ts`: quét QR (mở `/t#<token>` do seed sinh) → chọn 2 món → đặt đơn → thấy QR + `paymentReference` → chạy script dev-sign → màn khách chuyển `paid` → màn Console thấy đơn → `preparing` → `fulfilled`
- [x] `playwright.config.ts`: `webServer` khởi hai app, `baseURL` từ env (C10), retry 0 trong CI để không che flake
- [x] `scripts/e2e-seed.ts`: tạo store/bàn/token bàn/danh mục/2 món, in token bàn ra stdout cho spec dùng
- [x] `.github/workflows/ci.yml`: job `verify` = `npm ci → npm run typecheck → npm test (node + workerd + browser) → build:console → build:storefront → test:e2e`, **không** bước nào bị `continue-on-error`
- [x] Bỏ placeholder e2e của phase 1; CI đỏ khi spec đỏ (kiểm bằng quyết định #3)
- [ ] Bật Resend thật: đổi `RESEND_FROM_ADDRESS` sang domain đã verify (O8), `OWNER_REPORT_EMAIL` là secret; **không** sửa logic phase 5
- [ ] Xác nhận shape `/v1.1/transactions` thật (O7): ghi lại một response mẫu **đã ẩn danh** vào `tests/fixtures/payfs/transactions-sample.json` (xoá số tài khoản, tên người chuyển; `content` thay bằng mã `QM…` do test sinh) và cập nhật test parser
- [x] `docs/runbook-cutover.md`: checklist đổi origin **4 chỗ** — Google `redirect_uri`, CORS allowlist, cookie domain, **build lại storefront với `VITE_STOREFRONT_API_BASE_URL` mới** (biến build-time nằm trong bundle nên đổi env server không đủ; Console cùng origin nên không phải build lại) — cộng checklist nạp secret và migration production
- [x] `docs/runbook-smoke-test.md`: quy trình `cloudflared` một lần + gỡ URL tạm + cách rollback
- [ ] **Quét QR bằng app ngân hàng thật** (một lần, tay): mở màn thanh toán của một đơn thật, quét bằng app MB/ACB → app hiển thị đúng số tài khoản, đúng số tiền, đúng nội dung `payment_reference`. Đây là cổng duy nhất chứng minh payload EMVCo đúng với hệ thống thật, không chỉ đúng với chính nó
- [x] Quét bảo mật: không secret trong repo, không hostname literal, không file `.dev.vars*` nào được track ngoài `.dev.vars.example`, fixture PayFS đã ẩn danh

## Architecture

```
CI (pull_request + push main + workflow_dispatch)
├── verify  (chặn merge — D14)
│   1 npm ci + npx playwright install --with-deps chromium   (browser tier của npm test và e2e đều cần)
│   2 npm run typecheck
│   3 npm test                      (node + workerd + browser — gồm secret-scan, import-graph, hostname)
│   4 npm run build:console         (gồm assert import-graph console)
│   5 npm run build:storefront      (gồm assert import-graph storefront)
│   6 npm run test:e2e              (1 spec luồng tiền, dev-sign thay PayFS)
└── deploy  (needs: verify, CHỈ workflow_dispatch cho tới khi production được dựng — commit 56d0400;
            thêm lại `|| github.ref == 'refs/heads/main'` sau khi có D1/R2, database_id, origin thật, secret)
    1 npm run db:migrate:remote     ← trước deploy, cancel-in-progress: false
    2 npm run deploy:storefront     ← trước console: console cần STOREFRONT_ORIGIN tồn tại
    3 npm run deploy:console

Smoke test tiền thật (một lần, tay — O7)
  cloudflared tunnel --url http://127.0.0.1:<port>
  → đăng ký URL trong PayFS Client Portal
  → chuyển khoản thật số tiền nhỏ với nội dung = payment_reference của một đơn thật
  → xác nhận: provider_events có row, đơn paid, email tới hộp Owner
  → gỡ URL webhook tạm, ghi lại kết quả vào docs/runbook-smoke-test.md
```
<!-- Updated: Validation Session 1 - sơ đồ CI khớp .github/workflows/ci.yml sau commit 56d0400 -->

Thứ tự deploy storefront-trước-console là **có chủ đích**: repo mẫu có mâu thuẫn giữa CI (console trước) và README (storefront trước); ở đây Console cần `STOREFRONT_ORIGIN` để dựng CORS allowlist và link QR, nên storefront phải tồn tại trước.

## Files to create / modify

- Create: `tests/e2e/money-flow.spec.ts`, `playwright.config.ts`, `scripts/e2e-seed.ts`
- Create: `docs/runbook-cutover.md`, `docs/runbook-smoke-test.md`
- Create: `tests/fixtures/payfs/transactions-sample.json`
- Modify: `.github/workflows/ci.yml` (bỏ placeholder, thêm job deploy đúng thứ tự)
- Modify: `apps/worker/src/payfs/query-transactions.ts` — cập nhật parser theo shape thật nếu lệch
- Modify: `tests/unit/payfs-transactions.test.ts` — thêm case từ response thật

## Tests Before (viết trước, phải đỏ)

| # | Test | Assert | Dữ liệu vào |
|---|---|---|---|
| T1 | `tests/e2e/money-flow.spec.ts :: luồng tiền đầu-cuối` | Toàn bộ chuỗi trong Requirements chạy xanh trên hai server local | seed cố định |
| T2 | `tests/e2e/money-flow.spec.ts :: đơn nổ về bếp ≤3 giây` | Từ lúc đơn `paid` tới lúc xuất hiện trên màn bếp < 3.5s (biên cho 1 chu kỳ poll) | cùng spec |
| T3 | `tests/node/ci-config.test.ts :: CI có đủ 5 cổng` | Parse `.github/workflows/ci.yml`: job `verify` có đúng thứ tự `typecheck → npm test → build:console → build:storefront → test:e2e`, không bước nào có `continue-on-error` | file thật |
| T4 | `tests/node/ci-config.test.ts :: không còn placeholder e2e` | Script `test:e2e` trong `package.json` gọi `playwright test`, không phải `exit 0` | `package.json` |
| T5 | `tests/node/ci-config.test.ts :: deploy sau verify và sau migrate` | Job `deploy` có `needs: verify`; bước `db:migrate:remote` đứng trước cả hai `deploy:*`; `deploy:storefront` trước `deploy:console` | file thật |
| T6 | `tests/unit/payfs-transactions.test.ts :: parser xử lý response thật` | Parse `transactions-sample.json` (ghi từ API thật) ra danh sách đúng số phần tử và đúng 4 field | fixture thật |
| T7 | `tests/node/secret-scan.test.ts :: không secret trong repo` | Quét toàn repo cho pattern khoá Resend/PayFS/Google client secret, JWT, `whsec_`, `re_` → chỉ khớp trong fixture đã khai báo (allowlist). **Thêm**: fixture PayFS không chứa chuỗi ≥8 chữ số liên tiếp, không có `bank_account_number` giá trị thật, mọi `content` là mã `QM…` do test sinh | cây repo |
| T8 | `tests/node/secret-scan.test.ts :: .dev.vars không được commit` | `.gitignore` chặn `.dev.vars*` kèm ngoại lệ `!.dev.vars.example`; `git ls-files` chỉ trả về `.dev.vars.example`, và file đó không chứa `=` có giá trị | repo |
| T9 | `tests/node/no-hardcoded-hostname.test.ts :: mở rộng cho e2e và runbook` | Không hostname literal trong `tests/e2e/**`, `playwright.config.ts`; runbook được phép nêu ví dụ nhưng phải đánh dấu `<CONSOLE_ORIGIN>` | 3 file |
| T10 | `tests/integration/email-live-config.test.ts :: gửi thật cần cấu hình đủ` | Thiếu `RESEND_FROM_ADDRESS` hoặc `OWNER_REPORT_EMAIL` → job **không** gửi và **không** retire, chỉ log `email_not_configured` (không mất job) | 2 env |

## Refactor / triển khai dưới lưới test

1. `scripts/e2e-seed.ts`: chạy `wrangler d1 execute --local` với SQL seed cố định cho store/bàn/danh mục/món; sinh token bàn bằng CSPRNG **lúc chạy**, insert `table_secrets` với `sha256Hex(token)`, in token thô ra stdout. Từ chối chạy nếu thiếu `--local` hoặc env có `CLOUDFLARE_API_TOKEN`. Không seed Owner/session (spec lấy cookie từ `tests/support/console-session.ts`).
2. `playwright.config.ts`: `webServer` hai entry (`dev:console`, `dev:storefront`) với `reuseExistingServer: !process.env.CI`, `retries: 0`, `baseURL` từ env.
3. `tests/e2e/money-flow.spec.ts`: một spec tuần tự; bước "tiền vào" gọi `scripts/dev/sign-payfs-payload.ts` bằng `child_process` với `payment_reference` đọc từ UI (không đọc DB — e2e phải đi qua đúng đường khách thấy).
4. Cập nhật `ci.yml`: bỏ placeholder e2e, bước 3 là `npm test` (đã gồm `tests/node/**` nên secret-scan/import-graph/hostname thật sự chặn merge), thêm `deploy` job đúng thứ tự (migrate → storefront → console).
5. Bật email thật: nạp `RESEND_FROM_ADDRESS`, `OWNER_REPORT_EMAIL` bằng `wrangler secret put`; chạy một job thật và xác nhận nhận được thư.
6. Ghi `transactions-sample.json` từ một lần gọi API thật (xoá số tài khoản/tên người chuyển), cập nhật parser nếu shape lệch.
7. Viết hai runbook; trong `runbook-cutover.md` liệt kê đúng ba chỗ phải sửa đồng bộ khi đổi origin và cách nhận ra `redirect_uri_mismatch`.

## Tests After

| # | Test | Assert |
|---|---|---|
| A1 | e2e có tác dụng (quyết định #3) | Chạy spec với dev-sign `--secret` sai (worker trả 401, không `paid`) → spec **đỏ**. Không chạm code sản phẩm, không biến môi trường nào tắt được bước ghi nhận tiền |
| A2 | Smoke test tiền thật (tay, một lần — O7) | Một chuyển khoản thật: `provider_events` có row với chữ ký hợp lệ, đơn `paid`, email tới hộp Owner. Ghi kết quả + ảnh chụp vào `docs/runbook-smoke-test.md` |
| A3 | Migration production chạy sạch | `db:migrate:remote` trên D1 production trắng → đủ **5** migration (0001–0005), không lỗi; số bảng đúng: **23** = 14 bảng nghiệp vụ + 5 bảng better-auth + 3 bảng membership/bootstrap/lời mời (0004–0005) + `d1_migrations` <!-- Updated: Cook 2026-09-26 - bản cũ quên 3 bảng của 0004–0005 --> |

## Todo

- [x] T1–T10 viết trước và đỏ (T1/T2 đỏ thật do một bug parse ANSI có thật trong lúc viết; T3–T5 xác nhận đỏ bằng mutation; T6 để trống — cần O7; T7–T10 xanh ngay vì trạng thái repo đã đúng sẵn, không có gì để sửa)
- [x] `scripts/e2e-seed.ts` + `playwright.config.ts`
- [x] `tests/e2e/money-flow.spec.ts`
- [x] Cập nhật `.github/workflows/ci.yml` (bỏ placeholder, thêm deploy)
- [x] A1 (test âm cho e2e: dev-sign sai secret)
- [ ] Chốt O8: domain Resend verified + `OWNER_REPORT_EMAIL` + giờ chốt ngày → nạp secret, gửi thử — **cần tài khoản Resend thật + domain đã verify, ngoài khả năng phiên này**
- [ ] Chốt O7: đăng ký PayFS + nối ngân hàng → ghi `transactions-sample.json`, cập nhật parser + T6 — **cần tài khoản PayFS + ngân hàng thật, ngoài khả năng phiên này**
- [ ] A2 smoke test tiền thật qua `cloudflared`, rồi gỡ URL tạm — **chặn bởi O7**; `docs/runbook-smoke-test.md` đã viết sẵn quy trình, mục "Kết quả" còn trống chờ người có tài khoản PayFS chạy tay
- [x] `docs/runbook-cutover.md` + `docs/runbook-smoke-test.md`
- [x] A3 migration production — chạy 2026-09-26 bằng `npm run db:migrate:remote` từ máy đã `wrangler login`: 5/5 migration ✅, 23 bảng, `stores` có đúng row `store_default` <!-- Updated: Cook 2026-09-26 -->

## Regression gate

```bash
npm run typecheck && npm run test:workerd && npm run build:console && npm run build:storefront && npm run test:e2e
```

Đúng 5 cổng của D14. Đây cũng là nội dung job `verify` — không có phiên bản CI khác với local.

## Success criteria

- [x] T1–T10 xanh (T6 để trống, chờ O7); A1 chứng minh e2e đỏ được; A3 đã chạy trên D1 production; A2 chưa có bằng chứng (chặn bởi O7)
- [x] CI chặn merge bằng đủ 5 cổng, không `continue-on-error`
- [ ] Email gửi thật tới hộp Owner **mà không** sửa logic phase 5 — chặn bởi O8 (chưa có domain Resend verified thật); cơ chế bật (biến môi trường) đã đúng theo D23, không sửa logic
- [ ] Shape `/v1.1/transactions` đã xác nhận bằng response thật (fixture đã ẩn danh) — chặn bởi O7, để trống theo đúng chỉ đạo không giả định
- [x] Không secret, không hostname literal trong repo (T7–T9 xanh, xem `tests/node/secret-scan.test.ts` + `tests/node/no-hardcoded-hostname.test.ts`)
- [x] Hai runbook đủ để người khác cutover và smoke test lại

## Risks

| Rủi ro | Mitigation |
|---|---|
| e2e flake làm team tắt cổng | `retries: 0` + một spec duy nhất + seed cố định; flake phải sửa nguyên nhân, không tăng retry. A1 chứng minh cổng có tác dụng nên không ai dám tắt nhẹ tay |
| O7/O8 chưa xong đúng lúc | Chúng chỉ chặn A2, T6 và bước bật email — 8/10 mục Todo của phase này chạy được không cần chúng |
| Shape `/v1.1/transactions` lệch nhiều hơn parser chịu được | Chỉ một hàm phải sửa (phase 5 quyết định #1); T6 dùng response thật nên lệch lộ ngay |
| Cutover origin làm hỏng OAuth/CORS sau khi đã live | `runbook-cutover.md` liệt kê ba chỗ; C10 bảo đảm không có hostname literal nào phải đi tìm |
| Hạn mức PayFS 30 giao dịch/tháng (O6) | Không chặn kỹ thuật; nêu trong runbook để Owner chốt gói trước ngày mở bán |

## Security

- Quét secret là **cổng CI**, không phải việc làm một lần (T7, T8).
- Smoke test dùng `cloudflared` là URL tạm: gỡ khỏi PayFS Client Portal ngay sau khi xong, ghi vào runbook như một bước bắt buộc.
- Secret production nạp bằng `wrangler secret put`, không qua CI env nếu tránh được; nếu CI cần, dùng GitHub Environment có approval.
- `transactions-sample.json` phải xoá số tài khoản và tên người chuyển trước khi commit.

## Ghi chú thi công (2026-09-26)

- **Cơ chế cô lập** (bắt buộc theo yêu cầu, đã đo): `getPlatformProxy` (dùng trong `scripts/e2e-seed.ts` và `tests/e2e/support/console-session.ts`) chấp nhận `environment` + `persist.path`. Khi truyền `environment: 'e2e'`, `wrangler` tự tìm `.dev.vars.e2e` **trước** `.dev.vars` thật (cùng cơ chế lõi `loadDotDevDotVars` mà cả CLI lẫn `@cloudflare/vite-plugin` dùng) — không cần `CLOUDFLARE_INCLUDE_PROCESS_ENV`. `apps/console/vite.config.ts` được thêm override `persistState.path = process.env.QR_LOCAL_STATE_DIR ?? '../../.wrangler/state'`; `playwright.config.ts` set `CLOUDFLARE_ENV=e2e` + `QR_LOCAL_STATE_DIR=<mkdtemp>` cho webServer console. **Lệch đã phát hiện và bù**: `wrangler d1 migrations apply --persist-to <dir>` và `persistState.path` cùng tự thêm hậu tố `v3/`, nhưng `getPlatformProxy`'s `persist.path` thì **không** — `scripts/e2e-local-persist.ts` (`resolveLocalPersistPath`) là điểm chốt duy nhất chuyển `<dir>` → `<dir>/v3` cho mọi script Node chạm D1 local, để cả ba công cụ đồng ý cùng một thư mục vật lý.
- **Bằng chứng cô lập** (sentinel, chạy thật): tạo `.dev.vars` giả lập ("developer thật") + `.wrangler/state/v3/canary.txt`, chạy trọn `npx playwright test` (happy path xanh, 14s) — cả hai file **byte-for-byte không đổi** sau khi chạy (md5 khớp trước/sau). `.dev.vars.e2e` và `.qr-build/e2e-context.json` (file bàn giao token giữa hai tiến trình Playwright) bị xoá sạch sau mỗi lần chạy, kể cả khi test đỏ.
- **`globalTeardown` không đáng tin cậy với cấu hình này** (đã xác nhận bằng probe cô lập): khi có **hai** `webServer` thật cùng lúc (đặc biệt server console dùng `@cloudflare/vite-plugin`), hook `globalTeardown` của Playwright 1.63 **không bao giờ được gọi** — probe tối giản (1 webServer giả bằng `http.createServer`) thì gọi bình thường; probe với `dev:console` + `dev:storefront` thật thì không, dù server tắt sạch (`Terminated the WebServer` in log) và tiến trình thoát code 0, không lỗi. Đã đổi sang `process.on('exit', teardownE2eEnvironment)` trong `playwright.config.ts` (đăng ký chỉ ở tiến trình main, phân biệt bằng `process.env.TEST_WORKER_INDEX === undefined`) — dọn dẹp đồng bộ, đã kiểm chạy cả khi xanh lẫn khi đỏ (A1).
- **Playwright nạp `playwright.config.ts` hai lần** (tiến trình main không có `TEST_WORKER_INDEX`, tiến trình worker chạy test có) — đã đo bằng probe riêng. `tests/e2e/support/harness.ts` chỉ cho tiến trình main chạy `prepareE2eEnvironment()` (mkdtemp, ghi `.dev.vars.e2e`, migrate, seed — vài giây); tiến trình worker đọc lại kết quả từ `.qr-build/e2e-context.json`. Nhờ vậy migrate/seed chỉ chạy đúng **một** lần mỗi phiên `npx playwright test`, đúng tinh thần "token sinh ngẫu nhiên lúc chạy" của quyết định #5.
- **A1 (quyết định #3) — đã chạy, đỏ đúng như dự đoán**: `QR_E2E_WRONG_PAYFS_SECRET=1 npx playwright test` → worker log `{"event":"payfs_webhook_rejected","status":401,"error":"unauthorized"}`, spec đỏ tại `expect(result.status).toBe(200)` với `Received: 401`. Nhánh rẽ nằm **trong file spec** (`tests/e2e/money-flow.spec.ts`, thuộc `tests/e2e/**`), không chạm `apps/worker` hay `packages/orders` — không có biến `E2E_*` nào trong code sản phẩm.
- **T2 đo thật**: từ lúc nhận HTTP 200 của webhook tới lúc màn bếp hiện ticket — nhiều lần chạy dao động 2.3–2.4s, dưới ngưỡng 3.5s (một chu kỳ poll 3s + biên).
- **T1–T5, T7–T10 đỏ/mutation-check trước khi xanh**: T1/T2 từng đỏ thật vì một bug có thật — `console.log(response.status, …)` của `scripts/dev/sign-payfs-payload.ts` tự tô màu ANSI cho số khi `FORCE_COLOR` bật (môi trường Playwright ở đây luôn bật), làm `Number("\u001b[33m200\u001b[39m")` ra `NaN`; sửa bằng regex bóc ANSI trong `postPayfsWebhook` (chỉ ở test harness, không sửa script dev-sign). T3–T5 (`tests/node/ci-config.test.ts`) xác nhận có tác dụng bằng mutation tay (đổi tên một `run:` step → test đỏ đúng vị trí). T7–T10 xanh ngay lần đầu vì trạng thái repo đã tuân thủ sẵn — không có gì để sửa nên không có pha đỏ thật; đã bù bằng cách kiểm test tự actually-scans-nontrivial-tree.
- **T7 mở rộng phạm vi quét ra ngoài dự kiến**: quét "toàn repo" ban đầu bắt nhầm một chuỗi giống JWT trong `.claude/skills/…` (fixture test của một skill agent khác, không liên quan `qr-menu-app`) — `tests/node/secret-scan.test.ts` loại trừ `.agentkit/`, `.claude/`, `.vitest-attachments/` khỏi phạm vi quét (hạ tầng agent đi kèm checkout, không phải mã nguồn dự án).
- **T8 dùng `git ls-files --cached --others --exclude-standard`** thay vì `git ls-files` trơn: repo trong môi trường thi công phiên này **chưa có commit nào** (`git log` báo "does not have any commits yet"), nên `git ls-files` một mình luôn trả rỗng — cờ `--others --exclude-standard` liệt kê đúng tập file sẽ nằm trong repo (tôn trọng `.gitignore`) bất kể đã commit hay chưa, nên test đúng cả ở đây lẫn ở CI thật (nơi mọi thứ đã được `actions/checkout`).
- **T10 không tạo file trùng lặp với phase 5**: `tests/integration/email-outbox.test.ts` đã có `"keeps jobs untouched when email is not configured"` (thiếu `RESEND_FROM_ADDRESS`). `tests/integration/email-live-config.test.ts` (mới) chỉ thêm phần chưa có: thiếu **`OWNER_REPORT_EMAIL`** một mình, và assert đúng dòng log `email_not_configured`.
- **T6 và fixture PayFS để trống theo đúng chỉ đạo** ("không giả định"): `tests/fixtures/payfs/transactions-sample.json` chưa tồn tại; `tests/node/secret-scan.test.ts` có sẵn hai test kiểm fixture này (không có chuỗi ≥8 chữ số, mọi `content` là mã `QM…`) nhưng tự `skipIf` khi file chưa tồn tại, kèm một test tường minh ghi lại lý do — sẽ tự kích hoạt khi ai đó thêm fixture thật.
- **CI**: job `verify` giữ nguyên bước `test:artifacts` (kiểm tra `apps/console/dist/qr_menu_app/wrangler.json` sau `build:console` — không nằm trong 5 cổng D14 nhưng là gate build-output có thật, không phải scope creep của phase này) ở đúng vị trí cũ (giữa `build:console` và `build:storefront`) — không phá thứ tự 5 cổng D14 mà `tests/node/ci-config.test.ts` kiểm. Bước `npx playwright install --with-deps chromium` ban đầu đặt ngay trước `npm run test:e2e`; CI run đầu tiên đỏ vì tầng browser của `npm test` cũng cần Chromium → commit 56d0400 dời bước này lên ngay sau `npm ci`, đồng thời chuyển job `deploy` sang chỉ chạy tay (`workflow_dispatch`) cho tới khi production được dựng. <!-- Updated: Validation Session 1 - khớp ci.yml hiện tại -->
- **Việc cần user, chưa làm được** (phụ thuộc ngoài repo — O7/O8/A2/quét QR ngân hàng thật): đăng ký PayFS + nối ngân hàng thật (O7 — chặn A2, T6, và fixture PayFS); verify domain Resend + `OWNER_REPORT_EMAIL` + giờ chốt ngày (O8 — chặn bước bật email thật); quét QR bằng app ngân hàng thật (cần đơn thật + app ngân hàng, gộp vào quy trình A2 trong `docs/runbook-smoke-test.md`). A3 đã xong 2026-09-26 (xem Todo). Không mục nào trong số này chặn được kỹ thuật của các mục còn lại — đúng như "Risks" của phase đã lường trước.
- **Origin production tiêm lúc deploy (2026-09-26, có tư vấn kongming):** `docs/next-steps-go-live.md` 6.1 và `runbook-cutover.md` bước 5 từng bảo sửa `vars` trong `wrangler.jsonc` sang origin thật — làm vậy sẽ vỡ cổng e2e (harness chạy trên `127.0.0.1` với `vars` đó, `.dev.vars.e2e` không có origin → Console `origin_denied`, CORS storefront chặn) và vỡ dev local, lại đưa hostname vào repo công khai. Thay bằng `scripts/deploy-worker.ts`: `npm run deploy:*` đọc `CONSOLE_ORIGIN`/`STOREFRONT_ORIGIN` từ môi trường (CI: repository variables, đã đặt), kiểm bằng `scripts/deploy-origins.ts` (bắt buộc `https`, bare origin, không loopback, hai origin khác nhau — `tests/node/deploy-origins.test.ts`), build storefront với `VITE_STOREFRONT_API_BASE_URL = CONSOLE_ORIGIN`, deploy Console với `wrangler deploy --var`. `--dry-run` xác nhận mỗi biến chỉ còn một binding, DB/FILES giữ nguyên. Chuỗi `run:` trong `ci.yml` giữ nguyên (T5 so khớp đúng chuỗi); job `deploy` chỉ chạy khi `workflow_dispatch` **trên `main`**. <!-- Updated: Cook 2026-09-26 -->

## Next

MVP xong theo định nghĩa của D14. Việc sau MVP (không thuộc kế hoạch này): SSE/Durable Object thay polling khi >30 bàn hoạt động (D7), `product_variants` khi >15 món phải nhân bản theo cỡ (D19), cutover domain thật (O9).
