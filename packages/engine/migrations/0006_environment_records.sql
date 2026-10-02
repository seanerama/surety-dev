-- Slice 6: the current observation of an environment (D1 §3.5, A.3
-- environment_records; D1-28). M1 builds no observation job and no
-- observation history (build spec §3); an environment's record holds the one
-- current observation. `observed` is JSON text: {condition, detail,
-- observed_at, source}. Freshness and expiry are computed at the read from
-- the project's observation_freshness_bound, never written by it.

CREATE TABLE environment_records (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  environment TEXT NOT NULL UNIQUE REFERENCES environments(id),
  last_verified TEXT,
  attempted TEXT,
  observed TEXT NOT NULL,
  frozen_at TEXT
);
