-- Store membership is the single source of truth for Console authority (D15): role/status are re-resolved from
-- this table on every request, never trusted from the session cookie.

CREATE TABLE store_memberships (
  id TEXT PRIMARY KEY NOT NULL,
  store_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'staff')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  revoked_at TEXT,
  CONSTRAINT store_memberships_store_fk FOREIGN KEY (store_id) REFERENCES stores(id),
  CONSTRAINT store_memberships_user_fk FOREIGN KEY (user_id) REFERENCES "user"("id"),
  CONSTRAINT store_memberships_id_store_unique UNIQUE (id, store_id),
  CONSTRAINT store_memberships_user_store_unique UNIQUE (user_id, store_id),
  CONSTRAINT store_memberships_status_time CHECK (
    (status = 'active' AND revoked_at IS NULL) OR (status = 'revoked' AND revoked_at IS NOT NULL)
  )
);

-- MVP is single-store (D4): one user has at most one active membership system-wide. Multi-tenant must drop this
-- index and pass storeId through resolveActiveMembership's WHERE instead of relying on global uniqueness.
CREATE UNIQUE INDEX store_memberships_one_active_user ON store_memberships (user_id) WHERE status = 'active';
CREATE INDEX store_memberships_store_role_status_idx ON store_memberships (store_id, role, status, user_id);
