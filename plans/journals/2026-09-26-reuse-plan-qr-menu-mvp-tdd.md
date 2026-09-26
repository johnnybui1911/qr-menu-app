---
title: Tái dùng plan QR Menu MVP cho --tdd
date: 2026-09-26
summary: "Không lập plan mới: plan 260919-1418 còn hiện hành, đã sweep và hydrate 10 phase"
---

# Tái dùng plan QR Menu MVP cho --tdd

# Tái dùng plan QR Menu MVP cho `/ak:plan --tdd`

> Historical work record — not durable authority.

Yêu cầu `/ak:plan --tdd to implement qr-menu-app` trùng phạm vi với plan đang active [`260919-1418-qr-menu-mvp`](../260919-1418-qr-menu-mvp/plan.md). Không tạo plan thứ hai để tránh hai nguồn sự thật.

## Bằng chứng plan còn hiện hành
- Mọi đầu vào (`docs/PRD.md`, Decision Record, 3 report brainstorm/xia) có mtime ≤ 2026-09-19 21:36; plan viết xong 23:22 cùng ngày.
- Repo chưa có commit/code nào → không có drift giữa plan và code.
- Sweep: 0 link hỏng; 10/10 phase có đủ Tests Before → Refactor → Tests After → Regression gate; deps frontmatter khớp bảng DAG trong `plan.md`; 254/254 checkbox chưa làm.

## Đã làm
- Hydrate 10 phase vào task view (3 nhóm mốc M0–M1, M2–M3, M4).

## Bước kế
`/ak:cook plans/260919-1418-qr-menu-mvp/plan.md` từ phase 1. Phase 10 bị chặn bởi O7 (đăng ký PayFS) và O8 (verify domain Resend).

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
