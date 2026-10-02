-- Witness tables for the second slice-3 session's rows (SEAM.md §49). Like the
-- other witness schema files this is the Verifier's stand-in, not the engine's
-- schema: the tables and columns rows M26 to M34 read, with D1 A.3's names,
-- and a few columns of the witness's own (marked) that no test reads.
CREATE TABLE operation_attempts (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  operation TEXT NOT NULL REFERENCES operations(id),
  attempt_number INTEGER NOT NULL, status TEXT NOT NULL,
  started_at TEXT NOT NULL, finished_at TEXT,
  timeline TEXT NOT NULL, reconciliation_reads TEXT,
  UNIQUE (operation, attempt_number)
);
CREATE TABLE git_journal_state (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  operation TEXT NOT NULL UNIQUE REFERENCES operations(id),
  journal_kind TEXT NOT NULL, state TEXT NOT NULL, last_event_seq INTEGER NOT NULL
);
CREATE TABLE lineages (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  branch TEXT NOT NULL, started_from_candidate TEXT, open INTEGER NOT NULL
);
CREATE UNIQUE INDEX lineages_one_open ON lineages(project, branch) WHERE open = 1;
CREATE TABLE candidates (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  seq INTEGER NOT NULL, revision TEXT NOT NULL, lineage TEXT NOT NULL REFERENCES lineages(id),
  nominated_at TEXT NOT NULL, nominated_by TEXT NOT NULL,
  spec_revision TEXT, architecture_revision TEXT, nominated_protected_version TEXT,
  progress TEXT NOT NULL, superseded_by TEXT,
  UNIQUE (project, seq)
);
CREATE TABLE phase_plans (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  roadmap_revision TEXT, phase_number INTEGER NOT NULL,
  prepared_against_spec TEXT, prepared_against_revision TEXT,
  git_path TEXT NOT NULL, approved_by TEXT, approved_at TEXT
);
-- The witness's own, read by no test: what it froze with an intent, who
-- created a work item, which candidate an item waits for, whether a person
-- stepped in at a chain boundary, and how long a run's chain of roles is.
ALTER TABLE operations ADD COLUMN witness_plan TEXT;
ALTER TABLE work_items ADD COLUMN created_by_run TEXT;
ALTER TABLE work_items ADD COLUMN verifying_candidate TEXT;
ALTER TABLE work_items ADD COLUMN human_step INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN chain INTEGER NOT NULL DEFAULT 1;
