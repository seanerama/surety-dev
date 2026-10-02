-- Witness tables for the slice-3 rows (SEAM.md §35). Like witness-schema.sql
-- this is the Verifier's stand-in, not the engine's schema: it has the tables
-- and columns the slice-3 tests read, with D1 A.3's names, and nothing else.
CREATE TABLE revisions (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  sha TEXT NOT NULL, lineage TEXT, parent_sha TEXT, kind TEXT NOT NULL,
  created_by_run TEXT REFERENCES runs(id), recorded_at TEXT NOT NULL
);
CREATE TABLE ref_registry (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  ref TEXT NOT NULL, kind TEXT NOT NULL, expected_oid TEXT NOT NULL, immutable INTEGER NOT NULL,
  UNIQUE (project, ref)
);
CREATE TABLE managed_checkouts (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL, path TEXT NOT NULL, baseline TEXT NOT NULL, owner_run TEXT REFERENCES runs(id)
);
CREATE TABLE out_of_band_changes (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  subject_kind TEXT NOT NULL, ref TEXT REFERENCES ref_registry(id), checkout TEXT,
  expected TEXT NOT NULL, found TEXT, detected_at TEXT NOT NULL, disposition TEXT,
  decision TEXT NOT NULL REFERENCES decisions(id)
);
CREATE TABLE policy_revisions (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  revision INTEGER NOT NULL, git_path TEXT NOT NULL, git_blob TEXT NOT NULL,
  changed_by TEXT NOT NULL, changed_at TEXT NOT NULL, diff_summary TEXT NOT NULL,
  widens_authority INTEGER NOT NULL, committed INTEGER NOT NULL, decision TEXT,
  UNIQUE (project, revision)
);
ALTER TABLE projects ADD COLUMN registration_state TEXT;
ALTER TABLE projects ADD COLUMN policy_revision TEXT;
ALTER TABLE projects ADD COLUMN policy TEXT;
ALTER TABLE work_items ADD COLUMN checkpoint_run TEXT;
