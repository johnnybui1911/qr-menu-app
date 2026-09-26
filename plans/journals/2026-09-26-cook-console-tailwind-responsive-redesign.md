---
title: "Cook: console Tailwind responsive redesign"
date: 2026-09-26
summary: "Implemented plans/260926-2014-console-responsive-redesign. Tailwind v4 via @tailwindcss/vite (console only). Base layer styles all buttons/inputs/labels so preflight never leaves raw controls; kept legacy class names (.console-error, .badge, .kitchen-ticket, dialogs) as @layer components to limit JSX churn and keep e2e locator .kitchen-ticket. Caught: menu edit-name input dropped by an over-wide edit range, restored. Mobile header wrapped brand/sign-out; fixed with nowrap + hide email <sm. Evidence: typecheck, test:browser 29/29, build:console+import graph, build:storefront (no tailwind), e2e money-flow pass, 19 screenshots with zero horizontal overflow. kongming unavailable."
---

# Cook: console Tailwind responsive redesign

Implemented plans/260926-2014-console-responsive-redesign. Tailwind v4 via @tailwindcss/vite (console only). Base layer styles all buttons/inputs/labels so preflight never leaves raw controls; kept legacy class names (.console-error, .badge, .kitchen-ticket, dialogs) as @layer components to limit JSX churn and keep e2e locator .kitchen-ticket. Caught: menu edit-name input dropped by an over-wide edit range, restored. Mobile header wrapped brand/sign-out; fixed with nowrap + hide email <sm. Evidence: typecheck, test:browser 29/29, build:console+import graph, build:storefront (no tailwind), e2e money-flow pass, 19 screenshots with zero horizontal overflow. kongming unavailable.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
