# Scout 01 — Build & Test Harness cho M0 (qr-menu-app)

Nguồn đã đọc: `docs/reference/nexus/00-index.md`, `docs/reference/nexus/01-monorepo-and-build.md` (424 dòng, đọc trọn), `docs/reference/nexus/05-testing-and-dev-workflow.md` (456 dòng, đọc trọn), `docs/reference/nexus/02-d1-data-layer-and-r2.md:575-600` (chỉ đoạn binding JSON, để lấy đúng hình dạng `d1_databases`/`r2_buckets`), `docs/decisions/260919-post-xia-decision-record.md` toàn văn (376 dòng) — trọng tâm D1, D3, D4, D6, D14, D21, D22, D23 và mục C. Mọi trích dẫn `path:line` dưới đây trỏ vào các file tài liệu này (không phải vào repo mẫu `nexus-handson`, repo đó không có trên máy).

Non-goal: business logic orders/catalog/identity, PayFS, better-auth — báo cáo này chỉ dựng khung build/test M0.

---

## Kết luận cho người lập kế hoạch

1. **Bố cục workspace là 3 package + 4 app, khoá bằng `dependencies` rỗng của `apps/storefront`** — đây là D3 (LOCKED), không phải khuyến nghị `packages/core` mà chính tài liệu `01-monorepo-and-build.md:390,406,412,418` gợi ý (khuyến nghị đó dựa trên PRD **cũ**, đã bị D1/D2/D3 thay thế). Dựng đúng `packages/identity`, `packages/catalog`, `packages/orders` ngay từ M0 (`docs/decisions/260919-post-xia-decision-record.md:82-110`).
2. **Một root `wrangler.jsonc`** sở hữu Console+API+D1+R2+cron; **một `wrangler.jsonc` riêng, assets-only** cho storefront — không tạo Wrangler thứ hai cho Console/API (`docs/reference/nexus/01-monorepo-and-build.md:247-262,283-289`).
3. **Deploy Console phải trỏ vào file `wrangler.json` do `@cloudflare/vite-plugin` sinh trong `dist/`**, không bao giờ `wrangler deploy` trần ở root — nguy cơ pick nhầm bundle cũ (`docs/reference/nexus/01-monorepo-and-build.md:297-306`).
4. **Gate `assert-production-import-graph` của SOURCE chỉ phủ Console** (`01-monorepo-and-build.md:141`) — D3 **bắt buộc mở rộng phủ cả Storefront** vì đây đúng là chỗ nguy hiểm nhất (rò logic refund/payment vào bundle khách) (`docs/decisions/260919-post-xia-decision-record.md:106-110`).
5. **Test D1/R2 chạy trong workerd thật** qua `@cloudflare/vitest-pool-workers`, migration reset bằng `DROP TABLE` toàn bộ + apply lại — không dùng transaction rollback (`docs/reference/nexus/05-testing-and-dev-workflow.md:30-48,79-100`).
6. **CI của SOURCE loại `test:browser` và `test:e2e` khỏi gate PR** (`05-testing-and-dev-workflow.md:308-322`) — D14 **đảo ngược quyết định này**: CI TARGET bắt buộc có `typecheck → test:workerd → build:console → build:storefront → 1 e2e luồng tiền` chặn merge (`docs/decisions/260919-post-xia-decision-record.md:226-233`).
7. **Không hard-code hostname** — mọi origin (`CONSOLE_ORIGIN`, `STOREFRONT_ORIGIN`, API base URL) đọc từ biến môi trường; phải có một test khẳng định không còn hostname literal (D21, `docs/decisions/260919-post-xia-decision-record.md:309-315`).
8. **PayFS và Resend đứng sau cổng hẹp, dev không phụ thuộc mạng**: M0–M2 dùng script tự ký payload, email outbox code từ M2 nhưng gửi thật hoãn tới M4 — nghĩa là khung test/CI ở M0 không được giả định có mạng ra ngoài (D22, D23, `docs/decisions/260919-post-xia-decision-record.md:316-333`).
9. **Đừng port `scripts/verification/` + evidence ledger** của SOURCE — Decision Record loại rõ khỏi phạm vi, đây là hạ tầng quy trình của repo mẫu, không phải nhu cầu sản phẩm (`docs/decisions/260919-post-xia-decision-record.md:347`).
10. **Một `tsconfig.json` duy nhất, `noEmit`, không path alias/build step cho package** — package trỏ thẳng `.ts` qua `exports: {"./*": "./src/*.ts"}`, `tsc --noEmit` chạy cho toàn repo (`docs/reference/nexus/01-monorepo-and-build.md:17,150-157,163-176,188`).

---

## Pattern bắt buộc

| Hạng mục | Cách làm cụ thể | Trích dẫn |
|---|---|---|
| npm workspaces | Root `package.json` có `"workspaces": ["apps/*", "packages/*"]`, `"type": "module"`, `"engines": {"node": ">=22"}`. Toàn bộ script (`dev:*`, `build:*`, `test:*`, `deploy:*`) chỉ khai báo ở root; `apps/*/package.json` và `packages/*/package.json` chỉ có `name`/`type`/`dependencies`, không script riêng | `docs/reference/nexus/01-monorepo-and-build.md:150-157,221` |
| Biên giới package | 3 package, trường `exports: {"./*": "./src/*.ts"}`, **không barrel `index.ts`**, không `main`/`types`, không build step. `apps/storefront/package.json` khai báo `dependencies` **rỗng** — đây là lớp cưỡng chế chính | `docs/reference/nexus/01-monorepo-and-build.md:163-189`; `docs/decisions/260919-post-xia-decision-record.md:82-110` (D3) |
| Hướng phụ thuộc | `orders → catalog → identity`, một chiều. `catalog` không bao giờ import `orders`. Package không bao giờ import app. `tables` nằm trong `catalog` (không phải `orders`) | `docs/decisions/260919-post-xia-decision-record.md:82-96` |
| Wrangler Console/API | Một root `wrangler.jsonc`: `main` = `apps/worker/src/index.ts`, `assets.directory` = `./apps/console/dist/client`, `assets.not_found_handling` = `single-page-application`, `assets.run_worker_first` = `["/api","/api/*"]`, bindings `DB` (D1) + `FILES` (R2), `triggers.crons` | `docs/reference/nexus/01-monorepo-and-build.md:247-269`; `docs/reference/nexus/02-d1-data-layer-and-r2.md:583-596` |
| Wrangler Storefront | `apps/storefront/wrangler.jsonc` riêng, chỉ `assets.directory` + `not_found_handling: single-page-application`, **không `main`, không binding nào** — tên Worker truyền qua `--name` lúc deploy, không ghi trong file | `docs/reference/nexus/01-monorepo-and-build.md:283-289` |
| Sinh config lúc build | `@cloudflare/vite-plugin` build Console: đọc root `wrangler.jsonc`, chọn nhánh `env.production` (biến `CLOUDFLARE_ENV`), phẳng hoá thành `apps/console/dist/<worker-name-normalized>/wrangler.json` đã resolve `main`+`assets.directory` trỏ đúng bundle đã build. Deploy phải trỏ vào file này, **không** `wrangler deploy` trần ở root | `docs/reference/nexus/01-monorepo-and-build.md:294-306` |
| Cron | `triggers.crons` là mảng chuỗi cron pattern; SOURCE chỉ có `*/5 * * * *` cho email outbox. TARGET cần **2 pattern**: `*/1 * * * *` (đối soát PayFS, D6) + `*/5 * * * *` (email outbox, D12/D23) | `docs/reference/nexus/04-payfs-webhook-and-business-contracts.md:1473-1476` (hình dạng JSON); `docs/decisions/260919-post-xia-decision-record.md:` mục D6 (ngưỡng 2/15/30 phút) và D23 (cron `*/5`) |
| Vitest workerd | `cloudflareTest({ miniflare: { compatibilityDate, d1Databases: ['DB'], r2Buckets: ['FILES'] } })`, `test.include` gồm `tests/unit/**/*.test.ts` + `tests/integration/**/*.test.ts`, `testTimeout: 30_000` | `docs/reference/nexus/05-testing-and-dev-workflow.md:30-48` |
| Reset D1 giữa test | `beforeEach` gọi hàm `resetDb()`: `DROP TABLE IF EXISTS` toàn bộ bảng nghiệp vụ **và cả `d1_migrations`**, rồi `applyD1Migrations(env.DB, migrations.slice(0, through))` — không dùng transaction rollback | `docs/reference/nexus/05-testing-and-dev-workflow.md:79-100,103,109` |
| Migration theo mốc | Hàm reset nhận tham số `through` để apply migration tới mốc N, ghi dữ liệu, apply N+1, khẳng định dữ liệu cũ còn nguyên — dùng để test schema-change không phá dữ liệu cũ | `docs/reference/nexus/05-testing-and-dev-workflow.md:82-84,107` |
| 4 lớp test | `unit` (logic thuần, không D1) / `integration` (D1+R2+HTTP thật trong workerd) / `browser` (React contract, fetch stub) / `e2e` (Playwright 2 origin thật). `fixtures/`, `support/` chỉ là helper, **không đưa vào discovery** | `docs/reference/nexus/05-testing-and-dev-workflow.md:14-22` |
| Gate import-graph | Vite plugin `apply: 'build'`, hook `generateBundle` lấy `Object.keys(output.modules)` (module **thực sự** vào bundle, không phải khai báo tĩnh), chuẩn hoá path, ghi JSON `{modules:[...]}`. Script assert đọc JSON, kiểm sanity path, áp regex forbidden, kiểm liveness anchor (phải có `apps/console/src/main.tsx` tương ứng `apps/console/src/main.tsx` cho console), rồi `finally` luôn xoá file metadata dù có throw | `docs/reference/nexus/01-monorepo-and-build.md:101-139` |
| Mở rộng gate cho storefront (D3) | SOURCE storefront có plugin thu thập (`apps/storefront/vite.config.ts:12-43` theo tài liệu) nhưng **không có script assert nào đọc** — TARGET phải thêm bước assert cho storefront, và storefront không được chứa **bất kỳ** module `packages/**` nào (vì storefront phải HTTP-only tuyệt đối) | `docs/reference/nexus/01-monorepo-and-build.md:141,424`; `docs/decisions/260919-post-xia-decision-record.md:106-110` |
| Dev 2 origin | 2 terminal: `npm run dev:console -- --host 127.0.0.1 --port 5173` và `VITE_STOREFRONT_API_BASE_URL=http://127.0.0.1:5173 npm run dev:storefront -- --host 127.0.0.1 --port 5174`. Port không hard-code trong vite config, chỉ `strictPort: true` | `docs/reference/nexus/01-monorepo-and-build.md:228-236` |
| Không hard-code hostname (D21) | Mọi origin (`CONSOLE_ORIGIN`, `STOREFRONT_ORIGIN`, `VITE_STOREFRONT_API_BASE_URL`) đọc từ biến môi trường, một tên biến cho một origin; cần một test grep toàn source/build-input để khẳng định không còn hostname legacy | `docs/decisions/260919-post-xia-decision-record.md:309-315` |
| CI gate (D14, khác SOURCE) | SOURCE: `verify` = `npm ci → test:workerd → build:console → build:storefront:production`, không có e2e (`05-testing-and-dev-workflow.md:308-322`). TARGET **phải thêm** bước e2e luồng tiền vào gate PR, không được đẩy ra ngoài như SOURCE | `docs/reference/nexus/05-testing-and-dev-workflow.md:308-322`; `docs/decisions/260919-post-xia-decision-record.md:226-233` (D14) |
| CI deploy job | `needs: verify`, chạy `migrate:production` (remote) **trước** `deploy:console`/`deploy:storefront`, `concurrency.cancel-in-progress: false` vì có migration remote đang chạy dở không được huỷ | `docs/reference/nexus/01-monorepo-and-build.md:312-315` |
| PayFS/Resend không chặn dev (D22, D23) | M0–M2: PayFS mô phỏng bằng script tự ký payload theo công thức HMAC F11 (`timestamp + "." + JSON.stringify(sortKeysRecursive(payload))`), chạy được trong CI không cần mạng; email outbox code từ M2 nhưng gửi Resend thật hoãn tới M4 (đổi biến môi trường, không sửa logic) | `docs/decisions/260919-post-xia-decision-record.md:` D22 (dòng ~316-321), D23 (dòng ~323-333) |

---

## Hình dạng file/config/SQL cần tạo

Mọi đường dẫn dưới đây là đích trong `qr-menu-app/`. Tên tài nguyên cụ thể (`database_name`, `bucket_name`, Worker `name`) **không có trong Decision Record** — dùng placeholder theo tên thư mục repo, đánh dấu `[SUY LUẬN]`, cần chốt trước khi chạy `wrangler d1 create` thật (xem Câu hỏi còn mở #1).

### `package.json` (root)
```json
{
  "name": "qr-menu-app",
  "private": true,
  "type": "module",
  "workspaces": ["apps/*", "packages/*"],
  "engines": { "node": ">=22" },
  "scripts": {
    "dev:console": "vite --config apps/console/vite.config.ts",
    "dev:storefront": "vite --config apps/storefront/vite.config.ts",
    "typecheck": "tsc --noEmit",
    "test": "npm run test:workerd && npm run test:browser",
    "test:workerd": "vitest run",
    "test:unit": "vitest run tests/unit",
    "test:integration": "vitest run tests/integration",
    "test:browser": "vitest run --config vitest.browser.config.ts",
    "test:e2e": "playwright test",
    "build:console": "npm run typecheck && vite build --config apps/console/vite.config.ts && npm run assert:production-import-graph:console",
    "build:storefront": "vite build --config apps/storefront/vite.config.ts && npm run assert:production-import-graph:storefront",
    "assert:production-import-graph:console": "tsx scripts/assert-production-import-graph.ts --target console",
    "assert:production-import-graph:storefront": "tsx scripts/assert-production-import-graph.ts --target storefront",
    "db:migrate:local": "wrangler d1 migrations apply <DB_NAME> --local",
    "db:migrate:remote": "wrangler d1 migrations apply <DB_NAME> --remote --env production",
    "deploy:console": "CLOUDFLARE_ENV=production npm run build:console && wrangler deploy --config apps/console/dist/<worker_name_normalized>/wrangler.json",
    "deploy:storefront": "npm run build:storefront && wrangler deploy --config apps/storefront/wrangler.jsonc --name <storefront-worker-name>"
  }
}
```
Gốc pattern: `docs/reference/nexus/01-monorepo-and-build.md:150-157,196-219`; phần `assert:production-import-graph:storefront` là **mở rộng theo D3**, không tồn tại nguyên văn trong SOURCE (`01-monorepo-and-build.md:141`).

### `apps/storefront/package.json` — biên giới cưỡng chế chính
```json
{
  "name": "storefront",
  "private": true,
  "type": "module",
  "dependencies": {
    "react": "^19",
    "react-dom": "^19"
  }
}
```
**Không** liệt kê `@qr/*` nào. Đây là lớp chính chặn import sai (`docs/decisions/260919-post-xia-decision-record.md:106-107`; mẫu hình dạng `docs/reference/nexus/01-monorepo-and-build.md:163-176`).

### `packages/identity/package.json`, `packages/catalog/package.json`, `packages/orders/package.json`
```json
// packages/identity/package.json — đáy, không dependencies
{ "name": "@qr/identity", "version": "0.0.0", "private": true, "type": "module",
  "exports": { "./*": "./src/*.ts" } }

// packages/catalog/package.json
{ "name": "@qr/catalog", "version": "0.0.0", "private": true, "type": "module",
  "exports": { "./*": "./src/*.ts" },
  "dependencies": { "@qr/identity": "0.0.0" } }

// packages/orders/package.json
{ "name": "@qr/orders", "version": "0.0.0", "private": true, "type": "module",
  "exports": { "./*": "./src/*.ts" },
  "dependencies": { "@qr/catalog": "0.0.0", "@qr/identity": "0.0.0" } }
```
Mẫu `exports` wildcard: `docs/reference/nexus/01-monorepo-and-build.md:163-176`. Chiều phụ thuộc + nội dung mỗi package: `docs/decisions/260919-post-xia-decision-record.md:82-91` (bảng D3). Chốt dùng version tag nhất quán `"0.0.0"` (không trộn `file:../x` như SOURCE — SOURCE tự nhận không nhất quán vô hại nhưng không có lý do để lặp lại, `01-monorepo-and-build.md:189`).

### `apps/worker/package.json`
```json
{ "name": "worker", "private": true, "type": "module",
  "dependencies": { "@qr/identity": "0.0.0", "@qr/catalog": "0.0.0", "@qr/orders": "0.0.0" } }
```
`docs/reference/nexus/01-monorepo-and-build.md:86` (bảng biên giới `apps/worker`).

### `apps/console/package.json` — chỉ khai báo `@qr/catalog` theo đúng luật "Console consumes catalog only"
```json
{ "name": "console", "private": true, "type": "module",
  "dependencies": { "@qr/catalog": "0.0.0", "react": "^19", "react-dom": "^19" } }
```
`docs/reference/nexus/01-monorepo-and-build.md:69,87`. Lưu ý: bảng D3 gốc chỉ nói `catalog` là package duy nhất Console "consume"; UI type của Order phải giữ trong `apps/console` (không import `@qr/orders`) — đúng luật `AGENTS.md:16` được trích tại `docs/reference/nexus/01-monorepo-and-build.md:69`.

### `tsconfig.json` (root, một file duy nhất)
```jsonc
{
  "compilerOptions": { "noEmit": true, /* strict, target, module theo Wrangler type-gen */ },
  "include": ["apps", "packages", "scripts", "tests", "worker-configuration.d.ts"]
}
```
Một tsconfig cho cả repo, không path alias: `docs/reference/nexus/01-monorepo-and-build.md:17,188`.

### `wrangler.jsonc` (root — Console + API)
```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "qr-menu-app", // [SUY LUẬN] tên chưa chốt, xem Câu hỏi còn mở
  "main": "apps/worker/src/index.ts",
  "compatibility_date": "<ngày hiện tại lúc khởi tạo M0>",
  "workers_dev": true,
  "assets": {
    "binding": "ASSETS",
    "directory": "./apps/console/dist/client",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api", "/api/*"]
  },
  "d1_databases": [
    { "binding": "DB", "database_name": "qr-menu-app-db", "database_id": "<sinh bởi wrangler d1 create>" }
  ],
  "r2_buckets": [
    { "binding": "FILES", "bucket_name": "qr-menu-app-files" }
  ],
  "triggers": { "crons": ["*/1 * * * *", "*/5 * * * *"] },
  "vars": { "CONSOLE_ORIGIN": "<đọc từ env, không hard-code>", "STOREFRONT_ORIGIN": "<đọc từ env>" }
}
```
Khung `assets`+`run_worker_first`: `docs/reference/nexus/01-monorepo-and-build.md:247-269`. Hình dạng `d1_databases`/`r2_buckets`: `docs/reference/nexus/02-d1-data-layer-and-r2.md:583-596`. Hình dạng `triggers.crons`: `docs/reference/nexus/04-payfs-webhook-and-business-contracts.md:1473-1476` (SOURCE chỉ có 1 pattern; TARGET cần 2 theo D6+D23). Không hard-code hostname trong `vars`: `docs/decisions/260919-post-xia-decision-record.md:314` (D21).

### `apps/storefront/wrangler.jsonc`
```jsonc
{
  "$schema": "../../node_modules/wrangler/config-schema.json",
  // Tên Worker truyền qua --name lúc deploy, không ghi ở đây
  "compatibility_date": "<khớp root>",
  "workers_dev": true,
  "assets": { "directory": "./dist", "not_found_handling": "single-page-application" }
}
```
`docs/reference/nexus/01-monorepo-and-build.md:283-289`.

### `scripts/assert-production-import-graph.ts`
Xương sống thuật toán (mở rộng D3 để nhận `--target console|storefront`):
```ts
const FORBIDDEN_ALWAYS = /(^|\/)design\/|prototype|scenario|(^|\/)fixtures?\//i; // giữ nguyên tinh thần SOURCE
const FORBIDDEN_STOREFRONT = /^packages\//; // D3: storefront tuyệt đối không được chứa module @qr/* nào
const LIVENESS_ANCHOR: Record<'console' | 'storefront', string> =
  { console: 'apps/console/src/main.tsx', storefront: 'apps/storefront/src/main.tsx' };

// đọc metadata JSON tương ứng target, kiểm sanity path (không absolute, không '..', không '\\'),
// áp FORBIDDEN_ALWAYS cho cả hai target, áp thêm FORBIDDEN_STOREFRONT khi target === 'storefront',
// kiểm graph có chứa LIVENESS_ANCHOR[target], rồi finally luôn xoá file metadata dù throw.
```
Thuật toán gốc (4 bước + finally xoá file): `docs/reference/nexus/01-monorepo-and-build.md:127-139`. Lý do storefront cần forbidden riêng và phải chạy assert (SOURCE bỏ trống): `docs/reference/nexus/01-monorepo-and-build.md:141,424`; `docs/decisions/260919-post-xia-decision-record.md:106-110`.

### `vitest.config.ts` (root)
```ts
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [cloudflareTest({ miniflare: {
    compatibilityDate: '<khớp wrangler.jsonc>',
    d1Databases: ['DB'],
    r2Buckets: ['FILES'],
  } })],
  test: { include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'], testTimeout: 30_000 },
});
```
Nguyên bản: `docs/reference/nexus/05-testing-and-dev-workflow.md:30-48`.

### `tests/cloudflare-test-env.d.ts`
```ts
declare module 'cloudflare:test' {
  interface ProvidedEnv { DB: D1Database; FILES: R2Bucket }
}
```
Mẫu: `docs/reference/nexus/05-testing-and-dev-workflow.md:` mục 1 (dòng mô tả `tests/cloudflare-test-env.d.ts:1-6`, trong bảng phân tầng dòng 18-19).

### `tests/support/test-env.ts`
Xương sống hàm reset:
```ts
export async function resetDb(through = LATEST_MIGRATION): Promise<void> {
  const tables = [/* toàn bộ bảng nghiệp vụ của qr-menu-app: categories, products, tables,
    table_secrets, orders, order_items, order_idempotency, provider_events, provider_payments,
    order_email_jobs, refund_requests, ... rồi cuối cùng 'd1_migrations' */];
  await env.DB.batch(tables.map((t) => env.DB.prepare(`DROP TABLE IF EXISTS ${t}`)));
  await applyD1Migrations(env.DB, migrations.slice(0, through));
}
```
Nguyên bản: `docs/reference/nexus/05-testing-and-dev-workflow.md:82-96` (drop toàn bộ bảng + `d1_migrations`, rồi apply lại).

### `migrations/0001_init.sql` (chỉ khung, không nội dung schema — out of scope)
Đặt tên đánh số append-only, migration đầu **phải** có `store_id` trên mọi bảng nghiệp vụ (D4, `docs/decisions/260919-post-xia-decision-record.md:` mục D4).

### `.github/workflows/ci.yml`
Xương sống job `verify` (mở rộng D14 so với SOURCE — thêm e2e):
```yaml
jobs:
  verify:
    steps:
      - run: npm ci
      - run: npm run typecheck
      - run: npm run test:workerd
      - run: npm run build:console
      - run: npm run build:storefront
      - run: npm run test:e2e   # KHÁC SOURCE: SOURCE không chạy e2e trong CI
  deploy:
    needs: verify
    if: github.event_name == 'workflow_dispatch' || github.ref == 'refs/heads/main'
    steps:
      - run: npm run db:migrate:remote
      - run: npm run deploy:console
      - run: npm run deploy:storefront
```
Khung `verify` gốc + `deploy` sau `migrate`: `docs/reference/nexus/01-monorepo-and-build.md:310-315`; `docs/reference/nexus/05-testing-and-dev-workflow.md:308-324`. Việc thêm `test:e2e` vào `verify` là **bắt buộc theo D14**, khác nguyên bản SOURCE (`docs/decisions/260919-post-xia-decision-record.md:226-233`).

---

## Test cần viết trước (TDD)

Bảng dưới chỉ phủ **hạ tầng build/test** (đúng scope report này), không phải business logic tiền/đơn hàng (đó là scope của report khác).

| Tên test | Assert gì | Dữ liệu vào | Trích dẫn pattern |
|---|---|---|---|
| `tests/node/assert-import-graph.test.ts :: console graph chứa packages/orders bị chặn` | Hàm assert ném lỗi khi module graph console khớp forbidden pattern (design/prototype/fixture hoặc, theo mở rộng riêng của Console, một import ngoài `@qr/catalog`) | Fake JSON `{modules:["apps/console/src/main.tsx","design/x.ts"]}` | Thuật toán forbidden gốc: `docs/reference/nexus/01-monorepo-and-build.md:127-136` |
| `tests/node/assert-import-graph.test.ts :: storefront graph chứa bất kỳ packages/** nào bị chặn` | Ném lỗi khi graph storefront chứa module khớp `^packages/` (storefront phải HTTP-only tuyệt đối) | Fake JSON `{modules:["apps/storefront/src/main.tsx","packages/catalog/src/money.ts"]}` | Mở rộng D3, chưa có trong SOURCE: `docs/decisions/260919-post-xia-decision-record.md:106-110`; `docs/reference/nexus/01-monorepo-and-build.md:141,424` |
| `tests/node/assert-import-graph.test.ts :: graph sạch có liveness anchor thì pass` | Không throw khi graph chỉ chứa module hợp lệ **và** có đúng anchor (`apps/console/src/main.tsx` hoặc `apps/storefront/src/main.tsx`); throw khi thiếu anchor dù graph "sạch" (chống false-negative do plugin không chạy) | Fake JSON có/không có anchor | `docs/reference/nexus/01-monorepo-and-build.md:129-139` |
| `tests/node/assert-import-graph.test.ts :: metadata file luôn bị xoá kể cả khi throw` | Sau khi gọi hàm assert (dù pass hay throw), file metadata tạm không còn tồn tại trên đĩa | Gọi assert 2 lần: 1 lần graph sạch, 1 lần graph vi phạm | `docs/reference/nexus/01-monorepo-and-build.md:139` (lý do: rò `production-import-graph.json` thành asset public nếu không xoá) |
| `tests/integration/reset-db.test.ts :: resetDb() xoá sạch dữ liệu và giữ schema mới nhất` | Ghi 1 row bất kỳ (vd `categories`) trước test A; sau `resetDb()` ở `beforeEach` của test B, `SELECT count(*)` bảng đó = 0 và bảng vẫn tồn tại đúng schema (migration mới nhất áp lại thành công) | Insert 1 row trong test A, không cleanup thủ công | `docs/reference/nexus/05-testing-and-dev-workflow.md:79-100` |
| `tests/integration/reset-db.test.ts :: resetDb(through=N) giữ nguyên dữ liệu ghi trước migration N+1` | Apply migration tới N, ghi dữ liệu, apply thêm migration N+1, đọc lại dữ liệu cũ còn nguyên (không mất cột/row) | Migration N (bảng cơ bản) → insert → migration N+1 (thêm cột) → SELECT | `docs/reference/nexus/05-testing-and-dev-workflow.md:82-84,107` |
| `tests/node/no-hardcoded-hostname.test.ts :: không còn hostname literal trong source` | Quét (grep) toàn bộ `apps/**/src`, `packages/**/src`, `wrangler.jsonc*` cho pattern hostname cứng (domain `*.workers.dev` hoặc domain thật không đi qua `env.*`/biến môi trường) → tập kết quả rỗng | Toàn bộ cây source hiện tại của repo | D21: `docs/decisions/260919-post-xia-decision-record.md:309-315` |
| `tests/node/tsconfig-coverage.test.ts :: tsconfig include phủ đủ 4 thư mục gốc` | Đọc `tsconfig.json`, `include` chứa cả `apps`, `packages`, `scripts`, `tests` (không thiếu thư mục nào để `tsc --noEmit` bỏ sót lỗi) | `tsconfig.json` thật của repo | `docs/reference/nexus/01-monorepo-and-build.md:17,188` |

---

## Cạm bẫy & lệch chuẩn so với repo mẫu

1. **KHÔNG dùng `packages/core` gộp.** Chính tài liệu `01-monorepo-and-build.md:390,406,412,418` (mục "Áp dụng cho QR Menu") khuyến nghị giữ `packages/core` — nhưng khuyến nghị đó dựa trên **PRD cũ** (Next.js + Drizzle) đã bị D1/D2/D3 thay thế hoàn toàn. Decision Record (`docs/decisions/260919-post-xia-decision-record.md:82-91`, LOCKED) và `docs/PRD.md` hiện tại đều chốt 3 package `identity/catalog/orders`. Đây là điểm mâu thuẫn thật giữa hai nguồn — **Decision Record thắng**, không port khuyến nghị `packages/core`.
2. **KHÔNG copy gate import-graph nguyên trạng chỉ phủ Console.** SOURCE tự thừa nhận storefront có plugin thu thập nhưng không script nào đọc (`01-monorepo-and-build.md:141`) — đây chính xác là lỗ hổng D3 yêu cầu vá (`docs/decisions/260919-post-xia-decision-record.md:108-110`: "Repo mẫu chỉ phủ Console... bỏ trống đúng chỗ nguy hiểm nhất").
3. **KHÔNG loại e2e khỏi CI gate.** SOURCE cố tình đẩy `test:browser`/`test:e2e` ra khỏi `verify` job vì cần 2 server + D1 local (`docs/reference/nexus/05-testing-and-dev-workflow.md:308-322`). D14 đảo ngược: luồng tiền phải có ít nhất 1 e2e chặn merge (`docs/decisions/260919-post-xia-decision-record.md:226-233`). Copy nguyên CI của SOURCE = vi phạm D14 ngay từ M0.
4. **KHÔNG port `scripts/verification/` + evidence ledger.** Decision Record loại rõ khỏi phạm vi vì đây là hạ tầng quy trình riêng của repo mẫu (`docs/decisions/260919-post-xia-decision-record.md:347`), dù `05-testing-and-dev-workflow.md` mô tả khá kỹ (mục 5) — đừng vì tài liệu mô tả chi tiết mà nghĩ nó thuộc scope.
5. **KHÔNG hard-code tên tài nguyên D1/R2/Worker kiểu SOURCE** (`nexus-s1-468cba-db`, v.v., rải trong `playwright.config.ts`, test file...). Tài liệu tự flag đây là rủi ro cần sửa khi áp cho TARGET (`docs/reference/nexus/05-testing-and-dev-workflow.md:413`), và khớp trực tiếp D21 (không hard-code hostname/origin) dù D21 nói về origin chứ không phải tên D1 — nên áp dụng tinh thần "một tên, một hằng số" cho cả tên tài nguyên lẫn origin.
6. **Có mâu thuẫn thật trong CHÍNH SOURCE giữa CI và README** về thứ tự deploy: CI deploy console-trước-storefront, README yêu cầu storefront-trước-console vì Console cần origin Storefront đã tồn tại (`docs/reference/nexus/05-testing-and-dev-workflow.md:326`). Đừng copy máy móc thứ tự CI của SOURCE mà không tự hỏi TARGET có phụ thuộc vòng tương tự không — với D21 (origin `workers.dev` cố định theo tên Worker, biết trước khi deploy) rủi ro này thấp hơn SOURCE nhưng vẫn nên set origin qua biến môi trường đã biết trước, không phụ thuộc thứ tự deploy.
7. **KHÔNG giả định có mạng ra ngoài trong test/CI ở M0–M2** (D22). SOURCE test PayFS hoàn toàn trong workerd không cần tunnel (`docs/reference/nexus/05-testing-and-dev-workflow.md` mục Áp dụng, dòng cuối) — TARGET đúng tinh thần này: script tự ký payload theo F11 bắn thẳng vào worker local/test, `cloudflared` chỉ dùng một lần trước M4 (`docs/decisions/260919-post-xia-decision-record.md:` D22).
8. **KHÔNG copy phiên bản gói `dependencies` không nhất quán của SOURCE** (`file:../identity` ở một chỗ, `"0.0.0"` ở chỗ khác, `01-monorepo-and-build.md:189`) — SOURCE tự nhận đây là sự không nhất quán "vô hại", nhưng không có lý do gì để lặp lại trong repo mới; chọn một quy ước duy nhất (khuyến nghị: `"0.0.0"` mọi nơi vì workspaces resolve theo tên, không theo semver).

---

## Câu hỏi còn mở

1. **Tên tài nguyên thật** (`database_name` D1, `bucket_name` R2, `name` Worker Console/API, `--name` Worker Storefront) chưa có trong PRD hay Decision Record — D21 chỉ chốt dùng `workers.dev`, không chốt tên cụ thể. Cần quyết định trước khi chạy `wrangler d1 create`/`wrangler r2 bucket create` thật (liên quan O9 trong Decision Record — cutover domain thật).
2. **`compatibility_date` cho TARGET** — SOURCE dùng `2026-08-22` (`docs/reference/nexus/00-index.md`, mục Source manifest), không có lý do để TARGET dùng đúng ngày đó; Decision Record không chốt ngày. Cần một quyết định thi công (ngày hiện tại lúc `wrangler init`/migration đầu) chứ không phải copy nguyên văn.
3. **Danh sách đầy đủ tên bảng nghiệp vụ cho `resetDb()`** phụ thuộc migration đầu tiên (schema orders/catalog/identity) — chưa viết ở M0 vì đây là business logic, ngoài scope report này (xem PRD mục 5 để có danh sách bảng gợi ý, nhưng thứ tự DROP chính xác cần đợi migration 0001 thật được viết).
4. **Danh sách chính xác `FORBIDDEN_STOREFRONT` regex** (mở rộng gate) — báo cáo đề xuất chặn toàn bộ `^packages/` khỏi bundle storefront (an toàn nhất, khớp "Storefront hoàn toàn HTTP-only"), nhưng chưa có xác nhận rõ ràng từ Decision Record về việc có ngoại lệ nào (vd storefront có được import `@qr/catalog/money` để format tiền client-side không?) — nên hỏi người lập kế hoạch/chủ dự án trước khi khoá cứng quy tắc này vào script.
