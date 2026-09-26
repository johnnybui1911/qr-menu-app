---
title: "Phase 6: Auth Console, bootstrap & invitation"
phase: 6
status: completed
priority: P1
effort: 10h
milestone: M3
dependencies: [2]
---

# Phase 6: Auth Console, bootstrap & invitation

## Context

- [Decision Record](../../docs/decisions/260919-post-xia-decision-record.md) — D15, D20, D21, F3, F10
- [Scout 04 — identity, auth & RBAC](./reports/scout-04-identity-auth-and-rbac.md) — cấu hình better-auth, hai cổng chặn, DDL bootstrap/invitation, `evaluatePermission`
- [PRD §2.2, §2.3](../../docs/PRD.md)

## Goal

Console có danh tính thật: Owner đầu tiên tự bootstrap bằng `INITIAL_OWNER_EMAIL` đúng một lần, nhân viên vào bằng lời mời one-time, và mọi quyền được giải lại từ bảng membership ở **mỗi** request.

## Overview

Priority P1 · M3 · phụ thuộc phase 2 (bảng `stores`, `token-digest`). **Không** phụ thuộc phase 3–5 → chạy song song được với nhánh tiền (phương án C của brainstorm). Điểm gặp duy nhất: `apps/worker/src/index.ts` và số migration kế tiếp (C13).

## Key insights

- **Có hai cổng chặn Google user lạ, không phải một.** Cổng 1 (`getUserInfo` → `admitGoogleOwner`) trong repo mẫu `catch { return result; }` — **nuốt lỗi**, nên nó không fail-closed. Cổng 2 (`validateUserInfo`) mới là chốt thật: `sub` phải bind tới membership `active` và email khớp. Viết chỉ cổng 1 = mở cửa cho mọi tài khoản Google.
- Bootstrap có hai lớp chống race **độc lập**: điều kiện `NOT EXISTS (… store_bootstrap_claims …)` trong guarded insert, **và** `store_bootstrap_claims.store_id` là PRIMARY KEY làm callback thứ hai abort cả batch → `reconcileAdmission` đọc lại và từ chối. Không lớp nào thay được lớp kia.
- Nới lời mời cho `staff` phải sửa **đúng 4 chỗ đồng bộ**: CHECK `role` của `owner_invitations`, `ownerBindingStatements` nhận `role` qua tham số, guarded UPDATE lúc consume so với `owner_invitations.role`, và route/body nhận `role`. Bỏ sót một chỗ vẫn compile nhưng tạo nhầm role hoặc bị guard chặn nhầm.
- Invitation có **hai** dẫn xuất tách biệt từ cùng token: `token_digest` để tra cứu, `context_hmac` để cất vào OAuth state (client không tính được). DB có CHECK `context_hmac != token_digest` để không ai vô tình dùng một giá trị cho cả hai việc.
- Cookie refresh phải forward trên **mọi** response kể cả lỗi. 403 (membership bị revoke) giữ cookie; chỉ 401 (session hết hạn) mới xoá.
- Repo mẫu hard-code `NEXUS_STORE_ID` ở 10+ chỗ trong `packages/identity`. Ở đây `storeId` luôn là **tham số hàm** ngay từ đầu.

## Quyết định thi công chốt tại phase này

| # | Câu hỏi mở của scout-04 | Chốt |
|---|---|---|
| 1 | Ai tạo bảng `stores` | Phase 2, migration `0001-menu-core.sql`. Phase này chỉ FK về nó |
| 2 | Số migration cho 3 file auth | `0003-better-auth-core.sql` → `0004-store-memberships.sql` → `0005-bootstrap-and-invitations.sql` (phase 2 dùng 0001–0002, phase 4 không cần migration nào). Thứ tự này bắt buộc vì FK phụ thuộc |
| 3 | `wrangler secret put` chính xác | Một script `scripts/setup-secrets.sh` liệt kê đúng 5 lệnh (`BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `INITIAL_OWNER_EMAIL`, `INVITATION_HMAC_SECRET`) + kiểm `BETTER_AUTH_SECRET` ≥32 ký tự và `trim()` mọi giá trị đọc từ stdin (dấu `\n` lọt vào `INITIAL_OWNER_EMAIL` là lỗi rất dễ mắc). Script **không** chứa giá trị |
| 4 | Đăng ký Google OAuth client (thủ công) | Checklist trong `docs/runbook-oauth.md`: loại Web application, hai redirect URI (local `http://127.0.0.1:<port>/api/auth/callback/google` + `${CONSOLE_ORIGIN}/api/auth/callback/google`), lấy từ env chứ không gõ tay vào code (C10) |
| 5 | `store_memberships_one_active_user` | Giữ cho MVP, kèm comment SQL nói rõ phải bỏ khi multi-tenant. Test `ambiguous` đổi thành "INSERT thứ hai vi phạm unique index" |
| 6 | Secret ký `context_hmac` của lời mời (red-team) | Biến **riêng** `INVITATION_HMAC_SECRET`, **không** tái dùng `BETTER_AUTH_SECRET` (C11). Lý do: xoay `BETTER_AUTH_SECRET` là việc bắt buộc khi nghi lộ session secret; nếu nó cũng ký `context_hmac` thì mọi lời mời đang chờ chết im lặng với đúng payload `access_denied` cố tình không nêu lý do — không ai debug ra |
| 7 | Email mời enqueue thế nào (red-team) | Route `console-invitation-routes.ts` ghép statement của `identity` (INSERT invitation) và `enqueueEmailJobStatement` của `orders` (phase 2) vào **một** `db.batch()`. `packages/identity` **không** import `orders` (C1) — việc ghép là của `apps/worker`. Bỏ migration `0007`: `kind='invitation'` đã có trong CHECK của 0002 |
| 8 | Harness session cho test (red-team) | `tests/support/console-session.ts` do phase này sở hữu: insert `user`/`account`/`store_memberships` rồi mint cookie session **đúng định dạng better-auth** (`token` + HMAC bằng `BETTER_AUTH_SECRET`). Một test A4 khẳng định cookie mint được `GET /api/console/session` chấp nhận → nếu better-auth đổi định dạng, **một** test đỏ thay vì hai mươi. Phase 7, 8, 10 dùng lại helper này, không tự mint |
| 9 | Token lời mời trong `order_email_jobs.payload_json` (red-team) | Email mời **phải** chứa link `#invite=<token>` nên job buộc phải mang token thô. Chốt: `payload_json` giữ token, và `completeJob`/`retireJob` của phase 5 **null hoá `payload_json`** ngay khi job kết thúc → token thô chỉ sống trong DB đúng khoảng thời gian chờ gửi (≤5 phút ở đường thường), `owner_invitations` vẫn chỉ có digest (C7). Test T20b khẳng định `payload_json IS NULL` sau khi gửi. Lựa chọn còn lại — email không chứa token, Owner tự chuyển link — bị loại vì D20 chốt "email mời gửi qua Resend outbox" |

## Requirements

- [x] `migrations/0003-better-auth-core.sql`: `user`, `session`, `account`, `verification`, `rateLimit` + index, gồm 2 unique index Google binding (`account(providerId, accountId)`, `account(userId, providerId)`)
- [x] `migrations/0004-store-memberships.sql`: `store_memberships` với `role IN ('owner','staff')`, `status IN ('active','revoked')`, CHECK `status ↔ revoked_at`, partial unique một membership active/user
- [x] `migrations/0005-bootstrap-and-invitations.sql`: `store_bootstrap_claims` (`store_id` PK), `owner_invitations` (role nới `staff`, CHECK 3 trạng thái, 2 unique index, partial index lookup)
- [x] `betterAuth({ database: env.DB })` — không adapter, không ORM (F3, D2)
- [x] `disableSignUp: true`, `disableIdTokenSignIn: true`, `accountLinking.enabled: false`, `rateLimit.storage: 'database'`, `trustedOrigins: [CONSOLE_ORIGIN]`, `encryptOAuthTokens: true`
- [x] Thiếu `GOOGLE_CLIENT_ID`/`SECRET`/`BETTER_AUTH_SECRET`/`INVITATION_HMAC_SECRET` → `503 auth_not_configured` (fail closed), không chạy với provider rỗng
- [x] Cổng 1 (`getUserInfo` → `admitGoogleOwner`): bootstrap **chỉ** khi `profile.emailVerified === true` **và** `profile.email.trim().toLowerCase() === INITIAL_OWNER_EMAIL.trim().toLowerCase()`. Kiểm `emailVerified` ở cổng 1, không để tới cổng 2 — cổng 2 chặn được phiên nhưng row `store_bootstrap_claims`/membership đã ghi thì Owner thật vĩnh viễn không bootstrap được (D20)
- [x] Cổng 2 (`validateUserInfo`): `providerId==='google'`, `emailVerified===true`, `sub` bind tới membership `active`, email khớp sau `trim().toLowerCase()`
- [x] Mọi lý do từ chối trả **cùng một** payload `access_denied`
- [x] `evaluatePermission` thuần với 3 tập action (Owner / Staff / Customer); `report:read`, `refund:decide`, `menu:*`, `table:*` chỉ Owner
- [x] `resolveActiveMembership` dùng `LIMIT 2` để phát hiện `ambiguous`, không chọn bừa
- [x] `isKnownConsoleRequest` allowlist chạy **trước** khi đọc session; route lạ → 404
- [x] `consoleOriginAllowed`: **mọi method ngoài `GET`/`HEAD`/`OPTIONS`** (POST, PATCH, PUT, DELETE — phase 8 dùng cả bốn) yêu cầu `Origin === CONSOLE_ORIGIN` và `Sec-Fetch-Site` null/`same-origin`
- [x] Cookie forward trên mọi response; 403 giữ cookie, 401 xoá
- [x] `/api/auth/*`: xoá `Content-Length`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`
- [x] Ba route invitation — `POST /api/console/invitations`, `GET /api/console/invitations`, `POST /api/console/invitations/:id/revoke` — đi qua **cùng một** hàm `requireActiveOwner(context)` (không qua `evaluatePermission`: phát hành lời mời không phải action resource-scoped), trả cùng payload `issuer_not_owner` khi từ chối. Thiếu guard ở route `GET` là để staff đọc danh sách `target_email`; thiếu ở `revoke` là để staff chặn onboarding
- [x] `targetEmail` được `trim().toLowerCase()` **tại route** trước khi vào SQL (CHECK `target_email = lower(target_email)`); sai định dạng email → `400 invalid_email` (lỗi định dạng không lộ sự tồn tại của lời mời nào, khác với lỗi **từ chối** phải giống hệt nhau)
- [x] `POST /api/console/memberships/:id/revoke` (Owner, `requireActiveOwner`, **không** tự revoke chính mình) → `status='revoked'`, `revoked_at=now`. D20 hứa thu hồi nhân viên không phải sửa DB tay
- [x] Email mời enqueue bằng `enqueueEmailJobStatement` (phase 2) trong **cùng** batch với INSERT invitation, `kind='invitation'`, `dedupe_key='invite:<invitation_id>'`. **Không** có migration 0007

## Architecture

```
OAuth callback /api/auth/callback/google
  ├─ Cổng 1  getUserInfo → admitGoogleOwner(db, {profile, initialOwnerEmail, invitationContext})
  │     ├─ email === INITIAL_OWNER_EMAIL và chưa có claim → claimBootstrap
  │     │     guarded batch: INSERT user/account/store_memberships(role='owner')
  │     │       eligibilitySql = EXISTS(stores) AND NOT EXISTS(store_bootstrap_claims)
  │     │     + INSERT store_bootstrap_claims (store_id PK ← lớp chống race 2)
  │     │     batch abort → reconcileAdmission đọc lại → denied
  │     ├─ có invitationContext hợp lệ → redeemInvitation (role lấy từ invitation)
  │     │     guarded batch: INSERT user/account/membership(role)
  │     │     + UPDATE owner_invitations SET consumed_at = CASE WHEN <pending & chưa hết hạn
  │     │       & email khớp & membership vừa tạo đúng role> THEN ? ELSE NULL END
  │     │       → sai điều kiện ⇒ CHECK owner_invitations_state vỡ ⇒ abort batch
  │     └─ lỗi ở cổng này KHÔNG chặn được (repo mẫu nuốt lỗi) → phải có cổng 2
  └─ Cổng 2  validateUserInfo  ← chốt fail-closed thật
        providerId==='google' && emailVerified===true && sub tồn tại
        && SELECT … account JOIN user JOIN store_memberships WHERE accountId=? AND status='active'
        && binding.email === user.email (lowercase, trim)
        sai bất kỳ điều kiện → { error:'access_denied', errorDescription:'…' } (một thông báo duy nhất)

Mọi request /api/console/*
  isKnownConsoleRequest → 404 nếu lạ
  consoleOriginAllowed  → 403 nếu POST sai origin/Sec-Fetch-Site
  getSession(returnHeaders) → resolveActiveMembership(db, userId, storeId)
    unauthenticated → 401 (cookie bị xoá)   |   không resolved → 403 (cookie giữ)
  evaluatePermission(context, action, resource) → 403 nếu false
  withConsoleAuthHeaders(response, authHeaders)  ← trên MỌI nhánh, kể cả lỗi
```

## Files to create / modify

- Create: `migrations/0003-better-auth-core.sql`, `0004-store-memberships.sql`, `0005-bootstrap-and-invitations.sql` (toàn bộ schema dự án gói trong 5 migration)
- Create: `packages/identity/src/identity-types.ts`, `permissions.ts`, `membership-store.ts`, `google-identity.ts`, `admission.ts`, `invitations.ts`
- Create: `apps/worker/src/auth.ts`, `console-request-context.ts`, `http-response.ts`, `console-route-match.ts`, `console-session-routes.ts`, `console-invitation-routes.ts`, `console-membership-routes.ts`, `environment.ts`
- Create: `scripts/setup-secrets.sh`, `docs/runbook-oauth.md`, `.dev.vars.example`
- Modify: `apps/worker/src/index.ts` — mount `/api/auth/*` và `/api/console/*`
- Create: `tests/support/console-session.ts` — mint session cookie cho test (quyết định #8); phase 7, 8, 10 dùng lại

## Tests Before (viết trước, phải đỏ)

| # | Test | Assert | Dữ liệu vào |
|---|---|---|---|
| T1 | `tests/unit/permissions.test.ts :: staff không sửa menu` | `evaluatePermission(staff, 'menu:write', {storeId})` = false | context staff active |
| T2 | `tests/unit/permissions.test.ts :: staff không duyệt refund` | `'refund:decide'` = false với staff, true với owner | 2 context |
| T3 | `tests/unit/permissions.test.ts :: staff không đọc báo cáo` | `'report:read'` = false với staff | 1 context |
| T4 | `tests/unit/permissions.test.ts :: cross-store luôn false` | `context.storeId !== resource.storeId` → false bất kể role/action | owner store A, resource store B |
| T5 | `tests/unit/permissions.test.ts :: action lạ → false` | `'menu:nuke'` → false (không throw) | 1 case |
| T6 | `tests/unit/permissions.test.ts :: staff xử lý được mọi đơn của quán` | `order:prepare`, `order:fulfill`, `refund:request` = true với staff active trên đơn bất kỳ của cùng store (MVP không có gán đơn — PRD §2.2); `order:assign` và `order:accept` **không tồn tại** trong tập action (nút "Nhận đơn & Chế biến" của PRD §2.2 chính là `order:prepare`, một tên cho một chuyển trạng thái) | 5 case |
| T7 | `tests/integration/bootstrap.test.ts :: bootstrap lần hai bị từ chối` | Lần 1 `admitted`; lần 2 (cùng email) `denied`, `store_bootstrap_claims` vẫn 1 row | 2 lời gọi |
| T8 | `tests/integration/bootstrap.test.ts :: race hai callback song song` | `Promise.all` 2 `claimBootstrap` → đúng 1 `admitted`, 1 `denied`, đúng 1 row claim, đúng 1 membership owner | 2 profile khác `sub`, cùng email |
| T9 | `tests/integration/bootstrap.test.ts :: email không khớp INITIAL_OWNER_EMAIL` | `denied`, không tạo user/membership | 1 profile |
| T9b | `tests/integration/bootstrap.test.ts :: email chưa verify không bootstrap được` | `emailVerified=false` nhưng email khớp `INITIAL_OWNER_EMAIL` → `denied`, `store_bootstrap_claims` **rỗng**, không membership nào → Owner thật vẫn bootstrap được sau đó | 2 lời gọi |
| T9c | `tests/integration/bootstrap.test.ts :: email khớp sau khi chuẩn hoá` | `INITIAL_OWNER_EMAIL` có khoảng trắng/`\n` và chữ hoa; profile email chữ thường → vẫn bootstrap được (so sánh sau `trim().toLowerCase()`) | 1 lời gọi |
| T10 | `tests/integration/auth-gates.test.ts :: user Google lạ bị từ chối ở cổng 2` | `validateUserInfo` trả `access_denied`; không có row `session` | profile random |
| T11 | `tests/integration/auth-gates.test.ts :: cổng 2 chặn dù cổng 1 nuốt lỗi` | Ép `admitGoogleOwner` throw → callback vẫn bị từ chối vì không có membership active | stub throw |
| T12 | `tests/integration/auth-gates.test.ts :: membership revoked bị từ chối` | Membership `status='revoked'` → `access_denied`, cùng payload với T10 (`toEqual`) | 1 membership revoked |
| T13 | `tests/integration/auth-gates.test.ts :: email không khớp binding` | `sub` bind tới user email khác → từ chối, cùng payload | 1 case |
| T14 | `tests/integration/invitations.test.ts :: token hết hạn và token dùng lại cho cùng thông báo` | Hai case → `toEqual` cùng error payload; không tạo membership | `expires_at` quá khứ / `consumed_at` đã set |
| T15 | `tests/integration/invitations.test.ts :: redeem one-time` | Redeem lần 1 tạo membership + set `consumed_at`; lần 2 cùng token → từ chối, không membership thứ hai | 2 lần |
| T16 | `tests/integration/invitations.test.ts :: mời staff tạo đúng role staff` | `owner_invitations.role='staff'` → membership `role='staff'` (không phải `owner`) | 1 invitation |
| T17 | `tests/integration/invitations.test.ts :: không mời email đã có user` | `createInvitation` cho email đã tồn tại trong `"user"` → INSERT thất bại (NOT NULL từ CASE WHEN), không row mới | 1 case |
| T18 | `tests/integration/invitations.test.ts :: cả ba route invitation chỉ Owner active` | Với **mỗi** route (`POST`, `GET`, `POST …/revoke`): issuer staff → 403 `issuer_not_owner`; owner revoked → 403 cùng payload; owner active → thành công | 9 request |
| T18b | `tests/integration/invitations.test.ts :: email hoa/khoảng trắng vẫn mời được` | `targetEmail = ' Chi@Gmail.com '` → tạo được lời mời với `target_email='chi@gmail.com'`; `'không-phải-email'` → `400 invalid_email` (khác payload `issuer_not_owner`) | 2 request |
| T19 | `tests/integration/invitations.test.ts :: context_hmac khác token_digest` | INSERT với `context_hmac = token_digest` → abort CHECK | 1 case |
| T20 | `tests/integration/invitations.test.ts :: link mời không lộ token qua referrer` | Response tạo lời mời có `Referrer-Policy: no-referrer`; token nằm sau `#`, không trong path/query | 1 response |
| T20b | `tests/integration/invitations.test.ts :: token lời mời không sống lại trong outbox` | Sau khi job `invitation` gửi thành công (hoặc bị retire), `order_email_jobs.payload_json IS NULL`; `owner_invitations` không bao giờ chứa token thô | 2 case |
| T21 | `tests/integration/console-session.test.ts :: 403 giữ cookie, 401 xoá cookie` | Membership revoked → 403 kèm `Set-Cookie` session không đổi; session hết hạn → 401 kèm `Max-Age=0` | 2 request |
| T22 | `tests/integration/console-session.test.ts :: cookie forward trên response lỗi` | Response 403 và 503 đều mang `Set-Cookie` từ `getSession` | 2 request |
| T23 | `tests/integration/console-session.test.ts :: CSRF 4 biến thể bị từ chối` | POST thiếu `Origin` / `Origin: null` / origin khác / `Sec-Fetch-Site: cross-site` → 403 | 4 request |
| T24 | `tests/integration/console-session.test.ts :: route lạ 404 trước khi đọc session` | `GET /api/console/nope` → 404 **và** stub `getSession` không được gọi | 1 request |
| T25 | `tests/integration/console-session.test.ts :: /api/auth/* có header an toàn` | `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, không `Content-Length` | 1 request |
| T26 | `tests/integration/console-session.test.ts :: thiếu config Google → 503` | Env không có `GOOGLE_CLIENT_ID` → 503 `auth_not_configured`, không 500, không cho đăng nhập | 1 request |
| T27 | `tests/integration/membership.test.ts :: hai membership active bị chặn` | INSERT membership active thứ hai cho cùng user → vi phạm partial unique index | 1 case |
| T27b | `tests/integration/membership.test.ts :: Owner thu hồi nhân viên` | Owner gọi `POST /api/console/memberships/:id/revoke` → `status='revoked'`, `revoked_at` có giá trị, staff đó lập tức bị 403 ở request sau; Owner tự revoke chính mình → 400 `cannot_revoke_self`; staff gọi → 403 | 4 request |
| T28 | `tests/node/identity-purity.test.ts :: identity không import gì` | `packages/identity/package.json` không có `dependencies`; grep `packages/identity/src` không import `@qr/` | cây source |

## Refactor / triển khai dưới lưới test

1. Ba migration 0003–0005 theo DDL scout-04, **bỏ** `CHECK (store_id = 'store_nexus')`, FK `store_id` về `stores(id)` của phase 2. **Không** có 0007: `kind='invitation'` đã nằm trong CHECK của 0002 (phase 2).
2. `identity-types.ts`: `StoreRole`, `MembershipStatus`, `IdentityContext` union (`console`|`customer`|`public`), `PermissionAction`, `OWNER_INVITATION_TTL_MS = 7*24*3600*1000`.
3. `permissions.ts`: `evaluatePermission` thuần theo 3 tập action; thứ tự kiểm: action lạ → `public` → cross-store → customer → membership status → role. **Lệch có chủ đích so với scout-04**: bỏ `STAFF_ASSIGNED_ACTIONS` và action `order:assign` — repo mẫu đòi đơn phải được gán cho staff mới xử lý được, còn PRD §2.2 cho nhân viên nhận **bất kỳ** đơn nào của quán. Giữ cơ chế gán là thêm một khái niệm không ai dùng và làm màn bếp bế tắc. `STAFF_ACTIONS = {menu:read, table:read, order:read, order:prepare, order:fulfill, refund:request}` — bỏ `order:accept` của scout-04: không route/transition nào dùng nó, `paid → preparing` đã là `order:prepare`.
4. `membership-store.ts`: `resolveActiveMembership(db, userId, storeId)` `LIMIT 2` → `absent | ambiguous | resolved`.
5. `google-identity.ts`: `ownerBindingStatements(db, profile, role, eligibilitySql, binds)` — `role` là **tham số** (khác repo mẫu hard-code `'owner'`).
6. `admission.ts`: `admitGoogleOwner`, `claimBootstrap`, `redeemInvitation`, `reconcileAdmission`; mọi hàm nhận `storeId` qua tham số.
7. `invitations.ts`: `randomInvitationToken` (32 byte, base64url, dùng `generateOpaqueToken` của phase 2), `digestInvitationToken` = `sha256Hex`, `invitationContextHmac` = HMAC lồng với **`INVITATION_HMAC_SECRET`** (biến riêng — quyết định #6), `resolveInvitationOAuthContext` so bằng `constantTimeEqual`, `createInvitation` với guarded INSERT (chỉ trả statement; route ghép batch).
8. `auth.ts`: `createAuth(env)` theo Requirements + `wrappedGoogleProvider` (cổng 1) + `ownerInvitationOAuthPlugin` (bơm `context_hmac` vào OAuth state ở hook `before /sign-in/social`) + `validateUserInfo` (cổng 2).
9. `console-request-context.ts`, `http-response.ts`, `console-route-match.ts`: gom `Set-Cookie`, ghép vào mọi response, allowlist route trước session, `consoleOriginAllowed`.
10. `console-session-routes.ts`: `GET /api/console/session` trả `{user, store, role, allowedActions}` — `allowedActions` lọc qua `evaluatePermission` để UI không phải tự đoán quyền.
11. `console-invitation-routes.ts`: ba route đi qua `requireActiveOwner`; `targetEmail` chuẩn hoá tại route; ghép statement `createInvitation` (identity) + `enqueueEmailJobStatement` (orders, phase 2) vào **một** `db.batch()`. `console-membership-routes.ts`: `POST /api/console/memberships/:id/revoke` (Owner, chặn tự revoke).
12. `tests/support/console-session.ts`: `seedConsoleUser(db, {role, status})` + `mintSessionCookie(userId, env)` — một chỗ duy nhất biết định dạng cookie better-auth.
13. `scripts/setup-secrets.sh` + `docs/runbook-oauth.md` + `.dev.vars.example` (chỉ tên biến, không giá trị; `.gitignore` đã có ngoại lệ `!.dev.vars.example` từ phase 1).

## Tests After

| # | Test | Assert |
|---|---|---|
| A1 | `tests/integration/console-session.test.ts :: session trả allowedActions đúng role` | Owner có `refund:decide` và `report:read`; staff không có cả hai |
| A2 | `tests/integration/invitations.test.ts :: email mời vào outbox cùng batch` | INSERT invitation fail → không có job email mồ côi; thành công → đúng 1 job `kind='invitation'` |
| A3 | `tests/node/secret-hygiene.test.ts :: không secret nào trong repo` | Grep `wrangler.jsonc`, `.dev.vars.example`, source: không có giá trị secret, chỉ tên biến (D16) |
| A4 | `tests/integration/console-session.test.ts :: cookie mint được server chấp nhận` | Cookie từ `mintSessionCookie` làm `GET /api/console/session` trả 200 với đúng `role`. Nếu better-auth đổi định dạng cookie, **chỉ** test này đỏ — không phải 20 test của phase 7/8 |

## Todo

- [x] T1–T28 (gồm T9b, T9c, T18b, T27b) viết trước và đỏ
- [x] Migration 0003 → 0004 → 0005
- [x] `identity-types.ts` + `permissions.ts` + `membership-store.ts`
- [x] `google-identity.ts` + `admission.ts` + `invitations.ts`
- [x] `auth.ts` (hai cổng) + `environment.ts`
- [x] `console-request-context.ts` + `http-response.ts` + `console-route-match.ts`
- [x] `console-session-routes.ts` + `console-invitation-routes.ts` + `console-membership-routes.ts` + mount
- [x] `tests/support/console-session.ts` + `scripts/setup-secrets.sh` + `docs/runbook-oauth.md`
- [x] A1–A4 xanh

## Regression gate

```bash
npm run typecheck && npm test
```

Cộng bằng chứng tay một lần: đăng nhập Google thật vào Console local bằng `INITIAL_OWNER_EMAIL` → thấy `role: owner`; đăng nhập bằng tài khoản Google khác → bị từ chối với đúng một thông báo.

**Đã làm trên production 2026-09-26:** chủ quán đăng nhập bằng `INITIAL_OWNER_EMAIL` và vào được với quyền Owner; đăng xuất rồi thử một tài khoản Google khác thì bị từ chối (chủ quán xác nhận). D1 production khớp với kết quả đó: 1 `user`, 1 `store_memberships` owner active, 1 `store_bootstrap_claims`. Tài khoản bị từ chối không để lại row user nào. <!-- Updated: Cook 2026-09-26 -->

## Success criteria

- [x] T1–T28, A1–A3 xanh
- [x] Bootstrap chỉ xảy ra một lần, kể cả khi hai callback OAuth chạy song song
- [x] Không tài khoản Google nào ngoài membership active vào được Console
- [x] Mọi lý do từ chối cho **cùng một** payload (T10, T12, T13, T14 so bằng `toEqual`)
- [x] Mời được `staff`, đúng role, one-time, TTL 7 ngày
- [x] Không secret nào trong repo; không hostname literal

## Risks

| Rủi ro | Mitigation |
|---|---|
| Chỉ viết cổng 1 rồi tưởng đã an toàn | T11 ép cổng 1 throw và vẫn đòi bị từ chối — test này tồn tại chính vì lỗi này rất dễ mắc |
| Nới `role` cho staff thiếu một trong 4 chỗ | T16 kiểm role thật sau redeem, không kiểm code; thiếu chỗ nào cũng làm T16 đỏ |
| Thông báo lỗi khác nhau làm lộ sự tồn tại của lời mời | T14 + T12 + T13 so payload bằng `toEqual`, không chỉ so status |
| `redirect_uri_mismatch` khi cutover origin | Runbook OAuth liệt kê đủ hai redirect URI; C10 bắt mọi origin đọc từ env; phase 10 có checklist cutover |
| Session cache làm quyền cũ còn hiệu lực sau khi revoke | `resolveActiveMembership` chạy **mỗi** request (D15); T12 chứng minh revoke có hiệu lực ngay |

## Security

- Google chỉ xác thực **con người**; nguồn sự thật phân quyền là bảng membership, giải lại mỗi request (D15).
- `disableSignUp: true` + `accountLinking.enabled: false` + hai cổng: không có đường tự đăng ký.
- Token invitation: chỉ digest trong DB, đi trong fragment, `Referrer-Policy: no-referrer`, one-time, TTL 7 ngày.
- 4 secret qua `wrangler secret put`; `BETTER_AUTH_SECRET` ≥32 ký tự được kiểm trước khi nạp.
- CSRF: `trustedOrigins` của better-auth **cộng** kiểm `Origin`/`Sec-Fetch-Site` thủ công cho mọi POST.

## Ghi chú thi công (2026-09-26)

Phase 6 xanh: `npm run typecheck && npm test` — node 40/40 (36 cũ + T28 x2 + A3 x4), workerd 264/264 (bao gồm 28 test unit/integration mới: T1–T27b + A1, A2, A4 + 1 test bổ sung "gate 2 rejects emailVerified=false"). `npm run typecheck` sạch với code phase 6; lỗi `Uint8Array<ArrayBufferLike>` còn lại trong `tests/integration/product-image.test.ts` là của phase 8 (không đụng tới).

**better-auth `1.7.4`** (khớp đúng phiên bản scout-04 đã xác minh), thêm vào `apps/worker/package.json` (không phải root `package.json`).

**Lệch so với scout-04 vì API better-auth 1.7.4 đã đổi** (báo cáo dựa trên bản cũ hơn):
1. `socialProviders.google` trong 1.7.4 chỉ nhận **config** (`GoogleOptions`), không nhận provider đã dựng sẵn như doc mô tả. `wrappedGoogleProvider` đổi thành `wrappedGoogleConfig`: build một `nativeGoogle` provider chỉ để giữ tham chiếu tới `getUserInfo` thật, rồi trả về config object có field `getUserInfo` override gọi qua `nativeGoogle.getUserInfo` trước khi chạy `admitGoogleOwnerSafely`. Hành vi cuối giống hệt doc, chỉ khác chỗ lắp ráp.
2. `user.validateUserInfo` nhận `source: ValidateUserInfoSource` bắt buộc có `action` (`'create-user'|'link-account'|'sign-in'`) — khác chữ ký doc mô tả.

**Chỗ tự quyết định (không có trong doc/scout-04) do nảy sinh khi viết test T18**: ba route invitation và route revoke membership **không** dùng `resolveConsoleRequestContext`/`withConsoleContext` chung (cái đó vẫn dùng cho `/api/console/session`). Lý do: `resolveActiveMembership` chỉ trả `resolved` khi có membership **active** — nếu dùng chung, một Owner bị revoke sẽ nhận `403 store_access_denied` ở tầng framework, **trước khi** route kịp chạy `requireActiveOwner`, nên không thể nào cho ra cùng payload `issuer_not_owner` như một Staff (T18 đòi "owner revoked → 403 cùng payload" với staff). Sửa: tách `resolveConsoleSession`/`withConsoleSession` (chỉ xác thực session, không đụng membership) cho 4 route này; mỗi route tự gọi `resolveActiveMembership` và map "absent | ambiguous | staff" thành cùng một `403 issuer_not_owner`. `/api/console/session` giữ nguyên `withConsoleContext` vì nó **cần** phân biệt "không session" (401) với "membership không active" (403 `store_access_denied`) — đúng theo T21.

**API helper `tests/support/console-session.ts`** (quyết định #8): dùng thẳng plugin chính chủ `testUtils` của better-auth (`better-auth/plugins`) thay vì tự tính `token.signature` — `ctx.test.login({ userId })` vừa ghi session row thật vào D1 vừa trả `Cookie` header đã ký đúng định dạng, nên A4 khoá đúng "một chỗ duy nhất biết định dạng cookie". Export:
  - `seedConsoleUser({ role?, status?, email?, name?, googleSubject? }) → { userId, membershipId, email }` — chèn thẳng `user`/`account`/`store_memberships`.
  - `createConsoleSession(input) → { cookie, userId, membershipId }` — seed + mint cookie.
  - `consoleRequest(path, init & { cookie? })` — tự set `Origin: CONSOLE_ORIGIN`, gọi `exports.default.fetch`.

**T20b** viết được thành test thật (không phải `it.todo`) vì phase 5 đã có `completeJob`/`retireExhaustedJobs`/`runEmailOutbox` khi tới lượt tôi viết — dùng `runEmailOutbox(env, now)` trực tiếp (không qua `worker.scheduled!`) kèm `vi.spyOn(globalThis, 'fetch')`, tránh phụ thuộc thời điểm phase 5 nối `scheduled()` xong.

**Mutation-check đã chạy tay**: xoá điều kiện `user.emailVerified !== true` khỏi `validateGoogleUserInfo` (gate 2) → đúng 1 test đỏ (`gate 2 rejects emailVerified=false...`), khôi phục lại → 5/5 xanh. Race guard bootstrap (T8) là test đồng thời thật (`Promise.all` hai `claimBootstrap`), không mock — xanh ổn định.

**Smoke tay** (`wrangler d1 migrations apply --local --persist-to /tmp/qr-phase6-state` rồi `wrangler dev --port 8788 --persist-to /tmp/qr-phase6-state`): `GET /api/console/session` không cookie → `401 unauthenticated`; cùng route khi chưa nạp `.dev.vars` → `503 auth_not_configured`; `GET /api/console/nope` → `404 not_found`; `POST /api/console/invitations` với `Origin: https://evil.example` → `403 origin_denied`; `POST /api/auth/sign-in/social` cùng-origin với secret giả → `200` kèm URL `accounts.google.com` thật (PKCE + state hợp lệ) — xác nhận `createAuth`/`betterAuth` lắp đúng dây, không giả lập.

**Việc cần user, chưa làm được**: đăng ký Google OAuth client thật (checklist đã có trong `docs/runbook-oauth.md`) và một lần đăng nhập Google thật để đóng dòng "Cộng bằng chứng tay" của Regression gate — cả hai đều cần tài khoản Google Cloud thật, ngoài khả năng của tôi trong phiên này.

## Next

Phase 7 (lệnh Console) và phase 8 (menu/bàn/ảnh) đều dùng `resolveConsoleRequestContext` + `evaluatePermission` của phase này. Phase 9 dựng UI đăng nhập và luồng nhận lời mời.
