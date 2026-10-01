-- Witness schema, slice-2 part. Like witness-schema.sql it is NOT the
-- engine's schema and not a contract. It adds the D1 A.3 tables the slice-2
-- store assertions read (../invariants.mjs), so the self-check can run each
-- assertion against a store that satisfies it and against mutants that do not.

ALTER TABLE runs ADD COLUMN workspace TEXT;

CREATE TABLE process_ownership (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  domain TEXT NOT NULL REFERENCES execution_domains(id),
  invocation TEXT NOT NULL REFERENCES invocation_receipts(id),
  incarnation TEXT NOT NULL,
  pgid INTEGER, pid INTEGER, pid_start_time TEXT, containment_id TEXT,
  descendants TEXT, termination_confirmed_at TEXT
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  run TEXT NOT NULL REFERENCES runs(id),
  path TEXT NOT NULL, base_revision TEXT NOT NULL, current_base TEXT NOT NULL,
  disposition TEXT NOT NULL, checkpoints TEXT, snapshot_tree TEXT, disposed_at TEXT
);

CREATE TABLE leases (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
  resource_kind TEXT NOT NULL, resource_id TEXT NOT NULL,
  owner_incarnation TEXT NOT NULL, generation INTEGER NOT NULL,
  acquired_at TEXT NOT NULL, renewed_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  released_at TEXT, closing INTEGER NOT NULL, cleanup_authority INTEGER NOT NULL
);
CREATE UNIQUE INDEX leases_one_holder ON leases(resource_kind, resource_id) WHERE released_at IS NULL;

CREATE TABLE decisions (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  seq INTEGER NOT NULL, kind TEXT NOT NULL, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL,
  semantic_generation INTEGER NOT NULL, scope TEXT NOT NULL, question TEXT NOT NULL,
  options TEXT NOT NULL, dependency_manifest TEXT NOT NULL, transition_schema_version INTEGER NOT NULL,
  preview_hash TEXT NOT NULL, evidence TEXT NOT NULL, blocked_while_open TEXT NOT NULL,
  raised_at TEXT NOT NULL, target_seconds INTEGER, escalated_at TEXT, batch_key TEXT,
  status TEXT NOT NULL, answer TEXT, consumed_at TEXT, invalidated_reason TEXT
);
