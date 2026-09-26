# PayFS webhook signature test vector

Published at https://docs.payfs.vn/vi/developers/webhook-signature (section "Kiểm thử"), recorded in
`docs/decisions/260919-post-xia-decision-record.md` (D5) and `plans/260919-1418-qr-menu-mvp/reports/scout-03-payfs-and-money-contracts.md`.

- secret: `whsec_example_secret_do_not_use_in_production`
- timestamp: `1758173916`
- payload: `test-vector.json` (byte-exact; note the two consecutive spaces inside `content`)
- expected `X-PayFS-Signature`: `86f02cefae56d51f72a00e04bf9d5a96b40cfe6902d54e495234c447ec706c5e`
