## Kết luận cho người lập kế hoạch

- `betterAuth({ database: env.DB })` port **nguyên cấu hình** từ `docs/reference/nexus/03-better-auth-google-oauth.md:16-103` (bao gồm `disableSignUp:true`, `disableIdTokenSignIn:true`, `accountLinking.enabled:false`, `rateLimit.storage:'database'`, `advanced.database.validateSchema:true`) — không có option nào bỏ được, đây chính là D15 (`docs/decisions/260919-post-xia-decision-record.md:239-246`).
- **Có 2 cổng chặn Google user lạ, KHÔNG phải 1**: Cổng 1 (`getUserInfo`) gọi `admitGoogleOwner` nhưng `catch { return result; }` **nuốt lỗi** (`docs/reference/nexus/03-better-auth-google-oauth.md:73-103,981-983`) — đây **không phải** lớp fail-closed thật. Cổng 2 (`validateUserInfo`, `docs/reference/nexus/03-better-auth-google-oauth.md:22-32,107-124`) mới là chốt fail-closed thật: dù cổng 1 lỗi, callback vẫn bị từ chối nếu `sub` không bind tới `store_memberships.status='active'` khớp email. Kế hoạch thi công **phải viết cả 2**, không được coi cổng 1 là đủ.
- Bootstrap Owner đầu tiên dùng `store_bootstrap_claims` với `store_id` là PRIMARY KEY (`docs/reference/nexus/03-better-auth-google-oauth.md:304-321`) + điều kiện `NOT EXISTS` trong guarded INSERT (`docs/reference/nexus/03-better-auth-google-oauth.md:671-709`) — hai lớp chống race độc lập, không lớp nào thay được lớp kia.
- Invitation cho TARGET **phải mời được cả staff** (khác SOURCE chỉ mời owner) — có đúng 4 chỗ phải sửa đồng bộ, liệt kê ở `docs/reference/nexus/03-better-auth-google-oauth.md:1064-1074`; bỏ sót 1 trong 4 là vỡ luồng mời staff.
- RBAC: `store_memberships` là nguồn sự thật duy nhất, giải lại từ DB **mỗi request** bằng `resolveActiveMembership` — không tin cookie/session cache (D15, `docs/decisions/260919-post-xia-decision-record.md:242`; `docs/reference/nexus/03-better-auth-google-oauth.md:475-517`).
- Console cùng origin với API (F10, D15) ⇒ cookie `credentials:'same-origin'`, không cross-origin; cookie refresh (`Set-Cookie`) phải forward trên **mọi** response kể cả lỗi 403 — chỉ 401 (hết hạn) mới xoá cookie (`docs/reference/nexus/03-better-auth-google-oauth.md:973-975,985-987`).
- Storefront khác origin, CORS **không** `Access-Control-Allow-Credentials`; vì TARGET dùng `table_token` qua header tuỳ chỉnh (không phải cookie) nên có preflight — bắt buộc set `Access-Control-Max-Age` để không tốn 1 RTT mỗi request (D17, `docs/decisions/260919-post-xia-decision-record.md:254-282`; cơ chế preflight tại `docs/reference/nexus/03-better-auth-google-oauth.md:949-951`).
- D21: mọi origin (CONSOLE_ORIGIN, STOREFRONT_ORIGIN, redirect_uri Google, cookie domain) đọc từ biến môi trường — **cấm hard-code hostname**; dấu hiệu lỗi cutover là `redirect_uri_mismatch` (`docs/decisions/260919-post-xia-decision-record.md:309-321`).
- Numbering D trong `docs/decisions/260919-post-xia-decision-record.md` là bản MỚI, khác numbering trong `plans/reports/260919-xia-nexus-handson-reference.md` — report này chỉ trích D15/D17/D20/D21 theo Decision Record mới.
- Thứ tự migration cụ thể (số hiệu file) cho 3 bảng auth/membership/bootstrap-invitation **chưa chốt** trong 3 tài liệu đã đọc — xem mục Câu hỏi còn mở.

## Pattern bắt buộc

| Hạng mục | Cách làm cụ thể | Trích dẫn |
| --- | --- | --- |
| Cấu hình `createAuth(env)` | `database: env.DB`; `baseURL: env.CONSOLE_ORIGIN`; `secret: env.BETTER_AUTH_SECRET` (từ chối nếu ngắn hơn 32 ký tự — kiểm ở tầng invitation); `plugins: [ownerInvitationOAuthPlugin(env)]`; `socialProviders` chỉ có `google` và chỉ khi có đủ client id+secret (thiếu ⇒ object rỗng ⇒ 503 `auth_not_configured`, fail closed); `account: { encryptOAuthTokens: true, accountLinking: { enabled: false } }`; `trustedOrigins: [env.CONSOLE_ORIGIN]`; `rateLimit: { enabled: true, storage: 'database' }`; `advanced: { database: { validateSchema: true }, ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] } }` | `docs/reference/nexus/03-better-auth-google-oauth.md:16-64,105-124` |
| Google provider wrapper | `google({ clientId, clientSecret, prompt: 'select_account', disableSignUp: true, disableIdTokenSignIn: true })`, bọc thêm `getUserInfo` gọi `admitGoogleOwner` **trước khi** trả kết quả cho better-auth | `docs/reference/nexus/03-better-auth-google-oauth.md:73-103` |
| Cổng 1 — admission (KHÔNG fail-closed thật) | `getUserInfo` gọi `admitGoogleOwner({ database, profile, initialOwnerEmail, invitationContext })`; **nuốt lỗi** bằng `catch { return result; }` nên user lạ vẫn có thể đi tiếp nếu chỉ dựa cổng này | `docs/reference/nexus/03-better-auth-google-oauth.md:73-103,981-983` |
| Cổng 2 — `validateUserInfo` (fail-closed THẬT) | Chỉ chạy khi `source.method==='oauth'`; từ chối nếu `providerId!=='google'` hoặc `emailVerified!==true` hoặc thiếu `sub`; sau đó `SELECT user.email FROM account JOIN "user" ON user.id=account.userId JOIN store_memberships ON membership.user_id=user.id WHERE account.providerId='google' AND account.accountId=? AND membership.status='active'` rồi so `binding.email.toLowerCase()===user.email.trim().toLowerCase()` | `docs/reference/nexus/03-better-auth-google-oauth.md:22-32,616-655` (nguyên văn tại đọc lần đầu, `apps/worker/src/auth.ts:107-131` theo SOURCE) |
| Thứ tự kiểm | OAuth callback → `getUserInfo` (cổng 1, tạo authority nếu đủ điều kiện) → better-auth nội bộ tạo/tìm session → `validateUserInfo` (cổng 2, chặn cứng) → nếu cổng 2 pass mới `INSERT session` | sequence diagram `docs/reference/nexus/03-better-auth-google-oauth.md:434-472` |
| Thông báo lỗi giống hệt nhau | `{ error: 'access_denied', errorDescription: 'This Google account cannot access the Console.' }` dùng cho **mọi** nguyên nhân từ chối ở cổng 2, không phân biệt lý do (để không lộ có invitation hay không) | `docs/reference/nexus/03-better-auth-google-oauth.md:616,650-655` |
| Bootstrap — chống race lớp 1 | Guarded INSERT `"user"`/`account`/`store_memberships` dùng `CASE WHEN <eligibilitySql> THEN ? ELSE NULL END` cho cột PK `NOT NULL`; `eligibilitySql` cho bootstrap = `EXISTS(SELECT 1 FROM stores WHERE id=?) AND NOT EXISTS(SELECT 1 FROM store_bootstrap_claims WHERE store_id=?)` | `docs/reference/nexus/03-better-auth-google-oauth.md:146-181,671-693` |
| Bootstrap — chống race lớp 2 | `store_bootstrap_claims.store_id` là PRIMARY KEY; callback song song thứ 2 vi phạm PK ⇒ **abort cả batch** ⇒ rơi vào `catch` ⇒ `reconcileAdmission` đọc lại và so `claim.user_id !== identity.userId` ⇒ `denied` | `docs/reference/nexus/03-better-auth-google-oauth.md:304-321,671-709` |
| Bootstrap lần hai | Google identity thứ hai (kể cả đúng `INITIAL_OWNER_EMAIL`) gọi lại `claimBootstrap`: `existing` (đã có identity bound) ⇒ `{ kind: 'denied' }` ngay; nếu là race thật (2 callback đồng thời, chưa ai `existing`) thì một trong hai vi phạm PK ⇒ batch abort ⇒ `reconcileAdmission` trả `denied` | `docs/reference/nexus/03-better-auth-google-oauth.md:671-693` (điều kiện `if (existing) return { kind: 'denied' };`) |
| Invitation — sinh token | 32 byte CSPRNG, base64url không padding | `docs/reference/nexus/03-better-auth-google-oauth.md:715-724` |
| Invitation — 2 dẫn xuất tách biệt | `token_digest = sha256Hex(token)` dùng để **tra cứu**; `context_hmac = HMAC(HMAC(BETTER_AUTH_SECRET, INFO), token)` dùng làm giá trị **duy nhất cất vào OAuth server state**, client không tính được; DB CHECK `context_hmac != token_digest` | `docs/reference/nexus/03-better-auth-google-oauth.md:726-733`, CHECK tại `docs/reference/nexus/03-better-auth-google-oauth.md:323-360` |
| Invitation — TTL & one-time | `OWNER_INVITATION_TTL_MS = 7*24*60*60*1000`; state machine cưỡng chế bằng CHECK 3 trạng thái hợp lệ duy nhất: pending (`revoked_at IS NULL AND consumed_at IS NULL`), revoked, consumed (`consumed_at/membership_id/user_id` đều NOT NULL) | TTL: `docs/reference/nexus/03-better-auth-google-oauth.md:1088-1097` (mục checklist nhắc lại), CHECK: `docs/reference/nexus/03-better-auth-google-oauth.md:323-360` |
| Invitation — ràng buộc không mời trùng | INSERT `owner_invitations` dùng `CASE WHEN EXISTS(issuer là owner active) AND NOT EXISTS(SELECT 1 FROM "user" WHERE email=?) THEN ? ELSE NULL END` cho cột `id` PK — identity đã bind (user/staff/revoked) không mời lại được | `docs/reference/nexus/03-better-auth-google-oauth.md:1066-1067` dẫn `invitations.ts:142-144`; xác nhận tại D20 `docs/decisions/260919-post-xia-decision-record.md:296` |
| Invitation — tiêu thụ one-time | Guarded batch: tạo user/account/membership qua `ownerBindingStatements` với `eligibilitySql` kiểm invitation `context_hmac=? AND store_id=? AND target_email=? AND revoked_at IS NULL AND consumed_at IS NULL AND expires_at>?`; **đồng thời** `UPDATE owner_invitations SET consumed_at = CASE WHEN <cùng điều kiện + membership vừa tạo đúng role> THEN ? ELSE NULL END, consumed_membership_id=?, consumed_user_id=?` — sai điều kiện ⇒ `consumed_at=NULL` nhưng `consumed_membership_id` khác NULL ⇒ vi phạm CHECK `owner_invitations_state` ⇒ abort batch. Replay lần 2 luôn fail vì `consumed_at IS NULL` không còn đúng | `docs/reference/nexus/03-better-auth-google-oauth.md:809-859` |
| Invitation — link | Token nằm trong **URL fragment** `#invite=<token>`, response tạo invitation có header `Referrer-Policy: no-referrer`; client SPA đọc fragment rồi `history.replaceState` xoá khỏi URL hiển thị ngay | `docs/reference/nexus/03-better-auth-google-oauth.md` (đoạn trích `console-owner-invitation-routes.ts:46-53` và `auth-client.ts:46-57`, nằm trong mục 5.3, dòng ~745-783) |
| `evaluatePermission` | Hàm thuần `(context: IdentityContext, action: string, resource: PermissionResource) => boolean`; `isKnownAction` đọc từ tập action của Owner (action lạ ⇒ false); `context.storeId !== resource.storeId` chặn cross-store trước mọi kiểm tra khác; `context.kind==='customer'` chỉ cho action của khách trên đúng `resource.customerId`; role `owner` full quyền trong `OWNER_ACTIONS`; role `staff` = `STAFF_STORE_ACTIONS` (không cần assigned) **hợp** `STAFF_ASSIGNED_ACTIONS` khi `resource.assignedUserId===context.userId` | `docs/reference/nexus/03-better-auth-google-oauth.md:530-583` |
| `resolveActiveMembership` | `SELECT ... WHERE user_id=? AND status='active' ORDER BY id LIMIT 2` — 0 hàng ⇒ `absent`, ≥2 hàng ⇒ `ambiguous` (không chọn bừa), đúng 1 ⇒ `resolved` | `docs/reference/nexus/03-better-auth-google-oauth.md:475-517` |
| Cookie refresh forward mọi response | `resolveConsoleRequestContext` gom mọi `Set-Cookie` từ `api.getSession({ headers, returnHeaders:true })` vào `authHeaders`; hàm `withConsoleAuthHeaders` ghép `authHeaders` vào **mọi** response kể cả response lỗi (403, 503) | `docs/reference/nexus/03-better-auth-google-oauth.md:475-517,973-975` |
| 403 giữ cookie / 401 xoá cookie | Ánh xạ: `unauthenticated` (session null từ `getSession`) → HTTP 401, cookie hết hạn bị better-auth set `Max-Age=0`; `store-access-denied` (`resolveActiveMembership` không `resolved`) → HTTP 403, cookie **không đổi** vì session vẫn hợp lệ, chỉ membership bị revoke | `docs/reference/nexus/03-better-auth-google-oauth.md:985-987` |
| CSRF thủ công (bổ sung `trustedOrigins`) | `consoleOriginAllowed(request, consoleOrigin)`: GET/HEAD luôn qua; POST bắt buộc `Origin === consoleOrigin` **và** (`Sec-Fetch-Site` là null hoặc `'same-origin'`) — áp cho cả `/api/auth/*` POST và `/api/console/*` POST | `docs/reference/nexus/03-better-auth-google-oauth.md:934-948` |
| Route allowlist trước session | `isKnownConsoleRequest(request)` kiểm method + regex path nằm trong danh sách route đã khai báo; sai ⇒ 404 **trước khi** đọc session — tránh lộ thông tin qua timing/behavior của route không tồn tại | `docs/reference/nexus/03-better-auth-google-oauth.md:584-616` |
| Route mời — check role trực tiếp, không qua `evaluatePermission` | `if (context.identity.role !== 'owner' \|\| context.identity.membershipStatus !== 'active' \|\| context.identity.storeId !== STORE_ID) return 403 issuer_not_owner` | `docs/reference/nexus/03-better-auth-google-oauth.md:616-655` (đoạn route mời trong mục 4.3) |
| Response `/api/auth/*` | Xoá `Content-Length`; set `Cache-Control: no-store` + `Referrer-Policy: no-referrer` trên **mọi** response của prefix này | `docs/reference/nexus/03-better-auth-google-oauth.md:977-979` |
| CORS storefront | Chỉ set `Access-Control-Allow-Origin/Headers/Methods` + `Vary: Origin`; **không** `Access-Control-Allow-Credentials`; preflight siết theo cặp path↔method cụ thể; header ngoài allowlist bị từ chối; cần thêm header token bàn (`table_token`) vào allowlist và set `Access-Control-Max-Age` để đỡ 1 RTT mỗi request | `docs/reference/nexus/03-better-auth-google-oauth.md:949-951,1021-1028`; yêu cầu Max-Age từ D17 `docs/decisions/260919-post-xia-decision-record.md:279-282` |
| Không hard-code origin | Mọi origin (`CONSOLE_ORIGIN`, `STOREFRONT_ORIGIN`, redirect_uri Google, cookie domain implicit) đọc từ biến môi trường/`wrangler.jsonc` `vars`, một tên biến — một chỗ | D21 `docs/decisions/260919-post-xia-decision-record.md:309-321` |

## Hình dạng file/config/SQL cần tạo

**`migrations/000X-better-auth-core.sql`** (copy nguyên văn structure từ `docs/reference/nexus/03-better-auth-google-oauth.md:189-247`, chỉ đổi số thứ tự migration theo điều phối toàn cục — xem Câu hỏi còn mở):
```sql
CREATE TABLE "user" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL UNIQUE,
  "emailVerified" INTEGER NOT NULL,
  "image" TEXT,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL
);
-- + session, account, verification, rateLimit (5 bảng, xem trích dẫn) + 3 index thường
-- + 2 unique index Google binding (từ 0011): account(providerId,accountId) và account(userId,providerId)
```
Quote đầy đủ 5 CREATE TABLE + 3 index thường: `docs/reference/nexus/03-better-auth-google-oauth.md:189-247`. Quote 2 unique index: `docs/reference/nexus/03-better-auth-google-oauth.md:251-262`.

**`migrations/000X-store-memberships.sql`** (xương sống, mẫu tại `docs/reference/nexus/03-better-auth-google-oauth.md:268-298`):
```sql
CREATE TABLE store_memberships (
  id TEXT PRIMARY KEY NOT NULL,
  store_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','staff')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revoked_at TEXT,
  CONSTRAINT store_memberships_store_fk FOREIGN KEY (store_id) REFERENCES stores(id),
  CONSTRAINT store_memberships_user_fk FOREIGN KEY (user_id) REFERENCES "user"("id"),
  CONSTRAINT store_memberships_id_store_unique UNIQUE (id, store_id),
  CONSTRAINT store_memberships_user_store_unique UNIQUE (user_id, store_id),
  CONSTRAINT store_memberships_status_time CHECK (
    (status='active' AND revoked_at IS NULL) OR (status='revoked' AND revoked_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX store_memberships_one_active_user ON store_memberships (user_id) WHERE status='active';
CREATE INDEX store_memberships_store_role_status_idx ON store_memberships (store_id, role, status, user_id);
```
Giữ `store_memberships_one_active_user` cho MVP một quán (D4: `store_id` hằng); ghi comment cảnh báo bỏ nếu multi-tenant, theo cảnh báo tại `docs/reference/nexus/03-better-auth-google-oauth.md:1076-1084`.

**`migrations/000X-bootstrap-and-invitations.sql`** (mẫu tại `docs/reference/nexus/03-better-auth-google-oauth.md:304-360`, **nới CHECK role**):
```sql
CREATE TABLE store_bootstrap_claims (
  store_id TEXT PRIMARY KEY NOT NULL,
  membership_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  claimed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT store_bootstrap_claims_store_fk FOREIGN KEY (store_id) REFERENCES stores(id),
  CONSTRAINT store_bootstrap_claims_membership_fk FOREIGN KEY (membership_id, store_id) REFERENCES store_memberships(id, store_id),
  CONSTRAINT store_bootstrap_claims_user_fk FOREIGN KEY (user_id) REFERENCES "user"("id"),
  CONSTRAINT store_bootstrap_claims_membership_unique UNIQUE (membership_id),
  CONSTRAINT store_bootstrap_claims_user_unique UNIQUE (user_id)
);

CREATE TABLE owner_invitations (
  id TEXT PRIMARY KEY NOT NULL,
  store_id TEXT NOT NULL,
  token_digest TEXT NOT NULL CHECK (length(token_digest)=64 AND token_digest NOT GLOB '*[^0-9a-f]*'),
  context_hmac TEXT NOT NULL CHECK (length(context_hmac)=64 AND context_hmac NOT GLOB '*[^0-9a-f]*' AND context_hmac != token_digest),
  target_email TEXT NOT NULL CHECK (length(target_email) BETWEEN 3 AND 320 AND target_email = lower(target_email)),
  role TEXT NOT NULL CHECK (role IN ('owner','staff')), -- KHÁC SOURCE: nới cho staff (D20)
  issuer_membership_id TEXT NOT NULL,
  issuer_user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  consumed_at TEXT,
  consumed_membership_id TEXT,
  consumed_user_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT owner_invitations_state CHECK (
    (revoked_at IS NULL AND consumed_at IS NULL AND consumed_membership_id IS NULL AND consumed_user_id IS NULL)
    OR (revoked_at IS NOT NULL AND consumed_at IS NULL AND consumed_membership_id IS NULL AND consumed_user_id IS NULL)
    OR (revoked_at IS NULL AND consumed_at IS NOT NULL AND consumed_membership_id IS NOT NULL AND consumed_user_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX owner_invitations_token_digest_unique ON owner_invitations (token_digest);
CREATE UNIQUE INDEX owner_invitations_context_hmac_unique ON owner_invitations (context_hmac);
CREATE INDEX owner_invitations_pending_lookup_idx ON owner_invitations (store_id, token_digest, target_email, expires_at)
  WHERE revoked_at IS NULL AND consumed_at IS NULL;
```
Bỏ `CHECK (store_id = 'store_nexus')` của SOURCE — TARGET truyền `storeId` qua tham số thay vì hằng số (khuyến nghị `docs/reference/nexus/03-better-auth-google-oauth.md:1076-1084`), nhưng vẫn giữ `store_id` PRIMARY KEY của `store_bootstrap_claims` để one-shot mỗi store.

**`packages/identity/src/identity-types.ts`** — `StoreRole = 'owner'|'staff'`, `MembershipStatus = 'active'|'revoked'`, `IdentityContext` union (`console`|`customer`|`public`), `PermissionAction`, `OWNER_INVITATION_TTL_MS = 7*24*60*60*1000` (`docs/reference/nexus/03-better-auth-google-oauth.md:522-527,1088-1097`).

**`packages/identity/src/permissions.ts`** — action set rút gọn cho MVP QR Menu (khuyến nghị chính thức tại `docs/reference/nexus/03-better-auth-google-oauth.md:1029-1053`):
```ts
const OWNER_ACTIONS = new Set<PermissionAction>([
  'menu:read','menu:write','menu:image:write','menu:stock:toggle',
  'table:read','table:write','table:qr:export',
  'order:read','order:accept','order:prepare','order:fulfill','order:assign',
  'refund:request','refund:decide','report:read',
]);
const STAFF_STORE_ACTIONS = new Set<PermissionAction>(['menu:read','table:read','order:read']);
const STAFF_ASSIGNED_ACTIONS = new Set<PermissionAction>(['order:accept','order:prepare','order:fulfill','refund:request']);
const CUSTOMER_ACTIONS = new Set<PermissionAction>(['order:read','refund:request']);

export function evaluatePermission(context: IdentityContext, action: string, resource: PermissionResource): boolean {
  if (!isKnownAction(action)) return false;
  if (context.kind === 'public') return false;
  if (context.storeId !== resource.storeId) return false;
  if (context.kind === 'customer') return resource.customerId === context.customerId && CUSTOMER_ACTIONS.has(action);
  if (context.membershipStatus !== 'active') return false;
  if (context.role === 'owner') return OWNER_ACTIONS.has(action);
  if (context.role === 'staff') {
    if (STAFF_STORE_ACTIONS.has(action)) return true;
    return resource.assignedUserId === context.userId && STAFF_ASSIGNED_ACTIONS.has(action);
  }
  return false;
}
```
Lưu ý khớp MVP: `report:read` chỉ có ở `OWNER_ACTIONS` — Staff không xem báo cáo doanh thu (PRD §2.3.4 chỉ giao Owner). Danh sách `menu CRUD, table/QR, order transition, refund:request, refund:decide` theo yêu cầu Acceptance đã có đủ trong set trên.

**`packages/identity/src/membership-store.ts`** — `resolveActiveMembership(db, userId, storeId)` dùng `LIMIT 2` để phát hiện `ambiguous` thay vì chọn bừa (mẫu `docs/reference/nexus/03-better-auth-google-oauth.md:475-517`).

**`packages/identity/src/google-identity.ts`** — `ownerBindingStatements(database, profile, role, eligibilitySql, eligibilityBinds)`: nhận `role` làm tham số (KHÁC SOURCE hard-code `'owner'`) để dùng chung cho cả bootstrap (luôn `'owner'`) và redeem invitation (`'owner'|'staff'` theo `owner_invitations.role`) — mẫu `docs/reference/nexus/03-better-auth-google-oauth.md:146-181`.

**`packages/identity/src/admission.ts`** — `admitGoogleOwner`, `claimBootstrap`, `redeemInvitation`, `reconcileAdmission`; `claimBootstrap` nhận `storeId`/`initialOwnerEmail` qua tham số, không hằng — mẫu logic `docs/reference/nexus/03-better-auth-google-oauth.md:671-709,809-859`.

**`packages/identity/src/invitations.ts`** — `randomInvitationToken`, `digestInvitationToken`, `invitationContextHmac`, `resolveInvitationOAuthContext` (constant-time so HMAC), `createInvitation(db, { targetEmail, role, issuerMembershipId, issuerUserId, storeId })` — mẫu `docs/reference/nexus/03-better-auth-google-oauth.md:712-733`.

**`apps/worker/src/auth.ts`** — `createAuth(env)` + `wrappedGoogleProvider` + `ownerInvitationOAuthPlugin` (hook `before /sign-in/social` bơm `context_hmac` vào OAuth state) — port nguyên văn cấu hình `docs/reference/nexus/03-better-auth-google-oauth.md:16-103,784-806`, chỉ đổi tên bảng/action sang domain món ăn.

**`apps/worker/src/console-request-context.ts`** — `resolveConsoleRequestContext(request, env)` (gọi `getSession`, `resolveActiveMembership`, gom `Set-Cookie`) + `consoleOriginAllowed(request, consoleOrigin)` — mẫu `docs/reference/nexus/03-better-auth-google-oauth.md:475-517,939-948`.

**`apps/worker/src/http-response.ts`** — `withConsoleAuthHeaders(response, authHeaders)` ghép `Set-Cookie` vào mọi response; `jsonError`, `jsonResponse` — mẫu `docs/reference/nexus/03-better-auth-google-oauth.md:973-979`.

**`apps/worker/src/console-route-match.ts`** — `isKnownConsoleRequest(request)` allowlist method+path — mẫu `docs/reference/nexus/03-better-auth-google-oauth.md:584-616`.

**`apps/worker/src/console-session-routes.ts`** — `GET /api/console/session` trả `{ user, store, role, allowedActions }` lọc qua `evaluatePermission` — mẫu `docs/reference/nexus/03-better-auth-google-oauth.md:584-616`.

**`apps/worker/src/console-invitation-routes.ts`** — `POST /api/console/invitations` (đổi tên từ `owner-invitations`, nhận `{ targetEmail, role }`), guard issuer `role==='owner' && membershipStatus==='active'`, trả `invitationUrl` với token trong fragment `#invite=` + `Referrer-Policy: no-referrer` — mẫu `docs/reference/nexus/03-better-auth-google-oauth.md:616-655,1064-1074`.

**`apps/worker/src/storefront-cors.ts`** — `withStorefrontCors`, allowlist header gồm header chứa `table_token`, không `Allow-Credentials`, set `Access-Control-Max-Age` — mẫu `docs/reference/nexus/03-better-auth-google-oauth.md:949-951,1021-1028`.

**`apps/worker/src/environment.ts`** — type `AuthEnv`: `DB: D1Database`, `CONSOLE_ORIGIN: string`, `STOREFRONT_ORIGIN: string` (vars, không secret), `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `INITIAL_OWNER_EMAIL` (4 Worker secret) — mẫu `docs/reference/nexus/03-better-auth-google-oauth.md:865-906`.

**`.dev.vars`** (local, không commit) — 4 dòng secret dạng `KEY=value`, mẫu placeholder tại `docs/reference/nexus/03-better-auth-google-oauth.md:880-906`.

**`wrangler.jsonc`** — `vars: { CONSOLE_ORIGIN, STOREFRONT_ORIGIN }` khác nhau giữa local (`http://127.0.0.1:<port>`) và `env.production` — mẫu `docs/reference/nexus/03-better-auth-google-oauth.md:880-906`.

## Test cần viết trước (TDD)

| Tên test | Assert gì | Dữ liệu vào | Trích dẫn pattern |
| --- | --- | --- | --- |
| `staff không sửa được menu` | `evaluatePermission(staffContext, 'menu:write', resource)` === `false`; route `PATCH /api/console/menu/:id` trả 403 khi gọi bằng session staff | context `{ kind:'console', role:'staff', membershipStatus:'active', storeId, userId }`, resource `{ storeId }` | `docs/reference/nexus/03-better-auth-google-oauth.md:530-583` |
| `staff không duyệt được refund` | `evaluatePermission(staffContext, 'refund:decide', resource)` === `false` (action chỉ có trong `OWNER_ACTIONS`) | tương tự trên, action `refund:decide` | `docs/reference/nexus/03-better-auth-google-oauth.md:533-556` |
| `bootstrap lần hai bị từ chối` | Gọi `claimBootstrap` hai lần với cùng `initialOwnerEmail`: lần 1 tạo user+membership+claim; lần 2 trả `{ kind: 'denied' }`, KHÔNG có row `store_bootstrap_claims` thứ hai (PK vi phạm) | 2 lời gọi tuần tự cùng `profile.email === INITIAL_OWNER_EMAIL` | `docs/reference/nexus/03-better-auth-google-oauth.md:671-709` |
| `bootstrap race hai callback song song` | Chạy 2 `claimBootstrap` đồng thời (`Promise.all`) cho cùng store: đúng 1 kết quả `admitted`, 1 kết quả `denied`; đúng 1 row trong `store_bootstrap_claims` | 2 profile Google khác `sub` nhưng cùng `email === INITIAL_OWNER_EMAIL` (giả lập double-click) | `docs/reference/nexus/03-better-auth-google-oauth.md:671-709` |
| `token mời hết hạn bị từ chối` | `resolveInvitationOAuthContext`/`redeemInvitation` trả lỗi với thông báo **giống hệt** trường hợp token dùng lại; không tạo user/membership mới | invitation có `expires_at` trong quá khứ | `docs/reference/nexus/03-better-auth-google-oauth.md:616,809-859` |
| `token mời dùng lại (đã consumed) bị từ chối với thông báo giống hệt token hết hạn` | So sánh message/`error code` của 2 test trên phải **bằng nhau** (không lộ lý do cụ thể) | invitation có `consumed_at` đã set từ lần redeem trước | `docs/reference/nexus/03-better-auth-google-oauth.md:616,650-655` |
| `user Google lạ bị từ chối (không membership, không invitation, không bootstrap match)` | `validateUserInfo` trả `{ error: 'access_denied', errorDescription: 'This Google account cannot access the Console.' }`; không có session được tạo | profile Google random, không khớp `INITIAL_OWNER_EMAIL`, không kèm `invitationContext` | `docs/reference/nexus/03-better-auth-google-oauth.md:616-655` |
| `mời trùng email đã có user bị từ chối khi tạo invitation` | `createInvitation` cho `targetEmail` đã tồn tại trong `"user"` → `id` bị `NULL` trong CASE WHEN → INSERT thất bại (NOT NULL violation), không có row invitation mới | `targetEmail` trùng với `user.email` đã seed sẵn | `docs/reference/nexus/03-better-auth-google-oauth.md:1066-1067` |
| `invitation staff redeem thành công tạo membership role='staff'` | Sau khi redeem, `store_memberships.role === 'staff'` (không phải `'owner'` mặc định của SOURCE); `owner_invitations.consumed_at` được set | `owner_invitations.role = 'staff'`, profile Google email khớp `target_email` | `docs/reference/nexus/03-better-auth-google-oauth.md:1064-1074,809-859` |
| `cross-store bị chặn trong evaluatePermission` | `evaluatePermission(context, action, resource)` với `context.storeId !== resource.storeId` luôn `false` bất kể role/action | context store A, resource store B | `docs/reference/nexus/03-better-auth-google-oauth.md:557-566` |
| `staff xử lý được order được assign cho mình, không xử lý được order của staff khác` | `evaluatePermission(staffA, 'order:accept', { storeId, assignedUserId: staffB.userId })` === `false`; đúng với `assignedUserId: staffA.userId` thì `true` | 2 staff context khác `userId`, cùng `storeId` | `docs/reference/nexus/03-better-auth-google-oauth.md:566-583` |
| `cookie giữ nguyên khi 403 (membership revoked), bị xoá khi 401 (session hết hạn)` | Response 403 có header `Set-Cookie` với giá trị session hiện tại (không đổi); response 401 có `Set-Cookie` với `Max-Age=0` | session hợp lệ nhưng `store_memberships.status='revoked'` cho case 403; session token hết hạn cho case 401 | `docs/reference/nexus/03-better-auth-google-oauth.md:985-987` |
| `CSRF: POST /api/console/* thiếu Origin hoặc Origin sai hoặc Sec-Fetch-Site cross-site bị từ chối` | 4 biến thể đều trả về false/403 từ `consoleOriginAllowed`: thiếu header Origin, `Origin: null`, origin khác `CONSOLE_ORIGIN`, `Sec-Fetch-Site: cross-site` | request POST giả lập từng biến thể header | `docs/reference/nexus/03-better-auth-google-oauth.md:934-948` |
| `resolveActiveMembership trả 'ambiguous' khi user có ≥2 membership active` | Kết quả `{ kind: 'ambiguous' }`, không tự chọn bừa 1 trong 2 | seed 2 row `store_memberships` active cho cùng `user_id` (chỉ khả thi nếu bỏ `store_memberships_one_active_user`; nếu giữ index này, test đổi thành "INSERT thứ 2 vi phạm unique index") | `docs/reference/nexus/03-better-auth-google-oauth.md:475-517` |
| `webhook signature test vector` (ngoài phạm vi report này — thuộc PayFS, chỉ nêu để không trùng lặp) | — | — | không thuộc scope report này |

## Cạm bẫy & lệch chuẩn so với repo mẫu

- **Không dùng cổng 1 (`getUserInfo`) làm lớp an ninh duy nhất.** Nó `catch { return result; }` — nuốt lỗi admission (`docs/reference/nexus/03-better-auth-google-oauth.md:981-983`). Nếu code TARGET chỉ giữ cổng 1 và bỏ `validateUserInfo`, mọi tài khoản Google có thể đăng nhập được và cổng 2 mới là chốt fail-closed thật.
- **Không hard-code `NEXUS_STORE_ID` kiểu SOURCE.** SOURCE rải hằng này ở 10+ chỗ trong `packages/identity` (`admission.ts`, `invitations.ts`, `google-identity.ts`) — TARGET phải truyền `storeId` qua tham số hàm ngay từ đầu, vì D4 nói thêm cột tenant sau tốn kém nhưng không nói gì về việc code phải nhận tham số ngay — đây là khuyến nghị bổ sung từ tài liệu tham chiếu (`docs/reference/nexus/03-better-auth-google-oauth.md:1076-1084`).
- **Không port `scripts/provision-s4-identities.ts`.** Tài liệu của chính SOURCE xác nhận nó không cần cho bootstrap lẫn mời Owner (`docs/decisions/260919-post-xia-decision-record.md:296`, `docs/reference/nexus/03-better-auth-google-oauth.md:1076-1084`).
- **Nới CHECK role cho staff phải sửa đúng 4 chỗ đồng bộ, không chỉ 1:** (1) `owner_invitations.role CHECK (role IN ('owner','staff'))`, (2) `ownerBindingStatements` nhận `role` làm tham số thay vì hard-code `'owner'`, (3) guarded UPDATE khi consume phải so với `owner_invitations.role` (không hard-code `role='owner'` như SOURCE), (4) route đổi từ `/api/console/owner-invitations` → `/api/console/invitations`, body nhận thêm `role`. Bỏ sót 1 trong 4 vẫn compile được nhưng mời staff sẽ tạo nhầm role hoặc bị guard chặn nhầm — `docs/reference/nexus/03-better-auth-google-oauth.md:1064-1074`.
- **Đừng thêm `Access-Control-Allow-Credentials` vào CORS storefront.** Storefront không được chạm cookie Console dưới bất kỳ hình thức nào (`docs/reference/nexus/03-better-auth-google-oauth.md:949-951,1021-1028`).
- **Đừng hard-code hostname ở bất kỳ đâu** (redirect_uri, CORS allowlist, giá trị mặc định trong code) — D21 yêu cầu đọc từ biến môi trường vì MVP dùng `workers.dev` nhưng sẽ cutover sang domain thật; dấu hiệu lỗi là `redirect_uri_mismatch` (`docs/decisions/260919-post-xia-decision-record.md:309-321`).
- **`GOOGLE_CLIENT_SECRET`, `BETTER_AUTH_SECRET`, `INITIAL_OWNER_EMAIL` không bao giờ vào `wrangler.jsonc` hay biến `VITE_*`** — chỉ `CONSOLE_ORIGIN`/`STOREFRONT_ORIGIN` là `vars` không secret (`docs/reference/nexus/03-better-auth-google-oauth.md:880-906`). Lệnh `wrangler secret put` chính xác **chưa được xác nhận trong SOURCE** — xem Câu hỏi còn mở.
- **Đừng dùng `evaluatePermission` cho route mời** — SOURCE cố tình check role trực tiếp (`role==='owner' && membershipStatus==='active'`) thay vì đi qua action-based permission, vì việc phát hành lời mời không phải là một "action" theo nghĩa resource-scoped thông thường (`docs/reference/nexus/03-better-auth-google-oauth.md:616-655`).
- **`store_memberships_one_active_user` (partial unique index) chỉ đúng cho single-store MVP.** Nếu sau này multi-tenant, phải bỏ index này và sửa `resolveActiveMembership` nhận thêm `storeId` (`docs/reference/nexus/03-better-auth-google-oauth.md:1076-1084`).
- **Đừng copy `CHECK (store_id = 'store_nexus')` nguyên văn** — đó là hằng số hard-code của SOURCE cho tên store cụ thể của họ; TARGET dùng giá trị `store_id` riêng theo D4 (hằng cho MVP một quán, nhưng nên đọc từ config/hằng số dùng chung, không lặp lại chuỗi ma thuật ở nhiều migration).

## Câu hỏi còn mở

- **Bảng `stores` (FK target của `store_memberships.store_id` và `store_bootstrap_claims.store_id`) thuộc phạm vi package/migration nào?** Ba tài liệu đã đọc (03-better-auth doc, Decision Record D15/D20/D21, PRD §2.3) không nói rõ ai tạo bảng `stores` này lẫn giá trị `store_id` hằng cụ thể cho MVP một quán — D4 chỉ nói "mọi bảng nghiệp vụ có `store_id`, giá trị hằng cho MVP một quán" nhưng không chỉ định migration nào tạo `stores`. Cần xác nhận với scout/kế hoạch phụ trách schema `catalog`/`orders` hoặc dựng riêng migration `0001-stores.sql` trước cả identity.
- **Số thứ tự migration cụ thể** cho 3 file (`better-auth-core`, `store-memberships`, `bootstrap-and-invitations`) chưa chốt — phụ thuộc thứ tự toàn cục giữa `packages/identity`, `packages/catalog`, `packages/orders` (ví dụ liệu `stores` có migration số 1 hay không). Report này chỉ đề xuất tên file tượng trưng `000X-*`.
- **Lệnh `wrangler secret put` chính xác cho 4 biến** (`BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `INITIAL_OWNER_EMAIL`) — chính tài liệu nguồn ghi nhận đây là phần "chưa xác minh trong SOURCE" (`docs/reference/nexus/03-better-auth-google-oauth.md:906-923`). Cần tự viết script/README triển khai, không có mẫu để port.
- **Đăng ký Google Cloud OAuth client (loại Web application, redirect URI local + production)** là thao tác thủ công ngoài code, cần checklist vận hành riêng, không nằm trong phạm vi test tự động.