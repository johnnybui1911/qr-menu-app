---
title: "Cook QR Menu MVP: phase 1-10 (in-repo)"
date: 2026-09-26
summary: "Trien khai plan 260919-1418 theo TDD + --advice: M1-M3 xanh, e2e luong tien chan merge; con O7/O8/prod"
---

# Cook QR Menu MVP: phase 1-10 (in-repo)

# Cook QR Menu MVP — phase 1–10 (phạm vi trong repo)

> Historical work record — not durable authority. Nguồn sự thật: `plans/260919-1418-qr-menu-mvp/` (mục "Ghi chú thi công" từng phase).

`/ak:cook --advice` trên plan `260919-1418-qr-menu-mvp`. Kongming tư vấn sau mỗi phase (same-model, host không pin được Fable); phase 6, 8, 9, 10 giao subagent với hợp đồng file chung, phase còn lại làm trực tiếp.

## Kết quả đo được
- 5 cổng CI chạy tay đều xanh: typecheck · `npm test` (node 57 + 2 skip chờ O7, workerd 294, browser 27) · build console · build storefront · e2e luồng tiền (1 spec, 14 s).
- Chạy thật: `wrangler dev` cho storefront/webhook/cron; A2 hai origin trên trình duyệt: khách đặt 85.000 ₫ → dev-sign → màn khách `paid`, bếp thấy đơn trong một chu kỳ poll → prepare → fulfil.

## Lỗi thật bắt được (không phải test tự nhất quán)
- D1 từ chối GLOB dài (`payment_reference` CHECK); D1 tối đa 100 tham số bind/câu.
- `beforeEach(resetDb)` truyền context Vitest làm `through` → 0 migration.
- `*/5` trong JSDoc đóng comment; gate PayFS bắt comment nêu tên nhà cung cấp trong `packages/orders`.
- Hash-hoist npm workspaces làm lớp "dependency" của D3 không tồn tại → thêm `resolveId`; rolldown inline hằng số lọt gate import-graph → ghi module ở `moduleParsed`.
- Fixture PayFS công bố đã sort khoá → T1 không bắt được bỏ canonicalization; ký thêm bản đảo khoá.
- Replay đặt đơn không trả được token server sinh → đổi sang capability do client sinh (tư vấn kongming).
- Assertion kiểu "trạng thái cuối" không bắt race hai lệnh → assertion `changes() = 1`.
- Dev console chạy trên D1 chưa migrate (`persistState`); lỗi session bị nuốt thành `auth_not_configured` không log.

## Còn mở (cần người dùng)
Tạo D1/R2 production + `wrangler login` · commit/remote để CI chạy lần đầu · Google OAuth client thật · O7 PayFS (fixture `/v1.1/transactions`, smoke tiền thật, quét QR bằng app ngân hàng) · O8 Resend domain · A3 migration production · ảnh chụp A2 · chính sách registry cho `.npmrc`.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
