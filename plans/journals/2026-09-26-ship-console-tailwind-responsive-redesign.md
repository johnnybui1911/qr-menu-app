---
title: "Ship: console Tailwind responsive redesign"
date: 2026-09-26
summary: "Shipped feature/console-tailwind-redesign -> main (issue #1). Pre-landing review: 0 critical, 5 informational, all fixed: shadow backdrop let taps reach Tắt bàn/Xuất QR/Thu hồi behind dialogs (now real .dialog-backdrop element, verified by throwaway Playwright click-through check); focus:outline-none cancelled focus-visible outline on inputs; .standalone-screen overrode .console-error colours; inputMode=numeric blocked decimal prices on iOS; email hidden from AT on phones (now sr-only). Excluded user's concurrent sign-out-button test edit from the commit."
---

# Ship: console Tailwind responsive redesign

Shipped feature/console-tailwind-redesign -> main (issue #1). Pre-landing review: 0 critical, 5 informational, all fixed: shadow backdrop let taps reach Tắt bàn/Xuất QR/Thu hồi behind dialogs (now real .dialog-backdrop element, verified by throwaway Playwright click-through check); focus:outline-none cancelled focus-visible outline on inputs; .standalone-screen overrode .console-error colours; inputMode=numeric blocked decimal prices on iOS; email hidden from AT on phones (now sr-only). Excluded user's concurrent sign-out-button test edit from the commit.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
