-- Witness schema for the harness self-check. NOT the engine's schema and not
-- a contract: the contract is the tests and SEAM.md. It exists to show that the
-- store cases in ../store-cases.mjs are satisfiable by some schema built from
-- D1 A.3 with build spec §6 correction 10, and to give the self-check a
-- schema it can break on purpose to show the cases detect each defect.

CREATE TABLE projects (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL, name TEXT NOT NULL,
  paused INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE work_items (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  seq INTEGER NOT NULL, kind TEXT NOT NULL, subject TEXT NOT NULL, status TEXT NOT NULL,
  blocker TEXT, depends_on TEXT, trigger_source TEXT NOT NULL, trigger_id TEXT NOT NULL,
  trigger_generation INTEGER NOT NULL, trigger_consumed_at TEXT,
  repair_attempts INTEGER NOT NULL, no_progress_count INTEGER NOT NULL, progress_key TEXT,
  preflight_refusals INTEGER NOT NULL, prior_status TEXT, dispatch_hold INTEGER NOT NULL,
  UNIQUE (project, seq),
  UNIQUE (project, trigger_source, trigger_id, trigger_generation)
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  seq INTEGER NOT NULL, work_item TEXT NOT NULL REFERENCES work_items(id),
  role TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('one_shot', 'session')),
  state TEXT NOT NULL, session_state TEXT, outcome TEXT, reason_class TEXT, reason_text TEXT,
  backend TEXT NOT NULL, backend_version TEXT NOT NULL, model_requested TEXT NOT NULL,
  model_observed TEXT, "grant" TEXT REFERENCES capability_grants(id),
  base_revision TEXT NOT NULL, deadline_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
  parent_run TEXT REFERENCES runs(id), provider_session_id TEXT,
  quarantined INTEGER NOT NULL,
  UNIQUE (project, seq)
);

CREATE TABLE capability_grants (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  run TEXT NOT NULL REFERENCES runs(id),
  capabilities TEXT NOT NULL, env_allowlist TEXT NOT NULL, secret_refs TEXT,
  issued_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT
);

CREATE TABLE turns (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  run TEXT NOT NULL REFERENCES runs(id), number INTEGER NOT NULL,
  invocation TEXT NOT NULL REFERENCES invocation_receipts(id),
  domain TEXT NOT NULL REFERENCES execution_domains(id),
  started_at TEXT NOT NULL, finished_at TEXT,
  UNIQUE (run, number)
);

CREATE TABLE invocation_receipts (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  run TEXT NOT NULL REFERENCES runs(id), turn TEXT REFERENCES turns(id),
  provider TEXT NOT NULL, model_requested TEXT NOT NULL,
  "grant" TEXT NOT NULL REFERENCES capability_grants(id), budget_snapshot TEXT NOT NULL
);
CREATE UNIQUE INDEX receipts_one_per_one_shot_run ON invocation_receipts(run) WHERE turn IS NULL;
CREATE UNIQUE INDEX receipts_one_per_turn ON invocation_receipts(turn) WHERE turn IS NOT NULL;
CREATE TRIGGER receipts_kind_matches_turn BEFORE INSERT ON invocation_receipts
BEGIN
  SELECT RAISE(ABORT, 'receipt turn nullability disagrees with run kind')
  WHERE (NEW.turn IS NULL) <> ((SELECT kind FROM runs WHERE id = NEW.run) = 'one_shot');
  SELECT RAISE(ABORT, 'receipt turn belongs to another run')
  WHERE NEW.turn IS NOT NULL AND COALESCE((SELECT run FROM turns WHERE id = NEW.turn), '') <> NEW.run;
END;

CREATE TABLE execution_domains (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  run TEXT NOT NULL REFERENCES runs(id),
  invocation TEXT NOT NULL REFERENCES invocation_receipts(id),
  status TEXT NOT NULL
);

CREATE TABLE invocation_status_observations (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  invocation TEXT NOT NULL REFERENCES invocation_receipts(id),
  seq INTEGER NOT NULL, status TEXT NOT NULL, at TEXT NOT NULL,
  UNIQUE (invocation, seq)
);

CREATE TABLE usage_observations (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  invocation TEXT NOT NULL REFERENCES invocation_receipts(id),
  seq INTEGER NOT NULL, semantics TEXT NOT NULL, raw TEXT NOT NULL, at TEXT NOT NULL,
  UNIQUE (invocation, seq)
);

CREATE TABLE ledger_rows (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  invocation TEXT NOT NULL REFERENCES invocation_receipts(id),
  run TEXT NOT NULL REFERENCES runs(id), turn TEXT REFERENCES turns(id),
  role TEXT NOT NULL, provider TEXT NOT NULL, model_requested TEXT NOT NULL, model_observed TEXT,
  raw_usage TEXT NOT NULL, normalization_version TEXT NOT NULL,
  billable_in INTEGER, cached_in INTEGER, out INTEGER,
  usage_complete INTEGER NOT NULL, cost_status TEXT NOT NULL, cost_usd REAL,
  day_utc TEXT NOT NULL, corrects TEXT REFERENCES ledger_rows(id), correction_seq INTEGER,
  UNIQUE (invocation, correction_seq)
);
CREATE UNIQUE INDEX ledger_one_original_per_invocation ON ledger_rows(invocation) WHERE corrects IS NULL;

CREATE TABLE operations (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  seq INTEGER NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL, subject TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE, semantic_generation INTEGER NOT NULL,
  deployment_generation INTEGER, status TEXT NOT NULL, remaining_scope TEXT,
  linked_prior TEXT REFERENCES operations(id), "authorization" TEXT,
  deadline_at TEXT NOT NULL, finalized_at TEXT,
  UNIQUE (project, seq)
);

CREATE TABLE git_journal_events (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  operation TEXT NOT NULL REFERENCES operations(id),
  seq INTEGER NOT NULL, journal_kind TEXT NOT NULL, event_kind TEXT NOT NULL, payload TEXT NOT NULL,
  UNIQUE (operation, seq)
);

CREATE TABLE events (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
  seq INTEGER NOT NULL UNIQUE, at TEXT NOT NULL, type TEXT NOT NULL, subject TEXT NOT NULL,
  actor_kind TEXT NOT NULL, actor_id TEXT, request_id TEXT, operation TEXT REFERENCES operations(id),
  payload TEXT NOT NULL, tx TEXT NOT NULL
);

-- Append-only at the database level (D1 §6.2, §17.10).
CREATE TRIGGER invocation_receipts_no_update BEFORE UPDATE ON invocation_receipts BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER invocation_receipts_no_delete BEFORE DELETE ON invocation_receipts BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER invocation_status_observations_no_update BEFORE UPDATE ON invocation_status_observations BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER invocation_status_observations_no_delete BEFORE DELETE ON invocation_status_observations BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER usage_observations_no_update BEFORE UPDATE ON usage_observations BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER usage_observations_no_delete BEFORE DELETE ON usage_observations BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER ledger_rows_no_update BEFORE UPDATE ON ledger_rows BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER ledger_rows_no_delete BEFORE DELETE ON ledger_rows BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER git_journal_events_no_update BEFORE UPDATE ON git_journal_events BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER git_journal_events_no_delete BEFORE DELETE ON git_journal_events BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'append-only'); END;
