# 05 — Chiến lược kiểm thử & quy trình dev/vận hành (tham chiếu Nexus)

Nguồn: repo mẫu `nexus-handson` (SOURCE). Mọi `path:line` dưới đây là đường dẫn tương đối trong SOURCE.
Tài liệu này chỉ mô tả *cách* hệ thống được kiểm thử và vận hành, không mô tả business logic.

---

## 1. Kim tự tháp test thật của SOURCE

Phân tầng được ghi thành ràng buộc trong `tests/AGENTS.md:5`:

> Risk layers stay: `unit` (domain/pure rules), `integration` (D1/R2/HTTP/atomicity), `browser` (React contracts), `e2e` (two-origin journeys). `fixtures/` and `support/` are helpers — do not add them to Vitest/Playwright discovery.

`tests/AGENTS.md:7` bắt buộc chạy mọi lệnh từ repo root.

| Tầng | Thư mục | Số file | Runner / config | Môi trường thực thi | Lệnh npm | D1 |
|---|---|---|---|---|---|---|
| unit | `tests/unit` | 15 | Vitest + `@cloudflare/vitest-pool-workers` (`vitest.config.ts:15`) | workerd (Miniflare) | `npm run test:unit` (`package.json:21`) | không dùng (logic thuần) |
| integration | `tests/integration` | 35 | cùng config với unit (`vitest.config.ts:15`) | workerd + binding `DB`/`FILES` (`vitest.config.ts:9-10`) | `npm run test:integration` (`package.json:22`) | D1 Miniflare in-memory, migration SQL apply bằng `applyD1Migrations` |
| browser | `tests/browser` | 7 | Vitest browser mode + Playwright provider (`vitest.browser.config.ts:7-12`) | Chromium headless, React render thật | `npm run test:browser` (`package.json:20`) | không; fetch bị stub, chỉ kiểm hợp đồng UI |
| node | `tests/node` | 2 | Vitest node pool (`vitest.node.config.ts:5-8`) | Node 22, `pool: 'forks'`, `fileParallelism: false` | `npx vitest run --config vitest.node.config.ts` (`README.md:96`) | D1 local qua Wrangler `getPlatformProxy` |
| e2e | `tests/e2e` | 7 | Playwright (`playwright.config.ts:54`) | 2 dev server thật (Console/API + Storefront) | `npm run test:e2e` (`package.json:34`) | D1 local persist thật, migration apply bằng `wrangler d1 migrations apply --local` |

Lệnh gộp: `"test": "npm run test:workerd && npm run test:browser"` (`package.json:18`), trong đó `test:workerd` là `vitest run` (`package.json:19`) chạy cả unit lẫn integration vì cùng nằm trong `include` của `vitest.config.ts:15`.

Điểm cần nhớ: **tầng unit và integration dùng chung một runner workerd**, khác nhau ở chỗ integration mở binding D1/R2 và gọi Worker fetch thật; không có tầng "jsdom".

Config workerd (nguyên văn `vitest.config.ts`):

```ts
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: '2026-08-22',
        d1Databases: ['DB'],
        r2Buckets: ['FILES'],
      },
    }),
  ],
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
```

Kiểu binding cho test được khai báo riêng tại `tests/cloudflare-test-env.d.ts:1-6` (`DB: D1Database`, `FILES: R2Bucket`), nên `env` từ `cloudflare:test` có type đầy đủ.

Ví dụ một unit test thuần (nguyên văn `tests/unit/money.test.ts:4-13`):

```ts
describe('decimal money', () => {
  it('uses currency fraction metadata and string arithmetic', () => {
    expect(decimalToMinor('24.00', 'USD')).toBe(2400);
    expect(decimalToMinor('24', 'JPY')).toBe(24);
    expect(decimalToMinor('1.234', 'KWD')).toBe(1234);
  });

  it.each(['-1.00', '1e2', ' 1.00', '1.001'])('rejects malformed or over-precision USD input %s', (value) => {
    expect(() => decimalToMinor(value, 'USD')).toThrow(MoneyError);
  });
```

---

## 2. Test có D1: migration vào đâu, isolate thế nào

`vitest.config.ts` **không** tự apply migration. Việc này do helper `tests/support/catalog-test-env.ts` làm:

1. Import từng file SQL trong `migrations/` dưới dạng raw string bằng Vite `?raw` (`tests/support/catalog-test-env.ts:7-10` và tiếp theo, tổng 16 file).
2. Tách file SQL thành danh sách câu lệnh bằng parser thủ công `splitMigrationSql` (`tests/support/catalog-test-env.ts:28`) — parser này xử lý quote, comment `--`/`/* */`, và đặc biệt giữ nguyên khối `CREATE TRIGGER ... END;` thay vì cắt ở dấu `;` đầu tiên.
3. Gộp thành mảng `catalogMigrations: D1Migration[]` (`tests/support/catalog-test-env.ts:91`), đúng thứ tự đánh số file.
4. Apply bằng API `applyD1Migrations` của `cloudflare:test`.

Isolate state: **không** dùng transaction rollback, mà **drop toàn bộ bảng rồi apply lại migration trước mỗi test** (nguyên văn `tests/support/catalog-test-env.ts:113-156`, phần danh sách bảng được rút gọn):

```ts
export function applyCatalogMigrations(through: CatalogMigrationThrough = 16): Promise<void> {
  return applyD1Migrations(env.DB, catalogMigrations.slice(0, through));
}

export async function resetCatalogThrough(through: CatalogMigrationThrough): Promise<void> {
  const tables = [
    'provider_payments',
    'provider_events',
    // ...
    'stores',
    'd1_migrations',
  ];
  await env.DB.batch(tables.map((table) => env.DB.prepare(`DROP TABLE IF EXISTS ${table}`)));
  await applyCatalogMigrations(through);
}

export async function resetCatalog(): Promise<void> {
  return resetCatalogThrough(16);
}
```

Cách dùng trong test: một dòng `beforeEach(resetCatalog);` (ví dụ `tests/integration/payfs-webhook.test.ts:30`).

Hai hệ quả thiết kế đáng bê nguyên:

- Tham số `through` cho phép **test migration theo mốc**: apply tới migration N, ghi dữ liệu "cũ", rồi apply migration N+1 và khẳng định dữ liệu được bảo toàn — ví dụ `tests/integration/orders-persistence.test.ts:650` (`await applyD1Migrations(env.DB, catalogMigrations.slice(5));`) và `tests/integration/identity-schema.test.ts:122`.
- Test cả **migration hỏng giữa chừng**: chèn một câu lệnh sai vào cuối migration và khẳng định nó `rejects.toThrow()` (`tests/integration/order-brief-migration.test.ts:450-453`, `tests/integration/order-operations-migration.test.ts:459-462`), chứng minh migration là atomic.
- Bảng `d1_migrations` cũng bị drop (`tests/support/catalog-test-env.ts:148`) nên mỗi test bắt đầu từ trạng thái "chưa từng migrate".

Gọi HTTP vào Worker trong integration test đi qua helper `workerRequest` (`tests/support/catalog-test-env.ts:164`), nó inject binding test (`DB`, `FILES`, origin, secret, `ASSETS` giả) và tự set header hợp đồng `X-Nexus-Order-Contract: 2`. Phiên Console được dựng bằng `consoleRequest` (`tests/support/catalog-test-env.ts:217`) dựa trên session better-auth thật tạo bởi `tests/support/identity-test-env.ts:63` (`createConsoleSession`), có ghi `store_memberships` với `role` owner/staff.

---

## 3. Snippet integration test tiêu biểu

### 3.1 Idempotency của lệnh tạo Order (HTTP layer)

Nguyên văn `tests/integration/order-routes.test.ts:209-234`:

```ts
  it('replays a lost-response retry without duplicating the aggregate and rejects capability rebinding', async () => {
    const product = await createSimpleProduct();
    const idempotencyKey = 'order-route-retry-0001';
    const items = [{ productId: product.id, variantId: null, quantity: 3 }];
    const first = await createOrderRequest(items, idempotencyKey);
    const firstBody = await first.json();
    const retry = await createOrderRequest(items, idempotencyKey);

    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(await retry.json()).toEqual(firstBody);
    expect(await env.DB.prepare('SELECT count(*) AS count FROM orders').first<number>('count')).toBe(1);
    expect(await env.DB.prepare('SELECT count(*) AS count FROM order_lines').first<number>('count')).toBe(1);

    const conflict = await createOrderRequest(items, idempotencyKey, CAPABILITY_B);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      error: {
        code: 'idempotency_conflict',
        message: 'The idempotency key is already bound to another Order capability.',
        fields: [],
        incidentId: null,
      },
    });
    expect(await env.DB.prepare('SELECT count(*) AS count FROM orders').first<number>('count')).toBe(1);
  });
```

Test này chứng minh 3 contract cùng lúc:

1. **Retry an toàn**: cùng `Idempotency-Key` trả về *đúng body cũ* (`toEqual(firstBody)`), không phải chỉ "200 OK".
2. **Không nhân bản aggregate**: đếm trực tiếp `orders` và `order_lines` trong D1 — kiểm tra ở mức dữ liệu chứ không tin response.
3. **Khoá key theo chủ thể**: dùng lại key với capability khác phải `409 idempotency_conflict` và vẫn chỉ có 1 order. Đây là chống "key đụng nhau giữa 2 khách".

### 3.2 Snapshot giá và projection an toàn (domain + persistence layer)

Nguyên văn `tests/integration/orders-persistence.test.ts:147-162`:

```ts
    expect(order).toMatchObject({
      status: 'pending',
      items: [{
        position: 0,
        product: { id: product.id, name: 'Field Notes', variant: null },
        quantity: 2,
        unitPriceMinor: 2400,
        lineTotalMinor: 4800,
        currency: 'USD',
      }],
      totalMinor: 4800,
      currency: 'USD',
    });
    expect(order.paymentReference).toMatch(/^NP[a-f0-9]{18}$/);
    expect(order.items[0].id).toMatch(/^line_/);
    expect(await orderTableCounts()).toEqual([1, 1, 1, 1, 1, 1]);
```

Contract được chứng minh: tiền luôn là **minor unit integer**, `lineTotalMinor = unitPriceMinor * quantity`, `totalMinor` do server tính (client gửi `totalMinor` sai bị bỏ qua — xem `tests/integration/order-routes.test.ts:88`), và mỗi bảng trong aggregate có đúng 1 dòng. Dòng cuối của test còn khẳng định không rò dữ liệu riêng tư: `expect(JSON.stringify({ order, consoleOrders })).not.toMatch(/capability|accessTitle|accessInstructions|privateFileKey/);` (`tests/integration/orders-persistence.test.ts:201`).

### 3.3 Webhook thanh toán: xác nhận một lần, replay là no-op

`tests/integration/payfs-webhook.test.ts:192-243` gửi webhook, khẳng định `status: 'confirmed'`, order chuyển `paid`, đúng **1** dòng `order_history` với `action = 'order_paid'` (`:201-203`), **1** receipt (`:206`), **1** job email (`:207-209`); rồi gửi lại y hệt và khẳng định `{ status: 'already_processed' }` với số receipt vẫn là 1 (`:237-243`).

SOURCE còn có kỹ thuật test đua (race) bằng cách proxy `env.DB.batch` để giữ 2 transaction cùng chạy tới điểm commit rồi mới thả (`tests/integration/payfs-webhook.test.ts:142-167`), dùng để chứng minh "markPaid vs Cancel chỉ còn 1 quyết định, bên thua nhận 409" (`tests/integration/order-commands.test.ts:390`).

---

## 4. Playwright e2e: hai origin, hai dev server

`playwright.config.ts` tự khởi động cả hai app; không có bước "chạy tay trước rồi test".

Nguyên văn `playwright.config.ts:49-51` và `84-107`:

```ts
const checkConsolePort = `npx tsx scripts/verification/local-binding-context.ts check-port ${shellArgument(apiConsoleServer.hostname)} ${apiConsoleServer.port}`;
const checkStorefrontPort = `npx tsx scripts/verification/local-binding-context.ts check-port ${shellArgument(storefrontServer.hostname)} ${storefrontServer.port}`;
const applyMigrations = `npx wrangler d1 migrations apply nexus-s1-468cba-db --local --persist-to ${shellArgument(persistContext.cliPersistRoot)} --config wrangler.jsonc`;
// ...
  webServer: [
    {
      command: `${checkConsolePort} && ${applyMigrations} && npm run dev:console -- --host ${shellArgument(apiConsoleServer.hostname)} --port ${apiConsoleServer.port}`,
      url: apiConsoleServer.origin,
      env: {
        ...authRuntime,
        // The launched Worker takes its origins and auth secret from this harness only.
        // Wrangler must not fall back to the developer's `.dev.vars`, `.env`, or the rest of
        // the parent process environment, so both dotenv sources stay off for this server.
        [WORKER_ISOLATION_FLAG]: 'true',
        CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
        CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false',
      },
      reuseExistingServer: false,
    },
    {
      command: `${checkStorefrontPort} && npm run dev:storefront -- --host ${shellArgument(storefrontServer.hostname)} --port ${storefrontServer.port}`,
      url: storefrontServer.origin,
      env: {
        VITE_STOREFRONT_API_BASE_URL: apiBaseURL,
      },
      reuseExistingServer: false,
    },
  ],
```

Các quyết định đáng chú ý:

- **Hai project, hai base URL**: `console` match `console-*.spec.ts` với `baseURL` = origin Console (`playwright.config.ts:70-73`); `storefront` match `storefront-*.spec.ts` với `baseURL` = origin Storefront (`playwright.config.ts:77-80`). Storefront gọi API cross-origin, nên hai origin **bắt buộc khác nhau**, config throw nếu trùng (`playwright.config.ts:24-25`).
- **Migration là bước dựng server**, nối bằng `&&` trước `npm run dev:console` (`playwright.config.ts:86`).
- **Kiểm port trước**: `check-port` chạy qua `assertLoopbackPortAvailable` (`scripts/verification/local-binding-context.ts:60-78`); `reuseExistingServer: false` nên không bao giờ bám vào server dev đang chạy của lập trình viên (`playwright.config.ts:97`, `:105`).
- **Cô lập secret**: tắt `.dev.vars`/`.env` và process env kế thừa (`playwright.config.ts:94-95`); secret auth sinh ngẫu nhiên mỗi lần chạy (`playwright.config.ts:33-34`). Hành vi này còn được test lại ở tầng node: `tests/node/e2e-worker-isolation.test.ts:12-16` viết `.dev.vars` giả rồi khẳng định nó không lọt vào Worker.
- **State D1 riêng**: `persistRoot` mặc định `.wrangler/e2e-auth` (`playwright.config.ts:28-31`), phải là absolute và nằm dưới `.wrangler` của repo, không được kèm hậu tố `v3` (ràng buộc test tại `tests/e2e/console-auth.spec.ts:15-24`).
- **Chạy tuần tự**: `fullyParallel: false`, `workers: 1` (`playwright.config.ts:56-57`) vì hai app dùng chung một D1 local.

Session Console trong e2e **không đi qua Google thật**: fixture Playwright provision user + membership + cookie đã ký trực tiếp vào D1 local qua `getPlatformProxy` (`tests/support/console-auth-fixtures.ts:50`, `:77-80`; `scripts/verification/local-binding-context.ts:43-58`), scope `worker` nên chỉ provision một lần cho cả run (`tests/support/console-auth-fixtures.ts:185-196`). `signInConsole` còn verify cookie được chấp nhận bằng cách gọi `/api/console/session` trước khi test tiếp (`tests/support/console-auth-fixtures.ts:124`).

Khi cần kiểm chứng ở tầng DB, e2e đọc thẳng D1 local bằng CLI (nguyên văn `tests/e2e/storefront-orders.spec.ts:230-233`):

```ts
  const output = execFileSync('npx', [
    'wrangler', 'd1', 'execute', 'nexus-s1-468cba-db',
    '--local', '--persist-to', testPersistRoot(), '--config', 'wrangler.jsonc', '--json', '--command', sql,
  ], { encoding: 'utf8' });
```

Đổi cặp port mà không sửa `wrangler.jsonc` (`README.md:115-118`):

```sh
PLAYWRIGHT_API_CONSOLE_BASE_URL=http://127.0.0.1:5473 \
PLAYWRIGHT_STOREFRONT_BASE_URL=http://127.0.0.1:5474 \
npm run test:e2e
```

---

## 5. Evidence ledger và nhóm script verification

### Pattern

Đây là pattern **"ghi nhận bằng chứng thay vì tự tuyên bố done"**: mỗi tiêu chí nghiệm thu là một dòng trong sổ cái (ledger) CSV+JSON, phải trỏ tới artifact thật và mô tả kết quả quan sát được; không được suy ra "pass" từ việc lệnh exit 0. `README.md:137` nói thẳng: "The summary is report input only. It does not infer a pass from a command exit." Root `AGENTS.md:27` cấm tuyên bố đã deploy S4 khi chưa có bằng chứng migration/provisioning/smoke.

### Cơ chế

- Nguồn sự thật là manifest `design/reconciled-acceptance-manifest.md` (`scripts/verification/evidence-ledger.ts:14`), ledger nằm dưới `plans/.../reports/evidence` (`scripts/verification/evidence-ledger.ts:15`).
- `init` sinh một dòng cho mỗi ID với `command_or_scenario`, `observed` rỗng và `pass: null` (`scripts/verification/evidence-ledger.ts:173-180`), từ chối ghi đè trừ khi `--force` (`:166`).
- `check` chạy `validateRows` (`scripts/verification/evidence-ledger.ts:96`) và fail khi: ID trùng/thừa/thiếu (`:100-106`), sai lớp bằng chứng `P/L/R/C` (`:111-114`), lộ header bí mật hoặc object key riêng tư (`:115-117`, pattern tại `:17`), artifact trùng/sai phân loại/thiếu (`:120-137`).
- Chốt chặn quan trọng nhất (nguyên văn `scripts/verification/evidence-ledger.ts:138-142`):

```ts
    if (row.command_or_scenario.trim() === '') throw new Error(`${record.id} has no command or scenario.`);
    if (row.observed.trim().length < 12 || /^(?:exit\s*0|command passed|passed)$/i.test(row.observed.trim())) {
      throw new Error(`${record.id} needs a concrete observed result, not a command-exit claim.`);
    }
    if (row.pass !== true) throw new Error(`${record.id} is not explicitly passed from reviewed artifacts.`);
```

- `summary --output` xuất JSON làm input cho báo cáo, và từ chối ghi vào thư mục `evidence/private` (`scripts/verification/evidence-ledger.ts:206-213`).

Lệnh: `verification:ledger:init | :check | :summary` (`package.json:35-37`), dùng như `README.md:126-135`.

### Các script verification khác

| Script / lệnh | Mục đích | Khi nào chạy |
|---|---|---|
| `scripts/verification/verification-fixtures.ts` (`package.json:38`) | Quản lý manifest fixture dùng cho smoke test remote, validate prefix `verify-*`, origin `*.workers.dev`, object key (`scripts/verification/verification-fixtures.ts:12-14`); chỉ ghi vào thư mục evidence private (`:11`) | Trước/sau smoke test remote, làm input cho cleanup |
| `tests/integration/remote-contract-smoke.ts` (`package.json:39`) | Smoke hợp đồng API trên môi trường remote thật bằng tsx (không phải Vitest), chặn key riêng tư lọt vào response (`tests/integration/remote-contract-smoke.ts:34-35`) | Sau deploy, kiểm chứng contract catalog/CSV |
| `scripts/verification/s4-populated-rehearsal.ts` (`package.json:41`) | Diễn tập migration trên D1 local đã có dữ liệu: inject fault, kiểm rollback, kiểm re-apply là no-op, so digest bảo toàn dữ liệu (`scripts/verification/s4-populated-rehearsal.ts:32-52`) | Trước khi apply migration lên remote |
| `verification:s4-rehearsal:test` (`package.json:40`) | Chạy chính bài diễn tập đó dưới Vitest node pool | Trong bộ check thủ công |
| `scripts/provision-s4-identities.ts` (`package.json:44`) | Tạo identity owner/staff + membership; **dry-run mặc định**, chặn cứng mutation remote: `throw new Error('Remote mutation is not authorized by this operator command.')` (`scripts/provision-s4-identities.ts:38-40`), và đối chiếu tên D1/R2 với `resource-identities.json` (`:45-53`) | Chuẩn bị môi trường trước cutover |
| `scripts/assert-production-import-graph.ts` (`package.json:27`) | Gate build: chặn bundle production chạm vào module `design/`, `prototype*`, `scenario*`, `fixtures/` (`scripts/assert-production-import-graph.ts:12-13`, `:25-28`) | Mỗi lần `npm run build` |

---

## 6. CI: workflow và gate chặn merge

Chỉ có một workflow: `.github/workflows/deploy-console.yml`. Trigger: `pull_request`, `push` vào `main`, và `workflow_dispatch` (`:3-7`). Concurrency group `nexus-handson-production` với `cancel-in-progress: false` (`:12-14`) để không cắt ngang một lượt deploy.

Job `verify` (nguyên văn `.github/workflows/deploy-console.yml:17-29`):

```yaml
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run test:workerd
      - run: npm run build:console
      - run: npm run build:storefront:production
```

Gate chặn merge trên PR gồm đúng 3 thứ:

1. `npm run test:workerd` — unit + integration trong workerd (`package.json:19`).
2. `npm run build:console` — bên trong là `npm run typecheck && vite build && npm run assert:production-import-graph` (`package.json:23`), tức typecheck và gate import graph đều nằm trong bước build.
3. `npm run build:storefront:production` — build Storefront với API origin production (`package.json:26`).

**Không chạy trong CI**: `test:browser`, `test:e2e`, và nhóm `verification:*`. Chúng là check thủ công theo `README.md:93-102`. Đây là đánh đổi có chủ đích: e2e cần 2 server + D1 local nên bị đẩy ra khỏi đường merge.

Job `deploy` chỉ chạy khi `workflow_dispatch` hoặc push vào `main`, `needs: verify` (`.github/workflows/deploy-console.yml:31-33`), rồi lần lượt `migrate:production` → `deploy:console` → `deploy:storefront` (`:45-47`) với `CLOUDFLARE_API_TOKEN` từ secrets (`:36-37`).

Lưu ý mâu thuẫn có thật giữa CI và README: CI deploy theo thứ tự console-trước-storefront (`:46-47`), trong khi `README.md:157-168` yêu cầu thứ tự storefront-trước-console vì Console cần origin Storefront đã deploy. README cũng nói rõ "No deployment is claimed by this README" (`README.md:176`).

---

## 7. Quy trình dev hằng ngày

### 7.1 Cài đặt

```sh
npm ci
```

Node 22+ (`README.md:61-62`; `package.json:10-11` khai báo `"node": ">=22"`). Toolchain được pin và liệt kê tại `README.md:69`.

### 7.2 Apply migration vào D1 local

```sh
npx wrangler d1 migrations apply nexus-s1-468cba-db --local
```

(`README.md:76`). Phải chạy từ repo root để resolve qua root `wrangler.jsonc` (`README.md:73`, `AGENTS.md:7`). Tên DB local lấy từ `wrangler.jsonc:33` (`database_name: "nexus-s1-468cba-db"`).

### 7.3 Chạy 2 app local

```sh
# Terminal 1: API and Console
npm run dev:console -- --host 127.0.0.1 --port 5173

# Terminal 2: Storefront
VITE_STOREFRONT_API_BASE_URL=http://127.0.0.1:5173 npm run dev:storefront -- --host 127.0.0.1 --port 5174
```

(nguyên văn `README.md:82-86`). Hai port này khớp `CONSOLE_ORIGIN`/`STOREFRONT_ORIGIN` trong `wrangler.jsonc:17-19`, nên đổi port thì phải đổi kèm biến môi trường. Worker phục vụ Console qua binding `assets` với SPA fallback và `run_worker_first` cho `/api` (`wrangler.jsonc:8-16`), entry Worker là `apps/worker/src/index.ts` (`wrangler.jsonc:4`). Mở `/console/products` hoặc `/console/orders` trên origin Console, `/` trên origin Storefront (`README.md:89`).

### 7.4 Seed dữ liệu

SOURCE **không có script seed** trong `package.json:13-45`. Dữ liệu được tạo theo 3 đường:

- Migration `0001` tự tạo Store bootstrap `store_nexus` (được khẳng định bởi `tests/integration/migration-constraints.test.ts:13-16`).
- E2E tự tạo Product qua UI Console (`tests/e2e/storefront-orders.spec.ts:57-63`) và insert product sentinel thẳng vào D1 trong fixture (`tests/support/console-auth-fixtures.ts:103-118`).
- Fixture dữ liệu lớn cho diễn tập nằm ở `tests/fixtures/s4-populated-store.ts`, dùng bởi `scripts/verification/s4-populated-rehearsal.ts:8`.

### 7.5 Bộ check trước khi mở PR

```sh
npm run typecheck
npm run test:unit
npx vitest run --config vitest.node.config.ts
npm run test:integration
npm run test:browser
npm run test:e2e
npm run build:console
VITE_STOREFRONT_API_BASE_URL=http://127.0.0.1:5173 npm run build:storefront
```

(nguyên văn `README.md:93-102`).

### 7.6 Deploy và migration remote

- Kiểm tra tài nguyên trước khi mutate: `npx wrangler whoami`, `npx wrangler d1 list`, `npx wrangler r2 bucket list` (`README.md:149-153`). Không tạo tài nguyên thay thế khi identity mơ hồ (`README.md:155`).
- Migration remote: `npm run migrate:production` → `wrangler d1 migrations apply nexus-handson-akbuild-db --remote --env production` (`package.json:31`); bản thủ công là `npx wrangler d1 migrations apply "$D1_DATABASE_NAME" --remote` (`README.md:161`). Không bao giờ sửa migration đã apply (`README.md:160`, `:170`).
- Deploy Storefront: `npm run deploy:storefront` (`package.json:33`) — build với `VITE_STOREFRONT_API_BASE_URL` production (`package.json:26`) rồi `wrangler deploy --config apps/storefront/wrangler.jsonc`.
- Deploy Console/API: `npm run deploy:console` (`package.json:32`) — build với `CLOUDFLARE_ENV=production` rồi deploy **file wrangler được sinh ra** `apps/console/dist/nexus_s1_468cba/wrangler.json`, không phải root config; `README.md:106` cảnh báo không được chạy `wrangler deploy` trần ở root.
- Trước deploy phải đăng ký origin và redirect URI Google OAuth (`README.md:106`).

---

## Áp dụng cho QR Menu

### Điểm bê nguyên được

| Pattern SOURCE | Vì sao dùng lại cho QR Menu |
|---|---|
| Phân tầng `unit / integration / browser / e2e` + cấm đưa `support/`, `fixtures/` vào discovery (`tests/AGENTS.md:5`) | Cùng hình dạng rủi ro: logic tiền/trạng thái thuần, D1 atomicity, UI contract, hành trình 2 origin (khách quét QR vs bếp) |
| `@cloudflare/vitest-pool-workers` với `d1Databases: ['DB']`, `r2Buckets: ['FILES']` (`vitest.config.ts:6-12`) | TARGET cũng chạy D1 + R2; test webhook PayFS phải chạy trong workerd để giống runtime thật |
| `resetCatalog` = drop bảng + apply lại migration (`tests/support/catalog-test-env.ts:117-156`) | Đơn giản, không phụ thuộc transaction; đủ nhanh vì D1 test là in-memory |
| Tham số `through` để test migration theo mốc (`tests/support/catalog-test-env.ts:113-115`) | Menu/giá sẽ đổi schema nhiều lần; cần chứng minh đơn cũ không hỏng sau migration |
| Playwright tự dựng 2 webServer + apply migration trong `command` (`playwright.config.ts:86`) | TARGET có storefront (khách) và console (bếp) ở 2 origin |
| Fixture provision session ghi thẳng vào D1 local qua `getPlatformProxy` (`tests/support/console-auth-fixtures.ts:77-80`) | Tránh phụ thuộc Google OAuth thật trong e2e, vẫn dùng better-auth thật |
| Cô lập secret khỏi `.dev.vars` trong e2e (`playwright.config.ts:94-95`) | TARGET có PayFS webhook secret + Resend key, không được để dev machine làm lệch kết quả |
| Evidence ledger: cấm "exit 0 = pass" (`scripts/verification/evidence-ledger.ts:138-142`) | Áp cho checklist nghiệm thu PRD |

### Điểm phải đổi

1. **Framework**: PRD TARGET ghi `apps/storefront`/`apps/console` là Next.js trên Cloudflare Pages (`docs/PRD.md:35-36`), còn SOURCE là Vite SPA + Worker `assets` binding (`wrangler.jsonc`, `README.md:3`). `@cloudflare/vitest-pool-workers` test **một Worker entry**; với Next.js phải hoặc (a) tách API sang một Worker riêng có entry rõ ràng để integration test import trực tiếp như `tests/support/catalog-test-env.ts:164` làm, hoặc (b) test route handler như hàm thuần. Khuyến nghị (a): giữ nguyên được toàn bộ pattern `workerRequest`.
2. **ORM**: PRD TARGET dùng Drizzle (`docs/PRD.md:37`), SOURCE dùng raw SQL. Drizzle vẫn hợp: `drizzle-kit generate` sinh file SQL đánh số, `applyD1Migrations` vẫn tiêu thụ được — nhưng **bỏ được** parser `splitMigrationSql` (`tests/support/catalog-test-env.ts:28`) nếu dùng `readD1Migrations` của `@cloudflare/vitest-pool-workers` thay vì import `?raw`. Nếu migration có `CREATE TRIGGER`, phải kiểm lại việc tách câu lệnh.
3. **Package**: SOURCE chia `@nexus/catalog|orders|identity`; TARGET có một `packages/core`. Alias trong test config phải trỏ `@qr/core` thay vì 3 package.
4. **Tên tài nguyên**: mọi lệnh có hard-code `nexus-s1-468cba-db` (`playwright.config.ts:51`, `tests/e2e/storefront-orders.spec.ts:231`) phải đổi sang tên D1 của TARGET; nên đưa vào một hằng số chung thay vì rải rác.
5. **CI**: SOURCE để browser + e2e ngoài CI (`.github/workflows/deploy-console.yml:27-29`). Với QR Menu, luồng khách đặt món là luồng tiền — nên đưa **ít nhất 1 e2e "quét QR → đặt món → bếp thấy đơn"** vào gate PR.
6. **Webhook local**: SOURCE test webhook hoàn toàn trong workerd, không cần tunnel. PRD TARGET dự kiến `cloudflared` (`docs/PRD.md:41`) — tunnel chỉ cần cho verify thủ công với PayFS thật; **không** để e2e phụ thuộc tunnel, hãy gọi thẳng endpoint webhook như `tests/integration/payfs-webhook.test.ts:77-87`.

### Bộ tối thiểu dựng ngay ngày 1

Cấu hình:

- `vitest.config.ts` — pool workers, `d1Databases: ['DB']`, `r2Buckets: ['FILES']`, include `tests/unit/**` + `tests/integration/**` (copy khung `vitest.config.ts` của SOURCE).
- `vitest.browser.config.ts` — chỉ khi bắt đầu viết UI contract test (copy `vitest.browser.config.ts:4-13`).
- `playwright.config.ts` — 2 project `console`/`storefront`, 2 `webServer`, `workers: 1`, apply migration trong `command`.
- `tests/cloudflare-test-env.d.ts` — khai báo `DB`, `FILES` (copy `tests/cloudflare-test-env.d.ts:1-6`).
- `tests/support/test-env.ts` — `resetDb()` (drop + re-apply, kể cả `d1_migrations`), `workerRequest()`, `consoleSession({ role })`.
- `tests/AGENTS.md` — chép ràng buộc phân tầng (`tests/AGENTS.md:5-7`).

Scripts `package.json`:

```
"test":             "npm run test:workerd && npm run test:browser"
"test:workerd":     "vitest run"
"test:unit":        "vitest run tests/unit"
"test:integration": "vitest run tests/integration"
"test:browser":     "vitest run --config vitest.browser.config.ts"
"test:e2e":         "playwright test"
"typecheck":        "tsc --noEmit"
"db:migrate:local": "wrangler d1 migrations apply <DB_NAME> --local"
"db:migrate:prod":  "wrangler d1 migrations apply <DB_NAME> --remote --env production"
"dev:console"       /  "dev:storefront"
"deploy:console"    /  "deploy:storefront"
```

(khuôn theo `package.json:14-44`; CI gate tối thiểu = `typecheck` + `test:workerd` + 2 build, theo `.github/workflows/deploy-console.yml:26-29`.)

### 5 test case bắt buộc

| # | Test case | Tầng | Khuôn mẫu SOURCE | Khẳng định tối thiểu |
|---|---|---|---|---|
| 1 | **Tính tổng tiền đơn** — nhiều món, nhiều số lượng, cùng `currency` VND | unit (công thức) + integration (persist) | `tests/unit/money.test.ts:5-13`, `tests/integration/orders-persistence.test.ts:147-159` | `line_total = unit_price * qty` theo **integer minor unit**; `order.total` do server tính; client gửi `total` sai bị bỏ qua (`tests/integration/order-routes.test.ts:88`); sai định dạng tiền ném lỗi rõ ràng |
| 2 | **Snapshot giá** — đổi giá món sau khi đặt, đơn cũ giữ nguyên giá | integration | `tests/integration/orders-persistence.test.ts:147-162` + kiểu test migration ở `:650` | Sau khi `UPDATE products SET price=...`, đọc lại đơn cũ vẫn ra `unit_price` cũ; đơn mới ra giá mới; đơn cũ sống sót qua migration |
| 3 | **Idempotency đặt món / webhook** — retry mất response và replay webhook | integration | `tests/integration/order-routes.test.ts:209-234`; `tests/integration/payfs-webhook.test.ts:237-243` | Retry cùng key ⇒ **cùng body**, `count(orders)` và `count(order_items)` không tăng; key dùng lại cho bàn/khách khác ⇒ `409`; webhook replay ⇒ `already_processed`, số receipt và số dòng `order_history` không đổi |
| 4 | **Chuyển trạng thái trái phép** — ví dụ `canceled → paid`, `pending → served` | integration | `tests/integration/order-commands.test.ts:358-388` | Lệnh sai trạng thái `rejects` với code ổn định kiểu `order_state_conflict` + HTTP 409; **không** ghi payment/history mới; đọc lại trạng thái vẫn là trạng thái cũ |
| 5 | **Quyền staff/owner** — staff (bếp) vs owner (chủ quán) | unit (policy) + integration (route) | `tests/unit/permissions.test.ts:39-48`; `tests/integration/payfs-webhook.test.ts:246-283` | Owner làm được mọi action; staff chỉ đọc menu + xử lý đơn được giao, **không** sửa menu/duyệt refund; response cho staff **không** chứa payload nhạy cảm (`expect(...).not.toHaveProperty('payloadJson')` như `tests/integration/payfs-webhook.test.ts:277`) |

Bổ sung khuyến nghị (không bắt buộc ngày 1): một e2e `storefront-order.spec.ts` đi trọn "quét QR bàn → chọn món → đặt → console bếp thấy đơn", theo khuôn `tests/e2e/storefront-orders.spec.ts` và đọc lại D1 bằng `wrangler d1 execute --local --json` (`tests/e2e/storefront-orders.spec.ts:230-233`) để xác nhận dữ liệu, không chỉ tin UI.
