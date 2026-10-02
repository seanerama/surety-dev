-- Slice 3: git performed by the engine and its journal (D1 A.3, §§2.5, 3.1,
-- 3.3, 3.5, 7; build spec §6 corrections 6, 14, 15, 16). The journal's state
-- projection and the attempts of every operation; the ref registry and the
-- managed checkouts; revisions, lineages and candidates; out-of-band
-- observations; policy revisions; and the columns the snapshot, validation,
-- integration and the chain of roles need on tables of earlier slices.

-- D1 §2.5, A.3; correction 16. One row per execution of an operation's
-- effect; (operation, attempt_number) is unique (D1 §6.2). `incarnation` is
-- engine-owned: the incarnation that issued the attempt, which is how a later
-- incarnation knows an attempt in flight was not its own.
CREATE TABLE operation_attempts (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  operation TEXT NOT NULL REFERENCES operations(id),
  attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
  status TEXT NOT NULL CHECK (status IN (
    'started', 'succeeded', 'failed', 'ambiguous', 'reconciled_succeeded', 'reconciled_absent', 'reconciled_partial')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  timeline TEXT NOT NULL DEFAULT '[]',
  reconciliation_reads TEXT NOT NULL DEFAULT '[]',
  incarnation TEXT,
  UNIQUE (operation, attempt_number)
);

-- D1 §3.5: the journal's state, a projection moved only in the transaction
-- that appends a journal event.
CREATE TABLE git_journal_state (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  operation TEXT NOT NULL UNIQUE REFERENCES operations(id),
  journal_kind TEXT NOT NULL CHECK (journal_kind IN ('ref_update', 'commit_tree', 'worktree_add', 'worktree_remove')),
  state TEXT NOT NULL CHECK (state IN ('intended', 'applied', 'confirmed', 'failed', 'ambiguous', 'finalized')),
  last_event_seq INTEGER NOT NULL
);

-- What an operation's finalizer will write, fixed when the intent is
-- committed and never changed (correction 14). Engine-owned.
ALTER TABLE operations ADD COLUMN finalizer_inputs TEXT NOT NULL DEFAULT '{}';
-- Why an operation failed, when it was refused before its effect. Engine-owned.
ALTER TABLE operations ADD COLUMN outcome_detail TEXT;

CREATE TRIGGER operations_finalizer_inputs_frozen BEFORE UPDATE OF finalizer_inputs ON operations
WHEN NEW.finalizer_inputs IS NOT OLD.finalizer_inputs
BEGIN SELECT RAISE(ABORT, 'operations.finalizer_inputs is fixed with the intent'); END;

CREATE INDEX operations_unfinished ON operations(project, finalized_at);

-- D1 §7.2. One row per registered ref of a project; `ref` is the full name.
CREATE TABLE ref_registry (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  ref TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('integration', 'lineage', 'nomination', 'recovery', 'oob', 'keep')),
  expected_oid TEXT NOT NULL,
  immutable INTEGER NOT NULL CHECK (immutable IN (0, 1)),
  UNIQUE (project, ref)
);

-- D1 §7.2, §7.6. `released_at` (engine-owned): the checkout is no longer
-- managed (the developer switched it away from the integration branch, or the
-- run workspace was discarded).
CREATE TABLE managed_checkouts (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL CHECK (kind IN ('integration_worktree', 'run_workspace')),
  path TEXT NOT NULL,
  baseline TEXT NOT NULL,
  owner_run TEXT REFERENCES runs(id),
  released_at TEXT
);

CREATE TABLE lineages (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  branch TEXT NOT NULL,
  started_from_candidate TEXT REFERENCES candidates(id),
  open INTEGER NOT NULL CHECK (open IN (0, 1))
);
CREATE UNIQUE INDEX lineages_one_open ON lineages(project, branch) WHERE open = 1;

CREATE TABLE revisions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  sha TEXT NOT NULL,
  lineage TEXT NOT NULL REFERENCES lineages(id),
  parent_sha TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('working', 'checkpoint', 'engine_commit', 'nominated', 'out_of_band', 'protected', 'intent')),
  created_by_run TEXT REFERENCES runs(id),
  recorded_at TEXT NOT NULL
);
CREATE INDEX revisions_by_run ON revisions(created_by_run);

-- D1 §3.3. The baseline bindings A.3 marks required belong to tables later
-- slices create; until then they are nullable. `held_work` (engine-owned):
-- the Builder's work items its nomination moved to `verifying`.
CREATE TABLE candidates (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  seq INTEGER NOT NULL,
  revision TEXT NOT NULL,
  lineage TEXT NOT NULL REFERENCES lineages(id),
  nominated_at TEXT NOT NULL,
  nominated_by TEXT NOT NULL CHECK (nominated_by IN ('engine_cadence', 'builder_request')),
  spec_revision TEXT,
  architecture_revision TEXT,
  nominated_protected_version TEXT,
  progress TEXT NOT NULL CHECK (progress IN ('developing', 'alpha_deployed', 'beta_deployed', 'live')),
  superseded_by TEXT REFERENCES candidates(id),
  held_work TEXT NOT NULL DEFAULT '[]',
  UNIQUE (project, seq)
);

-- D1 §7.6. `closed_at` (engine-owned): an observation of a repository that
-- can be read again is closed without a disposition.
CREATE TABLE out_of_band_changes (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('ref', 'checkout', 'repository')),
  ref TEXT REFERENCES ref_registry(id),
  checkout TEXT REFERENCES managed_checkouts(id),
  expected TEXT NOT NULL,
  found TEXT,
  detected_at TEXT NOT NULL,
  disposition TEXT CHECK (disposition IN ('discard', 'adopt', 'stash')),
  decision TEXT NOT NULL REFERENCES decisions(id),
  closed_at TEXT
);

CREATE TABLE policy_revisions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  revision INTEGER NOT NULL,
  git_path TEXT NOT NULL,
  git_blob TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  diff_summary TEXT NOT NULL,
  widens_authority INTEGER NOT NULL CHECK (widens_authority IN (0, 1)),
  committed INTEGER NOT NULL CHECK (committed IN (0, 1)),
  decision TEXT REFERENCES decisions(id),
  -- Engine-owned: the effective policy this revision records.
  effective TEXT NOT NULL,
  UNIQUE (project, revision)
);

ALTER TABLE projects ADD COLUMN policy_revision TEXT REFERENCES policy_revisions(id);
-- Engine-owned: a nomination the integration finalizer found due and that
-- has not been journaled yet ({"revision", "by", "chain"}).
ALTER TABLE projects ADD COLUMN nomination_due TEXT;

-- Engine-owned columns of runs: the role's structured result as the engine
-- accepted it (the summary and flags a commit message and the cadence use),
-- what a failed end needs for its consequence (the blocker's cause), and the
-- number of roles of the chain this run belongs to (D1-34; E24 item 1).
ALTER TABLE runs ADD COLUMN result TEXT;
ALTER TABLE runs ADD COLUMN reason_detail TEXT;
ALTER TABLE runs ADD COLUMN chain INTEGER NOT NULL DEFAULT 1;

-- Engine-owned columns of work items: the number of roles of the chain whose
-- outcome created the item (0: a person or a fixture), and the checkpoint a
-- continuation starts from.
ALTER TABLE work_items ADD COLUMN chain INTEGER NOT NULL DEFAULT 0;
ALTER TABLE work_items ADD COLUMN continue_from TEXT;

-- Engine-owned: what lies outside a run workspace's diff, as the engine left
-- it before the role was launched (correction 15): the worktree's metadata
-- directory, its HEAD and index, its .git file, the repository's
-- configuration and hooks.
ALTER TABLE workspaces ADD COLUMN metadata_baseline TEXT;
