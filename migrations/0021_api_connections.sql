-- Sharing property details with external services (e.g. LeadVyne). Additive only.
--   direction 'push': we POST property details to the partner's endpoint `url`, sending their API `token`.
--   direction 'pull': the partner calls our /api/v1/properties with a key we issued; only its SHA-256 is stored.
CREATE TABLE IF NOT EXISTS api_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('push','pull')),
  url TEXT,
  token TEXT,
  auth_style TEXT NOT NULL DEFAULT 'bearer',   -- push: bearer (Authorization: Bearer …) | x-api-key
  token_hash TEXT,
  token_hint TEXT NOT NULL DEFAULT '',
  auto_sync INTEGER NOT NULL DEFAULT 0,        -- push: send all live properties every day (07:00 IST cron)
  active INTEGER NOT NULL DEFAULT 1,
  last_used_at TEXT,
  last_status TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_connections_token ON api_connections(token_hash);
