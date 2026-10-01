-- Slice 1: the identity, invocation, ledger and journal tables rows M02-M04
-- write, and the event log (D1 A.3, build spec §6 correction 10, E22 item 5).
-- Columns that reference a table no slice has created yet (workspaces,
-- records, policy_revisions, deployment_authorizations) are added by the slice
-- that creates that table.
--
-- Conventions: ids are TEXT with the A.1 prefix; timestamps are ISO-8601 UTC
-- text; booleans are 0/1; JSON-typed fields are JSON text.

CREATE TABLE engine_incarnations (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  pid INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  host_boot_id TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  name TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('T1', 'T2', 'T3')),
  dev_repo_path TEXT NOT NULL,
  integration_branch TEXT NOT NULL,
  delivery_repo TEXT,
  baseline_state TEXT NOT NULL CHECK (baseline_state IN ('idea', 'spec_ready', 'retired')),
  prior_baseline_state TEXT CHECK (prior_baseline_state IN ('idea', 'spec_ready', 'retired')),
  registration_state TEXT NOT NULL CHECK (registration_state IN ('pending_bootstrap', 'registered')),
  adoption TEXT,
  management TEXT NOT NULL,
  paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  seq_counters TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE work_items (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'stage_build', 'fix', 'verification', 'review', 'phase_verification', 'replan', 'assessment',
    'spec_change', 'check_correction', 'triage_accept', 'export', 'publish', 'deploy', 'rollback',
    'adoption_baseline', 'conformance')),
  subject TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'eligible', 'claimed', 'executing', 'integrating', 'integrated', 'verifying', 'complete',
    'awaiting_decision', 'held', 'parked', 'cancelled')),
  blocker TEXT,
  depends_on TEXT,
  trigger_source TEXT NOT NULL,
  trigger_id TEXT NOT NULL,
  trigger_generation INTEGER NOT NULL,
  trigger_consumed_at TEXT,
  repair_attempts INTEGER NOT NULL,
  no_progress_count INTEGER NOT NULL,
  progress_key TEXT,
  preflight_refusals INTEGER NOT NULL,
  prior_status TEXT CHECK (prior_status IN (
    'eligible', 'claimed', 'executing', 'integrating', 'integrated', 'verifying', 'complete',
    'awaiting_decision', 'held', 'parked', 'cancelled')),
  dispatch_hold INTEGER NOT NULL CHECK (dispatch_hold IN (0, 1)),
  UNIQUE (project, seq),
  UNIQUE (project, trigger_source, trigger_id, trigger_generation)
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  seq INTEGER NOT NULL,
  work_item TEXT NOT NULL REFERENCES work_items(id),
  role TEXT NOT NULL CHECK (role IN (
    'vision', 'spec_writer', 'architect', 'builder', 'verifier', 'reviewer', 'release_operator', 'mechanic')),
  kind TEXT NOT NULL CHECK (kind IN ('one_shot', 'session')),
  state TEXT NOT NULL CHECK (state IN (
    'created', 'claimed', 'executing', 'validating', 'proposal_captured', 'finalizing', 'ended')),
  session_state TEXT CHECK (session_state IN ('allocated', 'open_idle', 'turn_running', 'saving', 'closing')),
  outcome TEXT CHECK (outcome IN (
    'completed', 'failed', 'refused', 'timed_out', 'stopped', 'abandoned', 'recovered')),
  reason_class TEXT CHECK (reason_class IN (
    'diff_violation', 'ref_violation', 'invalid_result', 'infra_error', 'preflight_refused', 'deadline',
    'integration_conflict', 'budget', 'human_stop', 'human_abandon', 'recovered', 'none')),
  reason_text TEXT,
  backend TEXT NOT NULL,
  backend_version TEXT NOT NULL,
  model_requested TEXT NOT NULL,
  model_observed TEXT,
  "grant" TEXT REFERENCES capability_grants(id),
  base_revision TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  parent_run TEXT REFERENCES runs(id),
  provider_session_id TEXT,
  quarantined INTEGER NOT NULL CHECK (quarantined IN (0, 1)),
  UNIQUE (project, seq)
);

CREATE TABLE capability_grants (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  run TEXT NOT NULL REFERENCES runs(id),
  capabilities TEXT NOT NULL,
  env_allowlist TEXT NOT NULL,
  secret_refs TEXT,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

-- turns, invocation_receipts and execution_domains reference each other; a
-- writer inserts them in one transaction with foreign keys deferred.
CREATE TABLE turns (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  run TEXT NOT NULL REFERENCES runs(id),
  number INTEGER NOT NULL,
  invocation TEXT NOT NULL REFERENCES invocation_receipts(id),
  domain TEXT NOT NULL REFERENCES execution_domains(id),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE (run, number)
);

CREATE TABLE invocation_receipts (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  run TEXT NOT NULL REFERENCES runs(id),
  turn TEXT REFERENCES turns(id),
  provider TEXT NOT NULL,
  model_requested TEXT NOT NULL,
  "grant" TEXT NOT NULL REFERENCES capability_grants(id),
  budget_snapshot TEXT NOT NULL
);

-- Build spec §6 correction 10: SQLite treats NULLs as distinct, so a plain
-- UNIQUE(run, turn) would admit duplicate one-shot receipts.
CREATE UNIQUE INDEX invocation_receipts_one_per_one_shot_run ON invocation_receipts(run) WHERE turn IS NULL;
CREATE UNIQUE INDEX invocation_receipts_one_per_turn ON invocation_receipts(turn) WHERE turn IS NOT NULL;

-- A receipt's turn belongs to the receipt's run, and turn nullability agrees
-- with the run's kind (one_shot <=> no turn).
CREATE TRIGGER invocation_receipts_turn_matches_run BEFORE INSERT ON invocation_receipts
BEGIN
  SELECT RAISE(ABORT, 'invocation_receipts: turn nullability disagrees with the run kind')
  WHERE (NEW.turn IS NULL) IS NOT (COALESCE((SELECT kind FROM runs WHERE id = NEW.run), '') = 'one_shot');
  SELECT RAISE(ABORT, 'invocation_receipts: the turn belongs to another run')
  WHERE NEW.turn IS NOT NULL AND COALESCE((SELECT run FROM turns WHERE id = NEW.turn), '') <> NEW.run;
END;

CREATE TABLE execution_domains (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  run TEXT NOT NULL REFERENCES runs(id),
  invocation TEXT NOT NULL REFERENCES invocation_receipts(id),
  status TEXT NOT NULL CHECK (status IN ('allocated', 'launched', 'terminated', 'quarantined'))
);

CREATE TABLE invocation_status_observations (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  invocation TEXT NOT NULL REFERENCES invocation_receipts(id),
  seq INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('dispatch_started', 'refused', 'launched', 'ended', 'unknown')),
  at TEXT NOT NULL,
  UNIQUE (invocation, seq)
);

CREATE TABLE usage_observations (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  invocation TEXT NOT NULL REFERENCES invocation_receipts(id),
  seq INTEGER NOT NULL,
  semantics TEXT NOT NULL CHECK (semantics IN ('cumulative', 'delta')),
  raw TEXT NOT NULL,
  at TEXT NOT NULL,
  UNIQUE (invocation, seq)
);

CREATE TABLE ledger_rows (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  invocation TEXT NOT NULL REFERENCES invocation_receipts(id),
  run TEXT NOT NULL REFERENCES runs(id),
  turn TEXT REFERENCES turns(id),
  role TEXT NOT NULL CHECK (role IN (
    'vision', 'spec_writer', 'architect', 'builder', 'verifier', 'reviewer', 'release_operator', 'mechanic')),
  provider TEXT NOT NULL,
  model_requested TEXT NOT NULL,
  model_observed TEXT,
  raw_usage TEXT NOT NULL,
  normalization_version TEXT NOT NULL,
  billable_in INTEGER,
  cached_in INTEGER,
  out INTEGER,
  usage_complete INTEGER NOT NULL CHECK (usage_complete IN (0, 1)),
  cost_status TEXT NOT NULL CHECK (cost_status IN ('reported', 'estimated', 'unknown', 'measured_zero')),
  cost_usd REAL,
  day_utc TEXT NOT NULL,
  corrects TEXT REFERENCES ledger_rows(id),
  correction_seq INTEGER,
  UNIQUE (invocation, correction_seq)
);

-- D1 §6.2: one original (uncorrected) charge per invocation.
CREATE UNIQUE INDEX ledger_rows_one_original_per_invocation ON ledger_rows(invocation) WHERE corrects IS NULL;

CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'git_ref_update', 'git_commit', 'git_worktree', 'publish', 'deploy', 'rollback', 'teardown',
    'issue_file', 'issue_update', 'notify')),
  target TEXT NOT NULL,
  subject TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  semantic_generation INTEGER NOT NULL,
  deployment_generation INTEGER,
  status TEXT NOT NULL CHECK (status IN (
    'intended', 'in_progress', 'succeeded', 'failed', 'partial', 'ambiguous', 'superseded')),
  remaining_scope TEXT,
  linked_prior TEXT REFERENCES operations(id),
  deadline_at TEXT NOT NULL,
  finalized_at TEXT,
  UNIQUE (project, seq)
);

CREATE TABLE git_journal_events (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  operation TEXT NOT NULL REFERENCES operations(id),
  seq INTEGER NOT NULL,
  journal_kind TEXT NOT NULL CHECK (journal_kind IN ('ref_update', 'commit_tree', 'worktree_add', 'worktree_remove')),
  event_kind TEXT NOT NULL CHECK (event_kind IN ('intended', 'applied', 'confirmed', 'failed', 'ambiguous', 'finalized')),
  payload TEXT NOT NULL,
  UNIQUE (operation, seq)
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  seq INTEGER NOT NULL UNIQUE,
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  subject TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('engine', 'human', 'run')),
  actor_id TEXT,
  request_id TEXT,
  operation TEXT REFERENCES operations(id),
  payload TEXT NOT NULL,
  tx TEXT NOT NULL
);

-- Append-only history (D1 §6.2, §17(10)). RAISE(ABORT) reports
-- SQLITE_CONSTRAINT_TRIGGER; a silently ignored write would hide the attempt.
CREATE TRIGGER invocation_receipts_no_update BEFORE UPDATE ON invocation_receipts
BEGIN SELECT RAISE(ABORT, 'invocation_receipts is append-only'); END;
CREATE TRIGGER invocation_receipts_no_delete BEFORE DELETE ON invocation_receipts
BEGIN SELECT RAISE(ABORT, 'invocation_receipts is append-only'); END;
CREATE TRIGGER invocation_status_observations_no_update BEFORE UPDATE ON invocation_status_observations
BEGIN SELECT RAISE(ABORT, 'invocation_status_observations is append-only'); END;
CREATE TRIGGER invocation_status_observations_no_delete BEFORE DELETE ON invocation_status_observations
BEGIN SELECT RAISE(ABORT, 'invocation_status_observations is append-only'); END;
CREATE TRIGGER usage_observations_no_update BEFORE UPDATE ON usage_observations
BEGIN SELECT RAISE(ABORT, 'usage_observations is append-only'); END;
CREATE TRIGGER usage_observations_no_delete BEFORE DELETE ON usage_observations
BEGIN SELECT RAISE(ABORT, 'usage_observations is append-only'); END;
CREATE TRIGGER ledger_rows_no_update BEFORE UPDATE ON ledger_rows
BEGIN SELECT RAISE(ABORT, 'ledger_rows is append-only'); END;
CREATE TRIGGER ledger_rows_no_delete BEFORE DELETE ON ledger_rows
BEGIN SELECT RAISE(ABORT, 'ledger_rows is append-only'); END;
CREATE TRIGGER git_journal_events_no_update BEFORE UPDATE ON git_journal_events
BEGIN SELECT RAISE(ABORT, 'git_journal_events is append-only'); END;
CREATE TRIGGER git_journal_events_no_delete BEFORE DELETE ON git_journal_events
BEGIN SELECT RAISE(ABORT, 'git_journal_events is append-only'); END;
CREATE TRIGGER events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
