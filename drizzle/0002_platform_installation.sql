CREATE TABLE IF NOT EXISTS restore_control.platform_installation (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  host_id text NOT NULL CHECK (host_id ~ '^[a-f0-9]{64}$'),
  bootstrap_digest text NOT NULL CHECK (bootstrap_digest ~ '^[a-f0-9]{64}$'),
  authorization_nonce text NOT NULL CHECK (authorization_nonce ~ '^[a-f0-9]{64}$'),
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
  UNIQUE (host_id, bootstrap_digest, authorization_nonce)
);
