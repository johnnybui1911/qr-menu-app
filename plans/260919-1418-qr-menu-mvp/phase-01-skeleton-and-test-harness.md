---
title: "Phase 1: Skeleton & test harness"
phase: 1
status: completed
priority: P1
effort: 6h
milestone: M0
dependencies: []
---

# Phase 1: Skeleton & test harness

## Context

- [Decision Record](../../docs/decisions/260919-post-xia-decision-record.md) — D1, D3, D4, D14, D21, D22, mục C
- [Scout 01 — build & test harness](./reports/scout-01-build-and-test-harness.md) — hình dạng config, thuật toán gate, khung CI
- [Pattern repo mẫu](../../docs/reference/nexus/01-monorepo-and-build.md) · [testing & dev workflow](../../docs/reference/nexus/05-testing-and-dev-workflow.md)

## Goal

Dựng bộ khung chạy được của monorepo: 4 app/package workspace đúng biên giới D3, một Worker Console+API + một Worker Storefront riêng origin, và **một test chạm D1 thật xanh** — để mọi phase sau có nơi viết test trước khi viết code.

## Overview

Priority P1 · M0 · không phụ thuộc phase nào. Đây là phase duy nhất được phép không có logic nghiệp vụ. Tiêu chí ra khỏi phase: `npm run typecheck && npm run test:workerd && npm run build:console && npm run build:storefront` xanh trên máy sạch, và gate import-graph chặn được một vi phạm cố ý.

## Key insights

- Biên giới package được cưỡng chế bằng **`dependencies` của từng workspace**, không bằng review. `apps/storefront/package.json` không khai báo `@qr/*` nào → mọi import từ package fail lúc build (D3).
- Gate `assert-production-import-graph` của repo mẫu **chỉ phủ Console**; storefront có plugin thu thập nhưng không script nào đọc (`docs/reference/nexus/01-monorepo-and-build.md:141`). Đây đúng là chỗ nguy hiểm nhất (rò logic giá/refund vào bundle chạy trên máy khách) → phase này phải phủ cả hai.
- Repo mẫu **loại e2e khỏi CI gate** (`05-testing-and-dev-workflow.md:308-322`). D14 đảo ngược. Khung CI viết ở phase này phải có sẵn chỗ cho bước e2e; phase 10 điền nội dung.
- `@cloudflare/vite-plugin` sinh `apps/console/dist/<worker>/wrangler.json` đã resolve `main` + `assets.directory`. Deploy **phải** trỏ file đó, không `wrangler deploy` trần ở root (`01-monorepo-and-build.md:294-306`).
- Test D1 chạy trong workerd thật; reset giữa các test bằng `DROP TABLE` toàn bộ + `applyD1Migrations` lại, **không** transaction rollback (D1 không có transaction tương tác — F4).

## Quyết định thi công chốt tại phase này

Ba câu hỏi mở của scout-01 được chốt ở đây để không chặn thi công:

| # | Câu hỏi | Chốt |
|---|---|---|
| 1 | Tên tài nguyên | Worker Console+API `qr-menu-app` · Worker Storefront `qr-menu-storefront` · D1 `qr-menu-app-db` · R2 `qr-menu-app-files`. Tên chỉ xuất hiện trong `wrangler.jsonc` và script npm, **không** trong source hay test (C10) |
| 2 | `compatibility_date` | Ngày khởi tạo repo, dùng **một** giá trị cho root wrangler + storefront wrangler + `vitest.config.ts`; có test khẳng định ba chỗ khớp nhau |
| 3 | Storefront có được import `@qr/catalog/money`? | **Không.** `FORBIDDEN_STOREFRONT = /^packages\//` chặn tuyệt đối. Storefront tự format tiền bằng `Intl.NumberFormat('vi-VN')` trên số nguyên VND server trả về. Lý do: giữ `dependencies` rỗng là lớp cưỡng chế chính của D3; đổi lấy ~10 dòng format trùng lặp là rẻ |

## Requirements

- [x] npm workspaces: `apps/{console,storefront,worker}`, `packages/{identity,catalog,orders}`; script chỉ ở root `package.json`
- [x] `exports: {"./*": "./src/*.ts"}` ở cả 3 package; **không** barrel `index.ts`, không `main`, không build step (D3)
- [x] `dependencies`: `catalog → identity`; `orders → catalog, identity`; `apps/worker → cả ba`; `apps/console → @qr/catalog` + react; `apps/storefront → react` only
- [x] Root `wrangler.jsonc`: `main` = `apps/worker/src/index.ts`, binding `DB`/`FILES`/`ASSETS`, `not_found_handling: single-page-application`, `run_worker_first: ["/api","/api/*"]`, `triggers.crons: ["*/1 * * * *","*/5 * * * *"]` (D6 + D23 — đặt sẵn cả hai ngay từ M0)
- [x] `apps/storefront/wrangler.jsonc`: assets-only, không `main`, không binding
- [x] `vitest.config.ts` (pool workers) với `@cloudflare/vitest-pool-workers`, `d1Databases: ['DB']`, `r2Buckets: ['FILES']`, `testTimeout: 30_000`, include `tests/unit/**` + `tests/integration/**`
- [x] `vitest.node.config.ts` (`environment: 'node'`) include `tests/node/**` — **bắt buộc**: các test đọc filesystem/grep/parse config (import-graph, hostname, secret-scan, sql-hygiene) không chạy được trong pool workerd. Script `test:node`; `npm test` = `test:node && test:workerd` (phase 9 thêm `test:browser`)
- [x] `tests/support/test-env.ts` có `resetDb(through?)`: liệt kê bảng từ `sqlite_master` (loại `sqlite_%`, `_cf_%`) rồi DROP **trong một `db.batch()` mở đầu bằng `PRAGMA defer_foreign_keys = true`** — thứ tự `sqlite_master` là tuỳ ý nên xoá bảng cha còn row con sẽ vỡ FK. **Không** giữ danh sách bảng viết tay: phase sau thêm bảng không phải sửa harness. Migration thật đọc bằng `readD1Migrations('migrations')` trong `vitest.config.ts`
- [x] `scripts/assert-production-import-graph.ts` nhận `--target console|storefront`, có liveness anchor, `finally` xoá file metadata
- [x] `.github/workflows/ci.yml` job `verify` = `npm ci` → `npm run typecheck` → `npm test` → `build:console` → `build:storefront` → `test:e2e` (đúng 5 cổng của D14). Bước `test:e2e` là placeholder trả 0 **chỉ** ở phase này; phase 10 thay bằng spec thật và có test khẳng định không còn placeholder
- [x] Không hostname **của mình** dạng literal trong `apps/**/src`, `packages/**/src` (origin của Console/Storefront đọc từ `vars`). Base URL của nhà cung cấp bên thứ ba cũng đi qua `vars` — `PAYFS_API_BASE`, `RESEND_API_BASE` — để phase 5 vừa không vi phạm T6 vừa stub được server trong test

## Architecture

```
qr-menu-app/
├── package.json                  # workspaces + toàn bộ script
├── tsconfig.json                 # một file, noEmit, include apps/packages/scripts/tests
├── wrangler.jsonc                # Console + API + DB + FILES + ASSETS + 2 cron
├── vitest.config.ts              # pool workers, D1 + R2
├── migrations/                   # append-only (phase 2 viết 0001)
├── scripts/assert-production-import-graph.ts
├── tests/{unit,integration,node,e2e}/ + tests/support/test-env.ts
├── apps/worker/src/index.ts      # HTTP adapter, chưa có route nghiệp vụ
├── apps/console/{vite.config.ts,src/main.tsx}
├── apps/storefront/{wrangler.jsonc,vite.config.ts,src/main.tsx}
└── packages/{identity,catalog,orders}/src/
```

Phân tầng test (theo `05-testing-and-dev-workflow.md:14-22`): `tests/unit` logic thuần · `tests/integration` D1+R2+HTTP thật trong workerd · `tests/node` script/gate chạy trên Node · `tests/e2e` Playwright hai origin. `tests/support` và `tests/fixtures` **không** vào discovery.

## Files to create

- Create: `package.json`, `tsconfig.json`, `wrangler.jsonc`, `vitest.config.ts`, `.gitignore`, `.github/workflows/ci.yml`
- Create: `apps/worker/{package.json,src/index.ts}`
- Create: `apps/console/{package.json,vite.config.ts,index.html,src/main.tsx}`
- Create: `apps/storefront/{package.json,wrangler.jsonc,vite.config.ts,index.html,src/main.tsx}`
- Create: `packages/identity/package.json`, `packages/catalog/package.json`, `packages/orders/package.json`
- Create: `scripts/assert-production-import-graph.ts`
- Create: `tests/cloudflare-test-env.d.ts`, `tests/support/test-env.ts`
- Create: `migrations/.gitkeep` (nội dung schema thuộc phase 2)

## Tests Before (viết trước, phải đỏ trước khi viết code)

| # | Test | Assert | Dữ liệu vào |
|---|---|---|---|
| T1 | `tests/node/import-graph.test.ts :: chặn module cấm ở console` | Hàm assert **throw** khi graph chứa `design/`, `prototype`, `fixtures/` | JSON giả `{modules:["apps/console/src/main.tsx","design/x.ts"]}` |
| T2 | `tests/node/import-graph.test.ts :: chặn mọi packages/** ở storefront` | Throw khi graph storefront chứa module khớp `^packages/` | `{modules:["apps/storefront/src/main.tsx","packages/catalog/src/money.ts"]}` |
| T3 | `tests/node/import-graph.test.ts :: thiếu liveness anchor thì throw` | Graph "sạch" nhưng không có `apps/<target>/src/main.tsx` → throw (chống false-negative khi plugin không chạy) | JSON giả không có anchor |
| T4 | `tests/node/import-graph.test.ts :: metadata luôn bị xoá` | Sau cả lần pass và lần throw, file metadata tạm không còn trên đĩa | Gọi assert 2 lần |
| T5 | `tests/node/workspace-boundaries.test.ts :: dependencies đúng chiều` | Đọc 6 `package.json`: `storefront.dependencies` không chứa `@qr/`; `console` chỉ chứa `@qr/catalog`; `catalog` không chứa `@qr/orders`; `identity` không chứa `@qr/` nào | `package.json` thật |
| T6 | `tests/node/no-hardcoded-hostname.test.ts :: không có hostname literal` | Quét `apps/**/src`, `packages/**/src`: không match `workers.dev`, không match `https?://[a-z0-9.-]+\.[a-z]{2,}` ngoài comment — **kể cả** base URL nhà cung cấp (`api.payfs.vn`, `api.resend.com`), chúng phải đọc từ `vars` | cây source thật |
| T7 | `tests/node/config-consistency.test.ts :: compatibility_date khớp 3 chỗ` | `wrangler.jsonc`, `apps/storefront/wrangler.jsonc`, `vitest.config.ts` cùng một `compatibility_date`; `triggers.crons` chứa đúng `*/1` và `*/5` | file config thật |
| T8 | `tests/integration/test-env.test.ts :: resetDb chạy được trong workerd` | `resetDb()` với `migrations/` **rỗng** (phase này chưa có migration nghiệp vụ) → không throw, `sqlite_master` chỉ còn `d1_migrations`; gọi hai lần liên tiếp vẫn không throw. Bằng chứng `applyD1Migrations` **có schema thật** là test đầu tiên của phase 2 — không dựng fixture probe chỉ để chứng minh một lần | `migrations/` rỗng |
| T9 | `tests/integration/test-env.test.ts :: binding D1 + R2 sống trong workerd` | `env.DB.prepare('select 1 as x').first()` trả `{x:1}`; `env.FILES.put/get` round-trip một object 3 byte | — |

T8/T9 là bài test rẻ nhất chứng minh hai giả định nguy hiểm nhất của M0 (`applyD1Migrations`/`resetDb` gọi được trong vitest workerd; binding D1 + R2 sống) — viết trước cả `package.json` hoàn chỉnh. Phase 2 T6–T13 là bằng chứng migration thật apply được.

## Refactor / triển khai dưới lưới test

1. `npm init` root + 6 workspace `package.json` đúng bảng `dependencies` ở Requirements; cài `wrangler`, `vitest`, `@cloudflare/vitest-pool-workers`, `@cloudflare/vite-plugin`, `vite`, `react@19`, `react-dom@19`, `typescript`, `tsx`.
2. `tsconfig.json` một file: `noEmit: true`, `strict: true`, `include: ["apps","packages","scripts","tests","worker-configuration.d.ts"]`; sinh type binding bằng `wrangler types`.
3. Tạo tài nguyên: `wrangler d1 create qr-menu-app-db`, `wrangler r2 bucket create qr-menu-app-files`; dán `database_id` vào `wrangler.jsonc`.
4. `wrangler.jsonc` root + `apps/storefront/wrangler.jsonc` theo Requirements. Origin vào `vars` bằng tên biến (`CONSOLE_ORIGIN`, `STOREFRONT_ORIGIN`), giá trị nạp lúc deploy — không literal trong source (C10).
5. `vitest.config.ts`: `readD1Migrations('migrations')` → binding `MIGRATIONS`; `tests/cloudflare-test-env.d.ts` khai kiểu binding đó; `tests/support/test-env.ts` có `resetDb(through)` = `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'` → `db.batch([PRAGMA defer_foreign_keys = true, …DROP…])` (gồm `d1_migrations`), rồi `applyD1Migrations(env.DB, env.MIGRATIONS.slice(0, through))`. `vitest.node.config.ts` riêng cho `tests/node/**` chạy trên Node.
6. `scripts/assert-production-import-graph.ts`: plugin Vite `apply: 'build'` + hook `generateBundle` ghi `Object.keys(output.modules)` (module thật vào bundle) ra JSON theo target; script assert 4 bước — sanity path (không absolute, không `..`, không `\`), forbidden chung, forbidden riêng storefront `^packages/`, liveness anchor — `finally` xoá metadata.
7. `apps/worker/src/index.ts`: chỉ `fetch` trả 404 cho `/api/*` chưa map và `scheduled` rỗng có `switch (event.cron)` cho hai pattern; route nghiệp vụ do phase sau thêm.
8. Hai `vite.config.ts` dùng `@cloudflare/vite-plugin` + plugin thu thập import-graph; `strictPort: true`, **không** hard-code port.
9. `.github/workflows/ci.yml`: job `verify` = `npm ci` → `npm run typecheck` → `npm test` (node + workerd) → `build:console` → `build:storefront` → `test:e2e`; job `deploy` `needs: verify`, chạy `db:migrate:remote` trước `deploy:*`, `deploy:storefront` trước `deploy:console` (Console cần `STOREFRONT_ORIGIN` tồn tại), `concurrency.cancel-in-progress: false`.

## Tests After (hành vi mới của phase này)

| # | Test | Assert |
|---|---|---|
| A1 | `tests/integration/worker-shell.test.ts :: /api chưa map trả 404 JSON` | `GET /api/nope` → 404, `content-type: application/json`, body không lộ stack |
| A2 | `tests/integration/worker-shell.test.ts :: scheduled nhận đúng 2 cron pattern` | Gọi handler `scheduled` với `cron: "*/1 * * * *"` và `"*/5 * * * *"` → không throw; pattern lạ → throw để không im lặng bỏ job |
| A3 | `tests/node/build-artifacts.test.ts :: build console sinh wrangler.json` | Sau `build:console`, tồn tại `apps/console/dist/qr-menu-app/wrangler.json` với `main` và `assets.directory` đã resolve. Test này **không** nằm trong `npm test` (cần bundle đã build) — script riêng `test:artifacts`, chạy trong CI ngay sau `build:console` |

## Todo

- [x] T1–T9 viết trước và đỏ
- [x] 6 workspace `package.json` + `tsconfig.json` + cài dependency
- [x] Tạo D1 + R2, viết `wrangler.jsonc` root và storefront — D1 `qr-menu-app-db` tạo 2026-09-26, `database_id` đã ghi; R2 bucket `qr-menu-app-files` tạo 2026-09-26 sau khi chủ tài khoản bật R2 (khi `r2 bucket create` hỏi có sửa config không thì chọn "no" — binding `FILES` đã có sẵn) <!-- Updated: Cook 2026-09-26 -->
- [x] `vitest.config.ts` + `vitest.node.config.ts` + `tests/support/test-env.ts`
- [x] `scripts/assert-production-import-graph.ts` + plugin thu thập cho **cả hai** app
- [x] `apps/worker/src/index.ts` shell + hai `vite.config.ts` + `main.tsx` tối thiểu
- [x] `.github/workflows/ci.yml`
- [x] A1–A3 xanh
- [x] Cố ý thêm `import { formatMoney } from '@qr/catalog/money'` vào `apps/storefront/src/main.tsx`, xác nhận build **fail**, rồi revert

## Regression gate

```bash
npm run typecheck && npm test && npm run build:console && npm run build:storefront
```

Phải xanh trên máy sạch (`rm -rf node_modules && npm ci`). Thêm kiểm tra tay một lần: bước cuối của Todo (import cố ý sai) phải làm build đỏ.

## Success criteria

- [x] T1–T9 và A1–A3 xanh; regression gate xanh trên máy sạch
- [x] Storefront import `@qr/*` → build đỏ ở **hai** lớp: resolve dependency và gate import-graph
- [x] `resetDb()` chạy được trong `beforeEach` mà không rò dữ liệu giữa test, và **không** cần sửa khi phase sau thêm bảng
- [x] Không hostname literal, không tên tài nguyên D1/R2 nằm trong `src/` hay test
- [x] CI `verify` xanh trên PR đầu tiên (run 36237078854 trên `main`, 2026-09-26: đủ 5 cổng gồm e2e; lần chạy đầu đỏ vì cài Chromium sau `npm test` — đã sửa)

## Risks

| Rủi ro | Mitigation |
|---|---|
| `applyD1Migrations`/`readD1Migrations` không chạy trong pool workers phiên bản hiện tại | T8/T9 viết **đầu tiên** để biết sớm; phase 2 T6–T13 là lần kiểm với schema thật. Hỏng thì đổi chiến lược test D1 trước khi viết dòng nghiệp vụ nào, chi phí bỏ đi ~0 |
| `run_worker_first` không chặn được asset fallback ăn `/api/*` | A1 kiểm trực tiếp qua HTTP trong workerd, không suy đoán từ config |
| Bước `test:e2e` rỗng ở M0 thành cửa hậu vĩnh viễn | Phase 10 có acceptance riêng: CI phải fail khi xoá một assertion của e2e luồng tiền |

## Security

- Secret không vào `wrangler.jsonc` và không vào repo; phase này chỉ khai báo **tên** biến (C11, D16).
- `.gitignore` chặn `.dev.vars*` **nhưng có ngoại lệ `!.dev.vars.example`** (file mẫu chỉ chứa tên biến, do phase 6 tạo), cộng `.wrangler/`, `dist/`, `production-import-graph*.json`.
- Gate import-graph có `finally` xoá metadata để không publish `production-import-graph.json` thành asset công khai.

## Ghi chú thi công (2026-09-26)

Lệch so với plan, đã kiểm bằng test:

- `compatibility_date` = `2026-08-15`: không được vượt workerd đi kèm `@cloudflare/vitest-pool-workers@0.22.0`. `vitest.config.ts` đọc root `wrangler.jsonc` qua `wrangler.configPath` nên ngày chỉ nằm ở **hai** file wrangler; T7 kiểm `configPath` thay vì chữ thứ ba. Nâng pool-workers thì nâng ngày theo.
- Lớp "resolve dependency" của D3 **không tự có** dưới npm workspaces (mọi `@qr/*` đều được hoist). Plugin `productionImportGraph` thêm `resolveId` từ chối `@qr/*` không khai trong `package.json` của app. Console bị cấm mọi `packages/` trừ `catalog`.
- Graph ghi module ở `moduleParsed`, không ở `generateBundle`: rolldown inline hằng số đến mức module biến khỏi `output.modules`, nên import tương đối một hằng từ `packages/` lọt cả hai lớp. Đã tái hiện và chặn.
- `database_id` bỏ trống lúc thi công (Wrangler chưa đăng nhập). **Cập nhật 2026-09-26:** D1 production đã tạo, `database_id` đã ghi vào `wrangler.jsonc` (không phải secret; ghi cố định để deploy/migrate không phụ thuộc cơ chế tự provision của wrangler). Lưu ý: có `database_id` thì khoá DB local đổi theo — ai có `.wrangler/state` cũ phải `npm run db:migrate:local` lại. `wrangler d1 create --update-config` viết lại cả `wrangler.jsonc` và làm mất chú thích — đã sửa tay. R2 bucket `qr-menu-app-files` đã tạo cùng ngày.
- `.npmrc` ghim registry công khai: mirror npm nội bộ của công ty không truy cập được từ mạng này và từ GitHub Actions. Cần chủ quản chính sách registry xác nhận trước khi merge.
- `vars` có sẵn `PAYFS_API_BASE`, `RESEND_API_BASE` (C10/T6).

## Next

Phase 2 (schema nền, money & pricing) dùng `resetDb()` của phase này. Phase 6 và 10 mở rộng CI workflow do phase này tạo; phase 9 thêm `test:browser` vào `npm test`.
