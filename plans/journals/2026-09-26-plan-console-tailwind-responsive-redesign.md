---
title: "Plan: console Tailwind responsive redesign"
date: 2026-09-26
summary: "Fast-mode plan plans/260926-2014-console-responsive-redesign. Switched from plain CSS to Tailwind v4 (@tailwindcss/vite 4.3.3, console-only) per user. Key risk: preflight resets unclassed elements; mitigated by base layer. Tests query role/label/text only, so className changes are safe. Visual proof via mintConsoleSession harness."
---

# Plan: console Tailwind responsive redesign

Fast-mode plan plans/260926-2014-console-responsive-redesign. Switched from plain CSS to Tailwind v4 (@tailwindcss/vite 4.3.3, console-only) per user. Key risk: preflight resets unclassed elements; mitigated by base layer. Tests query role/label/text only, so className changes are safe. Visual proof via mintConsoleSession harness.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
