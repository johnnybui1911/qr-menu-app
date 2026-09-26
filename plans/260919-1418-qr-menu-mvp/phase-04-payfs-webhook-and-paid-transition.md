---
title: "Phase 4: Webhook PayFS & chuyển paid"
phase: 4
status: todo
priority: P1
effort: 8h
milestone: M1-M2
dependencies: [3]
---

# Phase 4: Webhook PayFS & chuyển `paid`

## Context

- [Decision Record](../../docs/decisions/260919-post-xia-decision-record.md) — D5, D9, D10 (tầng provider), D18, D22, D23, F4, F11, F13
- [Scout 03 — PayFS & hợp đồng tiền](./reports/scout-03-payfs-and-money-contracts.md) — 6 bước verify, test vector byte-exact, pattern assertion cuối batch
- [Brainstorm — cái đã thay đổi](../reports/260919-brainstorm-build-approach.md) — vì sao ký raw body là sai

## Goal

Tiền vào tài khoản → webhook đã ký được xác thực đủ 6 bước → đơn đúng `payment_reference` và **đúng số tiền** chuyển sang `paid` trong một batch nguyên tử có enqueue email; mọi trường hợp còn lại được ghi nhận chứ không bị nuốt.

## Overview

Priority P1 · M1–M2 · phụ thuộc phase 3. Đây là nửa sau của lát cắt dọc: hết phase này, script tự ký payload bắn vào worker local làm đơn chuyển `paid` — chứng minh cả đường ống chạy mà **không cần** tài khoản PayFS (D22).

## Key insights

- **Không có code nào của repo mẫu để bê cho phần verify.** Repo mẫu chỉ so API key tĩnh bằng `!==` (F6). Toàn bộ bước timestamp + signature phải viết mới bằng WebCrypto.
- Chuỗi được ký là `timestamp + "." + JSON.stringify(sortKeysRecursive(payload))` — **không** phải raw body (F11). Bản chốt cũ ghi "raw body" sẽ từ chối 100% webhook hợp lệ. Đây là lỗi đắt nhất mà phase này tồn tại để chặn.
- `sortKeysRecursive` phải là **một** module dùng chung giữa worker và script dev-sign. Hai bản cài đặt riêng → test tự ký pass giả (self-consistent nhưng lệch PayFS thật).
- Payload webhook **không có trường nào trỏ về đơn** (F13). Khớp đơn chỉ bằng chuỗi con `payment_reference` trên `upper(content)` **và** `amount` khớp tuyệt đối (D18). Nội dung ngân hàng có rác bao quanh.
- Chữ ký lệch → **ghi raw body vào `provider_events` rồi trả 401**. Không nuốt im lặng: lệch chữ ký ở hệ thống này khả năng cao là lỗi canonicalization của ta, không phải tấn công.
- Endpoint phải trả lời trong 30 giây, nếu không PayFS tính là thất bại và retry (tới ~2.8 giờ, F13).

## Quyết định thi công chốt tại phase này

| # | Vấn đề | Chốt |
|---|---|---|
| 1 | So chữ ký thế nào | `crypto.subtle.verify('HMAC', key, signatureBytes, dataBytes)` — constant-time nội tại, không tự so hex. API key vẫn so bằng `constantTimeEqual` của phase 2 |
| 2 | `content` chứa nhiều mã `QM…` | Thu tập hợp mã tìm được; `size > 1` → coi là **không khớp** (ambiguous), ghi `provider_events` + cờ Owner. Không tự chọn mã đầu tiên |
| 3 | `amount` lệch | Không `paid` dù mã khớp. Ghi `provider_events` với `outcome='amount_mismatch'` + cờ `needs_attention` trên đơn. Trả thiếu tiền không phải là đã trả (D18) |
| 4 | Ghi nhận thanh toán | `provider_payments` với `UNIQUE(store_id, order_id)` (phase 2) là chốt cuối chặn ghi nhận tiền hai lần, kể cả khi hai webhook khác `transaction_id` cùng trỏ một đơn |
| 5 | Thiếu secret webhook (red-team) | `PAYFS_WEBHOOK_API_KEY` hoặc `PAYFS_WEBHOOK_SECRET` rỗng/thiếu → **`503 payfs_not_configured` ngay từ bước 2**, tuyệt đối không coi như pass. Lý do: M0–M3 chạy không có tài khoản PayFS (D22) nên rất dễ code kiểu "có cấu hình mới verify"; sót một `wrangler secret put` lúc cutover là bất kỳ ai POST `credit` với mã `QM…` in trên màn hình khách cũng làm đơn `paid` |
| 6 | Row của webhook chưa xác thực (red-team) | Ghi với `verified = 0` và `provider_event_id = 'unverified:' + sha256Hex(rawBody)` — **không** dùng `transaction_id` chưa xác thực. Partial unique index của phase 2 chỉ áp `verified = 1` nên row này không chiếm khoá idempotency; nếu chiếm, webhook hợp lệ retry sau khi ta sửa bug canonicalization sẽ bị coi là trùng facts → 400 → khách trả tiền mà đơn bị huỷ ở phút 30 |
| 7 | `provider_events` ghi ở đâu trong luồng (red-team) | **Trong cùng `db.batch()`** với transition (nhánh khớp) hoặc trong một batch riêng kèm `outcome` (nhánh không khớp). `already_processed` chỉ khi row cũ **đã có `outcome` kết thúc**; row `outcome IS NULL` (worker chết giữa đường) phải được xử lý lại. Nếu ghi ledger trước rồi settle sau, một lần chết giữa hai bước làm đơn kẹt vĩnh viễn và cả webhook retry lẫn cron đều bỏ qua |
| 8 | Facts fingerprint (red-team) | Một hằng `PROVIDER_FACT_FIELDS = ['transaction_id','amount','content','transfer_type']` trong `provider-events.ts`; webhook **và** cron đi qua cùng hàm `fingerprintFacts()`. Khác tập field giữa hai nguồn → cùng giao dịch ra hai fingerprint → 400 giả |

## Requirements

- [x] `POST /api/payfs/webhook` mount **trước** CORS và mọi route khác
- [x] Thiếu `PAYFS_WEBHOOK_API_KEY`/`PAYFS_WEBHOOK_SECRET` → `503 payfs_not_configured`; `constantTimeEqual(undefined, x)` trả `false`, không throw
- [x] `X-PayFS-Signature` phải khớp `/^[0-9a-f]{64}$/i` **trước** khi decode hex (D5: không tiền tố `sha256=`); sai định dạng → 401, không decode rác
- [x] Verify đúng thứ tự 6 bước D5 với mã lỗi: `>16KB → 413` · API key sai `→ 401` · timestamp lệch >300s `→ 401` · JSON hỏng `→ 400` · chữ ký lệch `→ 401` (kèm ghi raw với `verified=0`) · `transfer_type !== 'credit'` `→ 200` (ghi `provider_events`, không đụng đơn)
- [x] Idempotency tầng provider: partial unique index `(provider, provider_event_id) WHERE verified = 1` + `facts_fingerprint`; trùng ID cùng facts **và** row cũ đã có `outcome` → `already_processed` (200); trùng ID khác facts → **400**, tuyệt đối không retarget; trùng ID mà `outcome IS NULL` → xử lý lại từ đầu
- [x] Khớp đơn: chuỗi con trên `upper(content)` + `amount` khớp tuyệt đối + đơn đang `pending_payment`
- [x] Transition `pending_payment → paid` bằng `UPDATE … WHERE status='pending_payment'`, **cùng batch** với `INSERT provider_events(verified=1, outcome='paid')` + `INSERT provider_payments` + assertion cuối lô. **Không** enqueue email ở đây: MVP không có email "đơn đã trả" (PRD §3 chỉ hứa email chốt ngày + xác nhận refund), và `kind` CHECK của 0002 sẽ abort cả batch nếu ai đó thêm kind lạ
- [x] `provider_payments` đụng `UNIQUE(store_id, order_id)` → outcome `already_paid` + `needs_attention = 1` + **200** (không 500: PayFS sẽ retry 2.8 giờ vô ích, và Owner cần thấy khoản tiền thứ hai để hoàn tay)
- [x] `packages/orders/src/transitions/order-transitions.ts`: 5 guard thuần (`markPaidEligible`, `startPreparingEligible`, `fulfillEligible`, `cancelEligible`, `refundEligible`)
- [x] `scripts/dev/sign-payfs-payload.ts` dùng **chung** `sortKeysRecursive` với worker, chạy được offline và trong CI
- [x] Không có dòng nào của `packages/orders` biết PayFS tồn tại (C9)

## Architecture

```
POST /api/payfs/webhook  (apps/worker/src/payfs/verify-webhook.ts — cổng hẹp C9)
  1 size>16KB?            → 413 (chưa đọc body)
  2 X-Client-API-Key      → constantTimeEqual  → 401
  3 X-PayFS-Timestamp     → |now-ts|>300s      → 401
  4 TextDecoder(fatal) + JSON.parse            → 400
  5 data = ts + "." + JSON.stringify(sortKeysRecursive(payload))
    crypto.subtle.verify('HMAC', …)            → 401 + ghi provider_events(raw)
  6 transfer_type!=='credit' → ghi provider_events → 200
  ↓ VerifiedPayfsCredit
packages/orders/src/commands/payment-settlement.ts   (không biết HTTP, không biết PayFS SDK)
  settleCredit(db, { providerEventId, amountMinor, content, rawPayload })
    ├─ đọc provider_events WHERE provider=? AND provider_event_id=? AND verified=1
    │     tồn tại + cùng facts + outcome KHÔNG NULL → already_processed (200)
    │     tồn tại + khác facts                     → 400 provider_facts_conflict
    │     tồn tại + outcome IS NULL                → xử lý lại (không coi là trùng)
    ├─ matchPaymentReference(content) → null/ambiguous
    │     → batch [INSERT provider_events(verified=1, order_id=NULL, outcome='unmatched'|'unmatched_ambiguous')] → 200
    ├─ đơn không tồn tại / amount lệch / status≠pending_payment
    │     → batch [INSERT provider_events(outcome='order_not_found'|'amount_mismatch'|'already_paid'),
    │              UPDATE orders SET needs_attention=1 WHERE … (nếu có đơn)] → 200
    └─ db.batch([
         INSERT provider_events (verified=1, order_id=?, outcome='paid', source=?),
         UPDATE orders SET status='paid', updated_at=? WHERE store_id=? AND id=? AND status='pending_payment',
         INSERT provider_payments (UNIQUE store_id+order_id),
         assertion: CASE WHEN (SELECT status FROM orders WHERE id=?)='paid'
                          AND EXISTS(SELECT 1 FROM provider_payments WHERE order_id=?)
                          AND EXISTS(SELECT 1 FROM provider_events WHERE provider_event_id=? AND outcome='paid')
                     THEN <id> ELSE NULL END
       ])
       └─ batch vỡ vì provider_payments_store_order_unique
            → batch bù [INSERT provider_events(outcome='already_paid'), UPDATE orders SET needs_attention=1] → 200
```

Vì sao webhook trả **200** cho các nhánh "không khớp": PayFS retry tới ~2.8 giờ nếu nhận non-2xx (F13). Nhánh không khớp là trạng thái cuối của ta (đã ghi nhận để Owner xử lý), retry không làm nó khớp hơn. Chỉ trả lỗi cho những gì retry có thể sửa (400 facts conflict là lỗi phía gửi, 401/413 là từ chối).

## Files to create / modify

- Create: `apps/worker/src/payfs/canonicalize.ts` — `sortKeysRecursive`
- Create: `apps/worker/src/payfs/verify-webhook.ts` — `verifyPayfsWebhook(request, env)`
- Create: `apps/worker/src/payfs-webhook-routes.ts`
- Create: `packages/orders/src/commands/payment-settlement.ts` — `matchPaymentReference`, `settleCredit` (tên file và tên hàm **không** chứa `payfs`: A2 grep tên nhà cung cấp trong `packages/orders`)
- Create: `packages/orders/src/transitions/order-transitions.ts`
- Create: `packages/orders/src/provider-events.ts` — module sở hữu SQL của `provider_events`/`provider_payments`
- Create: `scripts/dev/sign-payfs-payload.ts`
- Create: `tests/fixtures/payfs/**` — `test-vector.json` (payload công bố, byte-exact); phase này **sở hữu** thư mục fixture, phase 10 chỉ thêm file
- Modify: `apps/worker/src/index.ts` — mount webhook trước CORS
- (Không migration nào ở phase này: `orders.needs_attention` đã nằm trong `0001-menu-core.sql` của phase 2)

## Tests Before (viết trước, phải đỏ)

| # | Test | Assert | Dữ liệu vào |
|---|---|---|---|
| T1 | `tests/unit/payfs-signature.test.ts :: khớp test vector công bố` | `HMAC_SHA256(ts + "." + JSON.stringify(sortKeysRecursive(payload)), secret)` = `86f02cefae56d51f72a00e04bf9d5a96b40cfe6902d54e495234c447ec706c5e` | secret `whsec_example_secret_do_not_use_in_production`, ts `1758173916`, payload trong `tests/fixtures/payfs/test-vector.json` (chú ý **hai khoảng trắng liên tiếp** trong `content`) |
| T2 | `tests/unit/payfs-signature.test.ts :: ký raw body cho digest khác` | Ký chuỗi body gốc với thứ tự khóa xáo trộn → digest **khác** T1 → chứng minh canonicalization là bắt buộc | cùng payload, khóa đảo thứ tự |
| T3 | `tests/unit/payfs-signature.test.ts :: sortKeysRecursive đệ quý và mảng` | Object lồng + mảng object → khóa sort ở mọi cấp, thứ tự phần tử mảng **không** đổi | payload lồng giả |
| T4 | `tests/unit/payment-settlement.test.ts :: matcher chạy trên mã do code sinh` | 200 mã từ `generatePaymentReference()` nhét vào `content` có rác ngân hàng bao quanh → tất cả khớp | `'NGUYEN VAN A chuyen tien  Ma giao dich  ' + ref + ' Trace773231'` |
| T5 | `tests/unit/payment-settlement.test.ts :: content hai mã → không khớp` | `content` chứa 2 mã `QM…` khác nhau → `{reference: null, reason: 'ambiguous'}` | 1 case |
| T6 | `tests/unit/order-transitions.test.ts :: 5 guard đúng bảng D9` | `markPaidEligible` chỉ `pending_payment`; `refundEligible` đúng 3 trạng thái; `fulfillEligible` chỉ `preparing`; sai → false | 6 trạng thái × 5 guard |
| T7 | `tests/integration/payfs-webhook.test.ts :: body >16KB → 413` | POST 17KB → 413; log không chứa nội dung body | body giả |
| T8 | `tests/integration/payfs-webhook.test.ts :: API key sai → 401` | Header sai → 401, `provider_events` **không** có row (chưa qua bước đọc payload) | 1 request |
| T9 | `tests/integration/payfs-webhook.test.ts :: timestamp cũ → 401` | ts = now-301s nhưng chữ ký toán học đúng → 401 | 1 request |
| T10 | `tests/integration/payfs-webhook.test.ts :: JSON hỏng → 400` | body `{"a":` → 400 | 1 request |
| T11 | `tests/integration/payfs-webhook.test.ts :: chữ ký lệch → 401 + ghi raw không chiếm khoá` | Sửa 1 ký tự sau khi ký → 401 **và** `provider_events` có đúng 1 row `verified=0` chứa raw body, `provider_event_id` bắt đầu bằng `unverified:`; sau đó gửi webhook **hợp lệ cùng `transaction_id`** → đơn vẫn `paid` | 2 request |
| T11b | `tests/integration/payfs-webhook.test.ts :: chữ ký sai định dạng → 401` | `X-PayFS-Signature` = `sha256=abc`, chuỗi 63 ký tự, chuỗi có `zz` → 401 cả ba, không decode, không ghi row `verified=1` | 3 request |
| T11c | `tests/integration/payfs-webhook.test.ts :: thiếu secret → 503` | Env không có `PAYFS_WEBHOOK_SECRET` (hoặc rỗng) → `503 payfs_not_configured` với payload ký đúng mọi mặt còn lại; **không** đổi trạng thái đơn nào | 2 env |
| T12 | `tests/integration/payfs-webhook.test.ts :: debit → 200 không đụng đơn` | `transfer_type='debit'` hợp lệ mọi mặt → 200, `orders` không đổi, `provider_events` +1 row | 1 request |
| T13 | `tests/integration/payfs-webhook.test.ts :: khớp đủ → paid` | Mã + amount khớp → đơn `paid`, `provider_payments` +1, `provider_events` +1 row `outcome='paid'`, tất cả trong **cùng một** batch; `order_email_jobs` **không** có job mới (MVP không email khi paid) | 1 đơn `pending_payment` |
| T14 | `tests/integration/payfs-webhook.test.ts :: replay cùng transaction_id → no-op` | Gửi hai lần cùng payload → lần 2 `already_processed`, `provider_payments` vẫn 1 row, `provider_events` vẫn 1 row | 2 request |
| T15 | `tests/integration/payfs-webhook.test.ts :: cùng ID khác facts → 400` | Đổi `amount` giữ `transaction_id` → 400, đơn cũ không bị đụng, không retarget | 2 request |
| T16 | `tests/integration/payfs-webhook.test.ts :: amount lệch → không paid` | Mã khớp, `amount` lệch 1 đồng → đơn vẫn `pending_payment`, `needs_attention=1`, `provider_events.outcome='amount_mismatch'` | 1 request |
| T17 | `tests/integration/payfs-webhook.test.ts :: hai webhook cùng đơn → chỉ một ghi nhận` | Hai `transaction_id` khác nhau cùng khớp một đơn → cái thứ hai vỡ `UNIQUE(store_id, order_id)`, rollback toàn batch, đơn vẫn `paid` một lần | 2 request |
| T18 | `tests/integration/payfs-webhook.test.ts :: batch settle vỡ thì không để lại ledger nửa vời` | Ép assertion cuối lô fail → `orders` vẫn `pending_payment`, `provider_payments` rỗng, `provider_events` **không** có row `outcome='paid'`; gửi lại cùng payload → lần này settle thành công (không bị `already_processed` khoá chết) | 2 request |
| T19 | `tests/integration/payfs-webhook.test.ts :: đơn đã paid, webhook khác đến` | Đơn `paid`, `transaction_id` khác khớp mã → 200 `outcome='already_paid'`, `needs_attention=1`, `provider_payments` vẫn 1 row (vỡ UNIQUE → batch bù), không job email | 1 request |
| T20 | `tests/node/dev-sign-script.test.ts :: script dev ký ra chữ ký worker chấp nhận` | Chạy script với secret test → header sinh ra được `verifyPayfsWebhook` chấp nhận; script import **cùng** module `canonicalize.ts` (kiểm bằng đọc import graph) | 1 payload |
| T21 | `tests/unit/provider-events.test.ts :: fingerprint dùng chung một tập field` | `fingerprintFacts()` trên payload webhook và trên bản ghi từ parser cron (thiếu `bank_account_number`) cho **cùng** digest; hằng `PROVIDER_FACT_FIELDS` là nơi duy nhất khai tập field | 2 input |

T1 là test rẻ nhất chặn được toàn bộ lớp lỗi canonicalization — viết **trước** cả route.

## Refactor / triển khai dưới lưới test

1. `canonicalize.ts`: `sortKeysRecursive` — `Object.keys(o).sort()` dựng object mới, đệ quy vào giá trị object, `map` qua mảng giữ nguyên thứ tự, giá trị nguyên thủy trả thẳng.
2. `verify-webhook.ts`: 6 bước theo Architecture, trả discriminated union `{ok:true, credit}` | `{ok:false, status, reason, rawBody?}`. Không export từng bước lẻ (cổng hẹp C9). `importKey` với `crypto.subtle.importKey('raw', secretBytes, {name:'HMAC', hash:'SHA-256'}, false, ['verify'])`.
3. `provider-events.ts`: sở hữu toàn bộ SQL của `provider_events`/`provider_payments`; hằng `PROVIDER_FACT_FIELDS = ['transaction_id','amount','content','transfer_type']` và `fingerprintFacts(facts)` = SHA-256 trên đúng tập đó (đã `trim` + NFKC `content`) — **dùng chung** với cron phase 5. Hàm `insertProviderEventStatement({verified, providerEventId, outcome, source, orderId, rawPayload})` trả statement để caller nhét vào batch.
4. `payment-settlement.ts`: `matchPaymentReference(content)` dùng `PAYMENT_REFERENCE_PATTERN` (phase 2) với cờ global, thu `Set`, `size > 1` → ambiguous. `settleCredit(db, credit, {source})` dựng **một** batch gồm cả `INSERT provider_events` theo Architecture; `recoverFailedBatch` (phase 3) phân loại: `provider_payments_store_order_unique` → batch bù `already_paid` + cờ → 200; assertion vỡ (không có gì được commit) → **đọc lại đơn**: nếu đã `paid` (batch khác thắng) → 200 `already_processed`; nếu chưa → trả **5xx** để PayFS retry (cron `*/1` là lưới sau). Không trả 200 cho một thất bại còn sửa được: 200 là lệnh "đừng gửi lại". `provider_events_verified_unique` vỡ → đọc lại row: cùng facts → 200 `already_processed`, khác facts → 400 `provider_facts_conflict`.
5. `order-transitions.ts`: 5 hàm guard thuần, không import D1, không async.
7. `payfs-webhook-routes.ts`: đọc body có giới hạn 16KB (đếm byte khi stream, không tin `Content-Length`), gọi verify → `settleCredit`, map outcome sang HTTP theo Architecture. Mount đầu tiên trong `index.ts`.
8. `scripts/dev/sign-payfs-payload.ts`: đọc payload từ file/stdin, `--secret`, `--timestamp` (mặc định now), `--post <url>`; import `sortKeysRecursive` từ `apps/worker/src/payfs/canonicalize.ts`; in 3 header. Chạy bằng `tsx`, không cần mạng.

## Tests After

| # | Test | Assert |
|---|---|---|
| A1 | `tests/integration/payfs-webhook.test.ts :: đáp ứng trong ngân sách thời gian` | Một webhook khớp xử lý xong < 1s trong workerd (biên rất xa mốc 30s của PayFS) |
| A2 | `tests/node/payfs-gate.test.ts :: packages/orders không biết PayFS` | Grep `packages/orders/src`: không có `api.payfs.vn`, không `X-PayFS`, không `subtle.verify` — mọi thứ đó chỉ ở `apps/worker/src/payfs/` (C9) |
| A3 | `tests/integration/payfs-webhook.test.ts :: luồng end-to-end local` | Tạo đơn qua route phase 3 → chạy script dev-sign với `payment_reference` thật của đơn → đơn `paid`; đây là bằng chứng hoàn thành M1 |

## Todo

- [x] T1–T21 viết trước và đỏ (T1 đầu tiên)
- [x] `canonicalize.ts` + `verify-webhook.ts`
- [x] `provider-events.ts` + `payment-settlement.ts`
- [x] `order-transitions.ts`
- [x] `payfs-webhook-routes.ts` + mount đầu tiên
- [x] `scripts/dev/sign-payfs-payload.ts`
- [x] A1–A3 xanh

## Regression gate

```bash
npm run typecheck && npm test
```

Cộng thêm bằng chứng tay một lần: `npm run dev` + `tsx scripts/dev/sign-payfs-payload.ts --post http://127.0.0.1:5173/api/payfs/webhook` làm một đơn thật chuyển `paid`.

## Success criteria

- [x] T1–T21 (gồm T11b, T11c), A1–A3 xanh
- [x] Test vector công bố khớp chính xác `86f02cef…c5e`
- [x] Không đường nào ghi nhận tiền hai lần cho một đơn (T14, T17)
- [x] Không webhook nào bị nuốt im lặng: mọi nhánh đều có row `provider_events` với `outcome`
- [x] `packages/orders` không chứa tên PayFS (A2)

## Risks

| Rủi ro | Mitigation |
|---|---|
| Canonicalization lệch khi `content` có ký tự tiếng Việt/ký tự lạ | T1 dùng payload byte-exact công bố (có hai khoảng trắng liên tiếp); bước 4 decode `fatal:true` để không âm thầm thay ký tự lỗi; chữ ký lệch ghi raw để debug được sau |
| Trả 200 cho nhánh không khớp che mất sự cố | Mọi nhánh 200 đều ghi `provider_events.outcome` và bật `needs_attention`; phase 7 hiện cờ này lên Console cho Owner |
| Script dev tự ký làm test pass giả | T20 kiểm script và worker **dùng chung** module canonicalize; T1 neo vào digest công bố của PayFS, không phải digest tự sinh |
| Ambiguous content bị bỏ qua lặng lẽ | T5 + outcome `unmatched_ambiguous` + cờ Owner |

## Security

- API key so bằng `constantTimeEqual`; chữ ký so bằng `subtle.verify` — không `!==` (sửa F6 của repo mẫu).
- Ba secret ba tên: `PAYFS_WEBHOOK_API_KEY`, `PAYFS_WEBHOOK_SECRET`, `PAYFS_API_TOKEN` (C11). Không biến nào dùng lại cho việc khác.
- Raw body lưu trong `provider_events` là dữ liệu giao dịch — không log ra stdout, chỉ nằm trong D1 và chỉ Owner đọc được (phase 7).
- Từ chối body > 16KB **trước** khi đọc để không mở cửa cho gửi rác làm cạn CPU.

## Ghi chú thi công (2026-09-26)

- `settleCredit(db, {storeId, provider, source, facts, rawPayload})` trung lập với nhà cung cấp: worker truyền `provider = 'payfs'`, `packages/orders` không chứa chữ `payfs` (A2). Kết quả: `recorded{outcome}` → 200 `{outcome}` · `already_processed` → 200 · `facts_conflict` → 400 `provider_facts_conflict` · `retry` → 503 `settlement_retry`.
- Tiền về cho đơn `cancelled` → `unmatched_payment` + `needs_attention = 1` ngay ở phase này (phase 5 T8 dùng lại). Đơn không còn `pending_payment` → `already_paid` + cờ.
- Mọi row `provider_events` do module này ghi đều có `outcome` ngay khi insert, nên nhánh "outcome IS NULL → xử lý lại" của plan không thể xảy ra; gặp row như vậy (dữ liệu ngoài) → `retry` (5xx) để lộ ra thay vì nuốt.
- Assertion cuối lô vỡ chỉ còn một nguyên nhân (đơn rời `pending_payment` giữa lúc đọc và batch — thanh toán cạnh tranh vỡ sớm hơn ở `PAYMENT_TAKEN`/`EVENT_TAKEN`) → `retry`, không đọc lại.
- T18 ép assertion vỡ bằng trigger chỉ tồn tại trong test (xoá row `provider_payments` vừa chèn), không thêm seam vào code sản phẩm.
- T1 ký cả bản fixture lẫn bản đảo khoá: fixture công bố vốn đã sort, nên chỉ ký nguyên bản thì bỏ canonicalization vẫn xanh (đã tái hiện bằng mutation).
- T20 kiểm hành vi (script ký → verifier chấp nhận, payload khoá lộn xộn + tiếng Việt), không đọc import graph của script.
- Bằng chứng tay: `wrangler dev` + `tsx scripts/dev/sign-payfs-payload.ts --post …` — sai secret 401 (ghi `signature_invalid`), đúng secret → `paid`, gửi lại → `already_processed`, một row `provider_payments`.

## Next

Phase 5 tái dùng **chính** `settleCredit` của phase này cho cron đối soát — tuyệt đối không viết đường ghi nhận tiền thứ hai. Phase 7 hiện `needs_attention` và `provider_events` lên Console.
