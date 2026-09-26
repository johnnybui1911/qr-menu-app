---
title: Plan QR Menu MVP theo TDD
date: 2026-09-19
summary: "Lập kế hoạch 10 phase cho MVP QR Menu trên Cloudflare: 4 scout trích pattern từ docs/reference/nexus, 10 phase file TDD, red-team 4 persona tìm 13 blocker (tất cả đã sửa vào plan)"
---

# Plan QR Menu MVP theo TDD

Kế hoạch: [`plans/260919-1418-qr-menu-mvp/`](../260919-1418-qr-menu-mvp/plan.md) · chế độ `/ak:plan --tdd`, mode tự phát hiện `hard`.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.

## Đầu vào

`docs/PRD.md` · `docs/decisions/260919-post-xia-decision-record.md` (D1–D23, F1–F13 — **LOCKED**) · ba report brainstorm/xia trong `plans/reports/` · 4.769 dòng pattern trong `docs/reference/nexus/`. Repo hoàn toàn trống code (`git log` không có commit nào).

## Việc đã làm

1. **Scout song song 4 nhánh** đọc `docs/reference/nexus/` (5.647 dòng) → 4 report trong `plans/260919-1418-qr-menu-mvp/reports/scout-0*.md`: build/test harness · tầng D1+R2 · PayFS & hợp đồng tiền · identity/auth/RBAC. Mỗi khẳng định kèm `file:line`; mọi chỗ tài liệu tham chiếu mâu thuẫn Decision Record đều được ghi rõ là "Decision Record thắng".
2. **10 phase file TDD** (`ak plan create` + `add-phase`), mỗi phase có Tests Before → Refactor → Tests After → Regression gate. Tổng 254 checkbox, effort 84h, thứ tự theo khuyến nghị "A rồi C" của brainstorm: lát cắt dọc luồng tiền (1→4) rồi hai nhánh song song (3→5 ∥ 6→8).
3. **14 hợp đồng liên phase (C1–C14)** trong `plan.md` + bảng sở hữu file để chạy song song không đụng nhau.
4. **Red-team 4 persona** (Assumptions · Failure modes · Scope · Security) → 13 blocker, **đã sửa hết vào plan** trước khi giao.

## Bốn phát hiện đắt nhất của red-team

| Vấn đề | Hậu quả nếu không sửa |
|---|---|
| `INSERT provider_events` nằm **ngoài** batch settle | Worker chết giữa hai bước → `already_processed` khoá chết đơn; cả webhook retry lẫn cron đối soát đều bỏ qua → khách trả tiền, đơn bị huỷ ở phút 30 |
| Row webhook **chưa xác thực** chiếm khoá `UNIQUE(provider, transaction_id)` | Đúng lỗi canonicalization mà D5 dự báo: sửa bug xong, webhook hợp lệ retry bị 400 vì facts khác → không đơn nào `paid` |
| Bootstrap cổng 1 không kiểm `emailVerified` | Tài khoản Google giả đốt `store_bootstrap_claims` (PK = `store_id`) → Owner thật vĩnh viễn không vào được, phải sửa D1 production bằng tay |
| ~45 test `tests/node/**` + `tests/browser/**` không có runner | Gate import-graph (D3), hostname (D21), secret-scan (D16) chỉ là hình thức — không bao giờ chặn merge |

## Quyết định thi công tự chốt trong lúc lập kế hoạch

- Bảng `stores` + FK thay cho `CHECK (store_id = 'store_default')` rải 14 bảng; literal chỉ còn ở seed migration và hằng `STORE_ID`.
- `order_code` (6 ký tự, cho người đọc) tách khỏi `payment_reference` (`QM`+8, cho đối soát) — hai generator, cùng một module.
- Bỏ `order:assign` và `STAFF_ASSIGNED_ACTIONS` của repo mẫu: PRD cho nhân viên nhận bất kỳ đơn nào, giữ cơ chế gán là thêm khái niệm không ai dùng.
- Storefront **không** import `@qr/*` kể cả để format tiền (`Intl.NumberFormat('vi-VN')` cục bộ) — giữ `dependencies` rỗng làm lớp cưỡng chế chính của D3.
- VietQR: server trả payload EMVCo, client render QR cục bộ; không phụ thuộc dịch vụ sinh ảnh QR ngoài ở đúng bước khách trả tiền.
- Ba `kind` email chốt ngay ở migration 0002 (`daily_revenue_report`, `refund_confirmed`, `invitation`) + `dedupe_key` — để phase 6 chạy song song không phải copy-drop-recreate bảng ledger của phase 5.
- Test âm cho e2e dùng dev-sign sai secret, **không** thêm biến môi trường tắt được bước ghi nhận tiền.

## Còn mở (không chặn phase 1–9)

O6 gói PayFS · O7 đăng ký PayFS + nối ngân hàng · O8 verify domain Resend + email Owner + giờ chốt ngày · O9 cutover origin. Cả bốn chỉ chặn phase 10.

## Vòng sửa thứ hai (advisory)

16 chỗ plan **tự mâu thuẫn** được bắt sau vòng red-team và đã sửa: `typecheck` rơi khỏi cổng CI · `resetDb` DROP theo `sqlite_master` vỡ FK (thêm `PRAGMA defer_foreign_keys`) · bỏ binding/fixture probe vô dụng của phase 1 · VietQR phải neo vào chuỗi mẫu công bố + quét bằng app ngân hàng thật · `payfs-matching.ts` vi phạm chính acceptance A2 → `payment-settlement.ts` · base URL nhà cung cấp vào `vars` (`PAYFS_API_BASE`, `RESEND_API_BASE`) thay vì literal · `conflict_retry` trả 200 làm mất retry → 5xx · cursor bếp thành keyset hai cột · bỏ `order:accept` không ai dùng · gộp `needs_attention` vào 0001 và ba `kind` vào 0002 (dự án còn **5** migration) · `email-outbox.ts` khai là file dùng chung thứ tư · chốt token lời mời trong `payload_json` + null hoá khi job kết thúc · bỏ `VITE_CONSOLE_API_BASE_URL` (Console cùng origin) · nối `test:browser` vào `npm test` · phase 8 T17 không còn phụ thuộc phase 3 · carve-out ownership `tests/support/console-session.ts`.

Bài học lặp lại hai lần trong phiên: **test tự nhất quán không phải bằng chứng**. Chữ ký PayFS (ký JSON chuẩn hoá, không raw body), payload VietQR, và định dạng cookie better-auth đều cần một mốc neo bên ngoài; plan giờ có đúng một test neo cho mỗi cái.

## Bước kế

`/ak:cook plans/260919-1418-qr-menu-mvp/plan.md` bắt đầu từ phase 1. Phase 1 tồn tại để chứng minh ba giả định nguy hiểm nhất (`applyD1Migrations` trong workerd, `run_worker_first` chặn asset fallback, gate import-graph hai app) trước khi có dòng nghiệp vụ nào.
