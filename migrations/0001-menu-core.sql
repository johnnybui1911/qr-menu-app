-- Menu, tables and orders. Every business table carries store_id (D4) with a FK to stores; parents expose
-- UNIQUE (id, store_id) so children reference them as a pair and cannot cross tenants.

CREATE TABLE stores (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO stores (id, name) VALUES ('store_default', 'QR Menu');

CREATE TABLE categories (
  id TEXT PRIMARY KEY NOT NULL,
  store_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  slug TEXT NOT NULL CHECK (length(slug) BETWEEN 1 AND 120),
  display_order INTEGER NOT NULL DEFAULT 0 CHECK (display_order >= 0),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT categories_store_fk FOREIGN KEY (store_id) REFERENCES stores(id),
  CONSTRAINT categories_store_slug_unique UNIQUE (store_id, slug),
  CONSTRAINT categories_id_store_unique UNIQUE (id, store_id)
);

CREATE TABLE products (
  id TEXT PRIMARY KEY NOT NULL,
  store_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  currency TEXT NOT NULL DEFAULT 'VND' CHECK (length(currency) = 3 AND currency = upper(currency)),
  price_minor INTEGER NOT NULL CHECK (price_minor BETWEEN 0 AND 9007199254740991),
  is_available INTEGER NOT NULL DEFAULT 1 CHECK (is_available IN (0, 1)),
  -- Products are hidden, never deleted: order_items keep pointing at them (phase 8 decision #1).
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  display_order INTEGER NOT NULL DEFAULT 0 CHECK (display_order >= 0),
  image_key TEXT,
  image_filename TEXT,
  image_content_type TEXT,
  image_size INTEGER,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT products_store_fk FOREIGN KEY (store_id) REFERENCES stores(id),
  CONSTRAINT products_category_fk FOREIGN KEY (category_id, store_id) REFERENCES categories(id, store_id),
  CONSTRAINT products_id_store_unique UNIQUE (id, store_id),
  CONSTRAINT products_image_all_or_none CHECK (
    (image_key IS NULL AND image_filename IS NULL AND image_content_type IS NULL AND image_size IS NULL)
    OR (image_key IS NOT NULL AND image_filename IS NOT NULL
        AND image_content_type IN ('image/jpeg', 'image/png', 'image/webp')
        AND image_size BETWEEN 1 AND 5000000)
  )
);
CREATE INDEX products_store_menu_idx ON products (store_id, category_id, is_active, is_available, display_order, id);

CREATE TABLE tables (
  id TEXT PRIMARY KEY NOT NULL,
  store_id TEXT NOT NULL,
  table_number TEXT NOT NULL CHECK (length(table_number) BETWEEN 1 AND 32),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT tables_store_fk FOREIGN KEY (store_id) REFERENCES stores(id),
  CONSTRAINT tables_store_number_unique UNIQUE (store_id, table_number),
  CONSTRAINT tables_id_store_unique UNIQUE (id, store_id)
);

-- D17: table tokens are stored as digests only; several digests may be live during the rotation grace window.
CREATE TABLE table_secrets (
  id TEXT PRIMARY KEY NOT NULL,
  store_id TEXT NOT NULL,
  table_id TEXT NOT NULL,
  token_digest TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  revoked_at TEXT,
  CONSTRAINT table_secrets_token_digest_format CHECK (length(token_digest) = 64 AND token_digest NOT GLOB '*[^0-9a-f]*'),
  CONSTRAINT table_secrets_store_fk FOREIGN KEY (store_id) REFERENCES stores(id),
  CONSTRAINT table_secrets_table_fk FOREIGN KEY (table_id, store_id) REFERENCES tables(id, store_id),
  CONSTRAINT table_secrets_store_digest_unique UNIQUE (store_id, token_digest)
);
CREATE INDEX table_secrets_lookup_idx ON table_secrets (store_id, token_digest, revoked_at);

CREATE TABLE orders (
  id TEXT PRIMARY KEY NOT NULL,
  store_id TEXT NOT NULL,
  order_code TEXT NOT NULL CHECK (length(order_code) = 6 AND order_code NOT GLOB '*[^0-9A-Z]*'),
  table_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_payment'
    CHECK (status IN ('pending_payment', 'paid', 'preparing', 'fulfilled', 'cancelled', 'refunded')),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  total_amount_minor INTEGER NOT NULL CHECK (total_amount_minor BETWEEN 0 AND 9007199254740991),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('vietqr')),
  -- D18: generated in application code only; no column DEFAULT.
  payment_reference TEXT NOT NULL,
  needs_attention INTEGER NOT NULL DEFAULT 0 CHECK (needs_attention IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- D1 rejects long GLOB patterns ("pattern too complex"), so the per-character class is spelled as length + prefix + a
  -- short negated class.
  CONSTRAINT orders_payment_reference_format CHECK (
    length(payment_reference) = 10
    AND substr(payment_reference, 1, 2) = 'QM'
    AND substr(payment_reference, 3) NOT GLOB '*[^0-9A-Z]*'
  ),
  CONSTRAINT orders_store_fk FOREIGN KEY (store_id) REFERENCES stores(id),
  CONSTRAINT orders_table_fk FOREIGN KEY (table_id, store_id) REFERENCES tables(id, store_id),
  CONSTRAINT orders_store_code_unique UNIQUE (store_id, order_code),
  CONSTRAINT orders_store_payment_reference_unique UNIQUE (store_id, payment_reference),
  CONSTRAINT orders_id_store_unique UNIQUE (id, store_id),
  CONSTRAINT orders_id_store_currency_unique UNIQUE (id, store_id, currency)
);
-- Kitchen polling reads keyset (updated_at, id) > (?, ?) ordered by updated_at, id.
CREATE INDEX orders_kitchen_idx ON orders (store_id, updated_at ASC, id ASC);
CREATE INDEX orders_status_created_idx ON orders (store_id, status, created_at ASC, id ASC);
-- The kitchen inbox polls by (updated_at, id). A writer that changes status or the attention flag but forgets
-- updated_at would hide the order from every client already past it, so the schema bumps it instead of trusting
-- each writer. Recursive triggers are off in D1, so this UPDATE does not re-fire the trigger.
CREATE TRIGGER orders_touch_updated_at
AFTER UPDATE OF status, needs_attention ON orders
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE orders SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- D8: the customer's Secret Link capability, digest only; kept apart from orders so an orders dump carries no capability.
CREATE TABLE order_access (
  id TEXT PRIMARY KEY NOT NULL,
  store_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  capability_digest TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT order_access_capability_digest_format
    CHECK (length(capability_digest) = 64 AND capability_digest NOT GLOB '*[^0-9a-f]*'),
  CONSTRAINT order_access_store_fk FOREIGN KEY (store_id) REFERENCES stores(id),
  CONSTRAINT order_access_order_fk FOREIGN KEY (order_id, store_id) REFERENCES orders(id, store_id),
  CONSTRAINT order_access_one_per_order UNIQUE (order_id, store_id),
  CONSTRAINT order_access_store_digest_unique UNIQUE (store_id, capability_digest),
  -- Target of order_idempotency's FK: a replayed key must carry the capability the order was created with.
  CONSTRAINT order_access_order_capability_unique UNIQUE (order_id, store_id, capability_digest)
);

CREATE TABLE order_items (
  id TEXT PRIMARY KEY NOT NULL,
  store_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  product_name_snapshot TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  unit_price_snapshot_minor INTEGER NOT NULL CHECK (unit_price_snapshot_minor BETWEEN 0 AND 9007199254740991),
  line_total_minor INTEGER NOT NULL,
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  notes TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 500),
  position INTEGER NOT NULL CHECK (position >= 0),
  -- D11.4: the line total is guarded in SQL, not only in application code.
  CONSTRAINT order_items_line_total CHECK (
    line_total_minor BETWEEN 0 AND 9007199254740991 AND line_total_minor = unit_price_snapshot_minor * quantity
  ),
  CONSTRAINT order_items_store_fk FOREIGN KEY (store_id) REFERENCES stores(id),
  CONSTRAINT order_items_order_currency_fk FOREIGN KEY (order_id, store_id, currency) REFERENCES orders(id, store_id, currency),
  CONSTRAINT order_items_product_fk FOREIGN KEY (product_id, store_id) REFERENCES products(id, store_id),
  CONSTRAINT order_items_order_position_unique UNIQUE (order_id, store_id, position)
);

CREATE TABLE refund_requests (
  id TEXT PRIMARY KEY NOT NULL,
  store_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  requested_by_staff_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  decided_at TEXT,
  decided_by_user_id TEXT,
  CONSTRAINT refund_requests_store_fk FOREIGN KEY (store_id) REFERENCES stores(id),
  CONSTRAINT refund_requests_order_fk FOREIGN KEY (order_id, store_id) REFERENCES orders(id, store_id),
  CONSTRAINT refund_requests_store_order_unique UNIQUE (store_id, order_id),
  CONSTRAINT refund_requests_decision_shape CHECK (
    (status = 'pending' AND decided_at IS NULL AND decided_by_user_id IS NULL)
    OR (status IN ('approved', 'rejected') AND decided_at IS NOT NULL AND decided_by_user_id IS NOT NULL)
  )
);
CREATE INDEX refund_requests_status_idx ON refund_requests (store_id, status, created_at ASC, id ASC);
CREATE TRIGGER refund_requests_terminal_immutable
BEFORE UPDATE ON refund_requests
WHEN OLD.status IN ('approved', 'rejected')
BEGIN
  SELECT RAISE(ABORT, 'refund_decision_is_final');
END;
