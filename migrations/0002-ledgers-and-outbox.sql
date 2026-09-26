-- Idempotency ledgers (D10) and the email outbox (D12, D23). Created before any write path so every
-- state-changing db.batch() can include its ledger row and email job from day one.

-- Customer order placement: one row per Idempotency-Key.
CREATE TABLE order_idempotency (
  id TEXT PRIMARY KEY NOT NULL,
  store_id TEXT NOT NULL,
  request_key TEXT NOT NULL CHECK (length(request_key) BETWEEN 16 AND 128 AND request_key NOT GLOB '*[^A-Za-z0-9_-]*'),
  capability_digest TEXT NOT NULL CHECK (length(capability_digest) = 64 AND capability_digest NOT GLOB '*[^0-9a-f]*'),
  order_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT order_idempotency_store_fk FOREIGN KEY (store_id) REFERENCES stores(id),
  -- The ledger's capability is the order's capability: replay compares digests, a mismatch is idempotency_conflict.
  CONSTRAINT order_idempotency_access_fk
    FOREIGN KEY (order_id, store_id, capability_digest) REFERENCES order_access(order_id, store_id, capability_digest),
  CONSTRAINT order_idempotency_store_key_unique UNIQUE (store_id, request_key)
);

-- Console commands: replay the stored result for the same key and payload; a different payload is a 409.
CREATE TABLE order_commands (
  id TEXT PRIMARY KEY NOT NULL,
  store_id TEXT NOT NULL,
  request_key TEXT NOT NULL CHECK (length(request_key) BETWEEN 16 AND 128 AND request_key NOT GLOB '*[^A-Za-z0-9_-]*'),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 64),
  order_id TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT order_commands_store_fk FOREIGN KEY (store_id) REFERENCES stores(id),
  CONSTRAINT order_commands_order_fk FOREIGN KEY (order_id, store_id) REFERENCES orders(id, store_id),
  CONSTRAINT order_commands_store_key_unique UNIQUE (store_id, request_key)
);

-- Payment provider events. Unverified deliveries are stored for debugging (verified = 0) but never occupy the
-- idempotency key, which is a partial unique index over verified rows only. order_id is NULL when no order matched.
CREATE TABLE provider_events (
  id TEXT PRIMARY KEY NOT NULL,
  store_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 32),
  provider_event_id TEXT NOT NULL CHECK (length(provider_event_id) BETWEEN 1 AND 200),
  source TEXT NOT NULL CHECK (source IN ('webhook', 'reconciliation')),
  verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
  facts_fingerprint TEXT CHECK (length(facts_fingerprint) = 64 AND facts_fingerprint NOT GLOB '*[^0-9a-f]*'),
  raw_payload TEXT NOT NULL,
  order_id TEXT,
  -- NULL means no final outcome was recorded; such events are processed again rather than reported as duplicates.
  outcome TEXT CHECK (outcome IN (
    'paid', 'already_paid', 'amount_mismatch', 'order_not_found', 'unmatched', 'unmatched_ambiguous',
    'unmatched_payment', 'ignored_debit', 'signature_invalid'
  )),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT provider_events_verified_fingerprint CHECK (verified = 0 OR facts_fingerprint IS NOT NULL),
  CONSTRAINT provider_events_store_fk FOREIGN KEY (store_id) REFERENCES stores(id),
  CONSTRAINT provider_events_order_fk FOREIGN KEY (order_id, store_id) REFERENCES orders(id, store_id)
);
CREATE UNIQUE INDEX provider_events_verified_unique ON provider_events (provider, provider_event_id) WHERE verified = 1;
CREATE INDEX provider_events_order_idx ON provider_events (store_id, order_id, created_at ASC, id ASC);

CREATE TABLE provider_payments (
  id TEXT PRIMARY KEY NOT NULL,
  store_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor BETWEEN 1 AND 9007199254740991),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT provider_payments_store_fk FOREIGN KEY (store_id) REFERENCES stores(id),
  CONSTRAINT provider_payments_order_fk FOREIGN KEY (order_id, store_id) REFERENCES orders(id, store_id),
  -- The last line of defence against recording a payment twice (D10).
  CONSTRAINT provider_payments_store_order_unique UNIQUE (store_id, order_id)
);

-- Email outbox. Jobs are enqueued inside the same batch as the state change they announce; duplicates are rejected by
-- UNIQUE (store_id, dedupe_key) with a single INSERT. payload_json is nulled once a job finishes (it may carry a raw
-- invitation token).
CREATE TABLE order_email_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  store_id TEXT NOT NULL,
  order_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('daily_revenue_report', 'refund_confirmed', 'invitation')),
  dedupe_key TEXT NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 200),
  payload_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'retired')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 8),
  available_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_error TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT order_email_jobs_delivery_shape CHECK ((status = 'sent') = (delivered_at IS NOT NULL)),
  CONSTRAINT order_email_jobs_store_fk FOREIGN KEY (store_id) REFERENCES stores(id),
  CONSTRAINT order_email_jobs_order_fk FOREIGN KEY (order_id, store_id) REFERENCES orders(id, store_id),
  CONSTRAINT order_email_jobs_store_dedupe_unique UNIQUE (store_id, dedupe_key)
);
CREATE INDEX order_email_jobs_claim_idx ON order_email_jobs (status, available_at ASC, id ASC);
